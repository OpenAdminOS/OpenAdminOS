import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AgentRunResult,
  AgentTemplate,
  ReadAgentModule,
  RunContext,
  SandboxBrokerRequest,
  SandboxBrokerResponse,
} from "@openadminos/agent-sdk";

import { agentTemplateToRegistrySummary } from "./agent-template.js";
import {
  createMxcSandboxRunner,
  type SandboxBrokerEndpoint,
  type MxcContainment,
  type SandboxRunResult,
  type SandboxRunner,
} from "./sandbox.js";
import { createSandboxBroker } from "./sandbox-broker.js";

const SCRIPT_RESULT_FILE = "result.json";
const BROKER_DIR_ENV = "OPENADMINOS_BROKER_DIR";
const BROKER_REQUEST_SUFFIX = ".request.json";
const BROKER_RESPONSE_SUFFIX = ".response.json";
const BROKER_POLL_MS = 10;

export interface ScriptAgentModuleOptions {
  sandboxRunner?: SandboxRunner;
  tempRoot?: string;
  nodePath?: string;
}

export function scriptAgentTemplateToModule(
  manifest: AgentTemplate,
  agentDir: string,
  options: ScriptAgentModuleOptions = {},
): ReadAgentModule {
  if (manifest.execution?.kind !== "script") {
    throw new Error(
      `Agent "${manifest.descriptor.id}" does not declare script execution.`,
    );
  }
  if (manifest.execution.sandbox !== "mxc") {
    throw new Error(
      `Agent "${manifest.descriptor.id}" declares unsupported script sandbox "${manifest.execution.sandbox}".`,
    );
  }
  if (manifest.descriptor.mode !== "read") {
    throw new Error(
      `Script execution currently supports read agents only. Agent "${manifest.descriptor.id}" is ${manifest.descriptor.mode}.`,
    );
  }

  const summary = agentTemplateToRegistrySummary(manifest);
  return {
    id: summary.id,
    slug: summary.slug,
    name: summary.name,
    description: summary.description,
    mode: "read",
    category: summary.category,
    tier: summary.tier,
    requiresEntraTier: summary.requiresEntraTier,
    scopes: summary.scopes,
    author: summary.author,
    version: summary.version,
    preferredModel: summary.preferredModel,
    execution: summary.execution,
    graphOperations: summary.graphOperations,
    connectors: summary.connectors,
    run: (ctx) => runScriptAgent(manifest, agentDir, ctx, options),
  };
}

async function runScriptAgent(
  manifest: AgentTemplate,
  agentDir: string,
  ctx: RunContext,
  options: ScriptAgentModuleOptions,
): Promise<AgentRunResult> {
  const execution = manifest.execution;
  if (execution?.kind !== "script") {
    throw new Error(`Agent "${manifest.descriptor.id}" is not a script agent.`);
  }

  const entrypoint = resolveEntrypoint(agentDir, execution.entrypoint);
  if (!existsSync(entrypoint)) {
    throw new Error(
      `Script agent "${manifest.descriptor.id}" is missing entrypoint ${execution.entrypoint}.`,
    );
  }

  const tempRoot = options.tempRoot ?? tmpdir();
  const createdRunRoot = await mkdtemp(
    path.join(tempRoot, `openadminos-${manifest.descriptor.id}-`),
  );
  const runRoot = realpathOrSelf(createdRunRoot);
  const workDir = path.join(runRoot, "work");
  const brokerDir = path.join(workDir, "broker");
  await mkdir(brokerDir, { recursive: true });
  const resultPath = path.join(workDir, SCRIPT_RESULT_FILE);
  const runner = options.sandboxRunner ?? createMxcSandboxRunner();
  const policy = agentTemplateToRegistrySummary(manifest);
  const broker = createSandboxBroker({
    agent: {
      slug: policy.slug,
      mode: policy.mode,
      scopes: policy.scopes,
      graphOperations: policy.graphOperations,
      connectors: policy.connectors,
    },
    ctx,
  });

  try {
    return await ctx.step(
      "Run MXC sandboxed script",
      "Executes the agent entrypoint through the experimental MXC sandbox and brokers host-owned Graph/LLM calls.",
      async () => {
        const nodePath = options.nodePath ?? process.execPath;
        let brokerActive = true;
        let brokerError: unknown;
        const brokerLoop = runFileBroker(
          brokerDir,
          broker,
          () => brokerActive,
        ).catch((error: unknown) => {
          brokerError = error;
        });

        const commandLine = [
          quoteCommandArg(nodePath),
          quoteCommandArg(entrypoint),
          "--result",
          quoteCommandArg(resultPath),
        ].join(" ");
        let sandboxResult: SandboxRunResult;
        try {
          sandboxResult = await runner.run({
            commandLine,
            readonlyPaths: [
              agentDir,
              ...guestRuntimeReadonlyPaths(nodePath),
            ],
            readwritePaths: [runRoot],
            cwd: workDir,
            containment: execution.containment as MxcContainment | undefined,
            timeoutMs: execution.timeoutMs,
            allowNetwork: false,
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              [BROKER_DIR_ENV]: brokerDir,
            },
          });
        } finally {
          brokerActive = false;
          await brokerLoop;
        }

        if (brokerError) {
          throw new Error(
            `MXC script broker failed for "${manifest.descriptor.id}": ${errorMessage(brokerError)}`,
          );
        }

        if (sandboxResult.exitCode !== 0) {
          const detail = sandboxResult.stderr.trim() || `exit code ${sandboxResult.exitCode}`;
          throw new Error(
            `MXC script agent "${manifest.descriptor.id}" failed: ${truncate(detail, 600)}`,
          );
        }

        return await readScriptResult(resultPath, manifest.descriptor.id);
      },
    );
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

async function runFileBroker(
  brokerDir: string,
  broker: SandboxBrokerEndpoint,
  isActive: () => boolean,
): Promise<void> {
  while (isActive()) {
    await processBrokerRequestFiles(brokerDir, broker);
    await delay(BROKER_POLL_MS);
  }
  await processBrokerRequestFiles(brokerDir, broker);
}

async function processBrokerRequestFiles(
  brokerDir: string,
  broker: SandboxBrokerEndpoint,
): Promise<void> {
  const files = await readdir(brokerDir).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  });
  const requestFiles = files
    .filter((file) => file.endsWith(BROKER_REQUEST_SUFFIX))
    .sort();

  for (const file of requestFiles) {
    const id = file.slice(0, -BROKER_REQUEST_SUFFIX.length);
    if (!isSafeBrokerFileId(id)) continue;
    await processBrokerRequestFile(brokerDir, broker, id, file);
  }
}

