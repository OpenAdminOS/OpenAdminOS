import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentModule, AgentSummary, AgentTemplate, TemplateStep } from "@openadminos/agent-sdk";
import { agentTemplateToModule, agentTemplateToRegistrySummary, getAgentUpdatesDir, parseAgentTemplate, setBuiltInAgentsRoot, toInstalledAgent } from "@openadminos/runtime";

import type { SandboxAgentConfig } from "./config.js";
import { describe } from "./files.js";
import { SandboxRefusal } from "./refusal.js";

export interface SandboxAgent {
  agent: AgentSummary;
  manifest: AgentTemplate;
  /** Built from the exact text that was hashed; the run never reads the file again. */
  module: AgentModule;
  sha256: string;
}

/** SHA-256 hex of a manifest's bytes, the value `templateSha256` pins. */
export function manifestSha256(source: string | Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

/**
 * The `agents` folder of the release checkout this host runs from, found
 * from the host package's own location, never from the current directory.
 */
export function releaseAgentsRoot(start: string = dirname(fileURLToPath(import.meta.url))): string {
  for (let current = resolve(start); ; current = dirname(current)) {
    const candidate = join(current, "agents");
    if (existsSync(join(current, "packages", "sandbox-host")) && existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (dirname(current) === current) break;
  }
  throw new SandboxRefusal("agent-not-found", "The agents folder of this release was not found next to the sandbox host. Run the host from a release checkout.");
}

let agentsRoot: string | undefined;

/** Fixes the runtime's bundled agents folder to this release's, once per process. */
export function useReleaseAgents(): string {
  agentsRoot ??= releaseAgentsRoot();
  setBuiltInAgentsRoot(agentsRoot);
  return agentsRoot;
}

const AGENT_FOLDER = /^[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * Finds a bundled first-party agent and checks it before any request.
 * The raw manifest file is hashed before it is parsed, so a changed
 * manifest is reported as changed even when it no longer parses. The
 * scopes, mode, execution and connectors the host relies on come from
 * that hashed text, parsed on every run: the manifest must match the
 * pinned hash, be a verified first-party read agent, use the template
 * interpreter, and contain only Graph GET, transform and model steps.
 * Script agents need the MXC sandbox, which a sandbox host does not run.
 */
export function resolveSandboxAgent(config: SandboxAgentConfig, options: { agentsRoot?: string } = {}): SandboxAgent {
  if (getAgentUpdatesDir() !== undefined) {
    throw new SandboxRefusal("agent-not-bundled", `${config.id} would load from an agent update folder. A sandbox runs only the agents bundled with this release.`);
  }
  if (!AGENT_FOLDER.test(config.id)) {
    throw new SandboxRefusal("agent-not-found", `No bundled agent is named ${config.id}.`);
  }
  const manifestPath = join(options.agentsRoot ?? useReleaseAgents(), config.id, "manifest.yaml");
  if (!existsSync(manifestPath)) {
    throw new SandboxRefusal("agent-not-found", `No bundled agent is named ${config.id}. Check agents[].id in the sandbox config against the agents folder of this release.`);
  }
  const bytes = readFileSync(manifestPath);
  const sha256 = manifestSha256(bytes);
  if (sha256 !== config.templateSha256) {
    throw new SandboxRefusal(
      "agent-hash-mismatch",
      `The manifest of ${config.id} changed since it was pinned. Pinned SHA-256 ${config.templateSha256}, found ${sha256}. Review the new manifest, then set templateSha256 to the new value.`,
    );
  }
  const sourceText = bytes.toString("utf8");
  let parsed: AgentTemplate;
  try {
    parsed = parseAgentTemplate(sourceText);
  } catch (error) {
    throw new SandboxRefusal("agent-manifest-invalid", `The pinned manifest of ${config.id} is not a valid agent: ${describe(error)}`, { cause: error });
  }
  if (parsed.descriptor.id !== config.id) {
    throw new SandboxRefusal("agent-manifest-invalid", `The manifest in agents/${config.id} declares the agent ${parsed.descriptor.id}. A sandbox runs an agent from the folder of the same name.`);
  }
  const manifest = parsed;
  const fromManifest = agentTemplateToRegistrySummary(manifest);
  const name = manifest.descriptor.name;
  if (manifest.descriptor.author?.verified !== true) {
    throw new SandboxRefusal("agent-not-bundled", `${config.id} is not a first-party agent. A sandbox runs only verified OpenAdminOS agents in this release.`);
  }
  if (manifest.descriptor.mode !== "read") {
    throw new SandboxRefusal("agent-not-read", `${name} is a write agent. A sandbox runs only read agents; changes are confirmed and applied on the desktop.`);
  }
  if (manifest.execution?.kind === "script") {
    throw new SandboxRefusal("agent-not-template", `${name} is a script agent. Script agents run only in the MXC sandbox on the desktop.`);
  }
  if ((manifest.descriptor.connectors?.length ?? 0) > 0 || (fromManifest.connectors?.length ?? 0) > 0) {
    throw new SandboxRefusal("agent-uses-connectors", `${name} uses connectors. A sandbox runs agents that read Microsoft Graph only.`);
  }
  assertSteps(name, manifest.skills);
  const agent = toInstalledAgent({ ...fromManifest, registryPath: `agents/${config.id}` }, new Date(0));
  return { agent, manifest, module: agentTemplateToModule(manifest), sha256 };
}

/** Refuses any step a sandbox does not run; exported for tests. */
export function assertSteps(name: string, steps: readonly TemplateStep[]): void {
  for (const step of steps) {
    switch (step.format) {
      case "transform":
      case "llm":
        break;
      case "map":
        assertSteps(name, step.settings.do);
        break;
      case "graph": {
        if (step.settings.method !== "GET") {
          throw refusedStep(name, step.id, `sends ${step.settings.method}`);
        }
        const path = step.settings.path.trim();
        if (/\$batch/i.test(path)) throw refusedStep(name, step.id, "uses $batch");
        if (/^\/me(?:[/?(]|$)/i.test(path)) throw refusedStep(name, step.id, "reads /me, which an app-only identity has no user for");
        if (!/^\/[A-Za-z][A-Za-z0-9_.-]*(?:[/?(]|$)/.test(path)) throw refusedStep(name, step.id, "does not start its path with a literal segment such as /users");
        break;
      }
      case "write":
        throw refusedStep(name, step.id, "is a write step");
      case "connector":
        throw refusedStep(name, step.id, "is a connector step");
      default:
        throw refusedStep(name, (step as { id?: string }).id ?? "(unnamed)", "has a step type the sandbox does not run");
    }
  }
}

function refusedStep(name: string, stepId: string, problem: string): SandboxRefusal {
  return new SandboxRefusal("agent-step-not-allowed", `${name} step ${stepId} ${problem}. A sandbox runs only Graph GET, transform and model steps.`);
}
