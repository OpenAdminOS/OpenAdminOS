import { createHash } from "node:crypto";

import type { AgentModule, AgentSummary, AgentTemplate, TemplateStep } from "@openadminos/agent-sdk";
import { agentTemplateToModule, agentTemplateToRegistrySummary, findRegistryAgentById, getAgentUpdatesDir, loadAgentManifestPreview, parseAgentTemplate, toInstalledAgent } from "@openadminos/runtime";

import type { SandboxAgentConfig } from "./config.js";
import { SandboxRefusal } from "./refusal.js";

export interface SandboxAgent {
  agent: AgentSummary;
  manifest: AgentTemplate;
  /** Built from the exact text that was hashed; the run never reads the file again. */
  module: AgentModule;
  sha256: string;
}

/** SHA-256 hex of a manifest's bytes, the value `templateSha256` pins. */
export function manifestSha256(sourceText: string): string {
  return createHash("sha256").update(sourceText, "utf8").digest("hex");
}

/**
 * Finds a bundled first-party agent and checks it before any request.
 * The registry summary only locates the manifest; the scopes, mode,
 * execution and connectors the host relies on come from the hashed
 * manifest text itself, parsed on every run:
 * the manifest must match the pinned hash, run as a read agent, use the
 * template interpreter, and contain only Graph GET, transform and model
 * steps. Script agents need the MXC sandbox, which a sandbox host does
 * not run.
 */
export function resolveSandboxAgent(config: SandboxAgentConfig): SandboxAgent {
  if (getAgentUpdatesDir() !== undefined) {
    throw new SandboxRefusal("agent-not-bundled", `${config.id} would load from an agent update folder. A sandbox runs only the agents bundled with this release.`);
  }
  const summary = findRegistryAgentById(config.id);
  if (!summary) {
    throw new SandboxRefusal("agent-not-found", `No bundled agent is named ${config.id}. Check agents[].id in the sandbox config against the agents folder of this release.`);
  }
  if (summary.registryPath && /^([/\\]|[A-Za-z]:[/\\])/.test(summary.registryPath)) {
    throw new SandboxRefusal("agent-not-bundled", `${config.id} is not a bundled agent. A sandbox runs only the agents bundled with this release.`);
  }
  const preview = loadAgentManifestPreview(summary);
  if (!preview) {
    throw new SandboxRefusal("agent-not-found", `${config.id} has no manifest.yaml in the agents folder.`);
  }
  const sha256 = manifestSha256(preview.sourceText);
  if (sha256 !== config.templateSha256) {
    throw new SandboxRefusal(
      "agent-hash-mismatch",
      `The manifest of ${config.id} changed since it was pinned. Pinned SHA-256 ${config.templateSha256}, found ${sha256}. Review the new manifest, then set templateSha256 to the new value.`,
    );
  }
  const manifest = parseAgentTemplate(preview.sourceText);
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
  const agent = toInstalledAgent({ ...fromManifest, ...(summary.registryPath ? { registryPath: summary.registryPath } : {}) }, new Date(0));
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