async function processBrokerRequestFile(
  brokerDir: string,
  broker: SandboxBrokerEndpoint,
  id: string,
  file: string,
): Promise<void> {
  const requestPath = path.join(brokerDir, file);
  let request: SandboxBrokerRequest;
  try {
    const parsed = JSON.parse(await readFile(requestPath, "utf8")) as unknown;
    if (!isRecord(parsed) || parsed.id !== id) {
      await writeBrokerFileResponse(brokerDir, {
        id,
        ok: false,
        error: {
          message: "Broker request file id must match the JSON request id.",
          code: "invalid_request",
        },
      });
      await unlink(requestPath).catch(() => undefined);
      return;
    }
    request = parsed as unknown as SandboxBrokerRequest;
  } catch (error) {
    await writeBrokerFileResponse(brokerDir, {
      id,
      ok: false,
      error: {
        message: `Broker request file is not valid JSON: ${errorMessage(error)}`,
        code: "invalid_request",
      },
    });
    await unlink(requestPath).catch(() => undefined);
    return;
  }

  const response = await broker.handle(request);
  await writeBrokerFileResponse(brokerDir, { ...response, id });
  await unlink(requestPath).catch(() => undefined);
}

async function writeBrokerFileResponse(
  brokerDir: string,
  response: SandboxBrokerResponse,
): Promise<void> {
  if (!isSafeBrokerFileId(response.id)) {
    throw new Error(`Broker response id "${response.id}" is not a safe file id.`);
  }
  const responsePath = path.join(
    brokerDir,
    `${response.id}${BROKER_RESPONSE_SUFFIX}`,
  );
  const tempPath = `${responsePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, JSON.stringify(response), "utf8");
  await rename(tempPath, responsePath);
}

function guestRuntimeReadonlyPaths(nodePath: string): string[] {
  const paths = new Set<string>();
  const realNodePath = realpathOrSelf(nodePath);
  paths.add(realNodePath);
  paths.add(path.dirname(realNodePath));

  const appBundle = macosAppBundleRoot(realNodePath);
  if (appBundle) {
    paths.add(appBundle);
    return [...paths];
  }

  // Homebrew and most Unix Node builds keep shared libraries next to
  // ../lib from the executable. Read-only access to the install prefix is
  // required on macOS Seatbelt for libnode.dylib and ICU data.
  paths.add(path.dirname(path.dirname(realNodePath)));
  if (realNodePath.startsWith("/opt/homebrew/")) {
    paths.add("/opt/homebrew/opt");
    paths.add("/opt/homebrew/Cellar");
    paths.add("/opt/homebrew/etc");
  }
  return [...paths];
}

function realpathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function macosAppBundleRoot(value: string): string | undefined {
  const marker = ".app/Contents/MacOS/";
  const index = value.indexOf(marker);
  if (index < 0) return undefined;
  return value.slice(0, index + ".app".length);
}

function resolveEntrypoint(agentDir: string, entrypoint: string): string {
  const resolvedAgentDir = path.resolve(agentDir);
  const resolvedEntrypoint = path.resolve(resolvedAgentDir, entrypoint);
  if (!pathContains(resolvedAgentDir, resolvedEntrypoint)) {
    throw new Error(`Script entrypoint must stay inside the agent directory.`);
  }
  return resolvedEntrypoint;
}

async function readScriptResult(
  resultPath: string,
  agentId: string,
): Promise<AgentRunResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `MXC script agent "${agentId}" did not produce a valid ${SCRIPT_RESULT_FILE}: ${message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `MXC script agent "${agentId}" produced a result that is not an object.`,
    );
  }
  const result = parsed as Record<string, unknown>;
  if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
    throw new Error(
      `MXC script agent "${agentId}" produced a result without a summary string.`,
    );
  }
  return {
    summary: result.summary.trim(),
    ...(result.result !== undefined ? { result: result.result } : {}),
  };
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isSafeBrokerFileId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteCommandArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+\-]+$/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, "\\$1")}"`;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}
