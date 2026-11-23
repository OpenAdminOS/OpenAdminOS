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
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AgentRunResult,
  AgentTemplate,
  ReadAgentModule,
  RunContext,
  SandboxBrokerRequest,
  SandboxBrokerResponse,
} from "@openadminos/agent-sdk";
import { ContextTooSmallError, contextTooSmallFromError } from "@openadminos/agent-sdk";

import { agentTemplateToRegistrySummary } from "./agent-template.js";
import {
  createMxcSandboxRunner,
  type SandboxBrokerEndpoint,
  type MxcContainment,
  type SandboxRunResult,
  type SandboxRunner,
} from "./sandbox.js";
import { createSandboxBroker, type ScriptExitRecord } from "./sandbox-broker.js";

const SCRIPT_RESULT_FILE = "result.json";
const BROKER_DIR_ENV = "OPENADMINOS_BROKER_DIR";
const EXIT_RECORD_ENV = "OPENADMINOS_EXIT_RECORD";

/**
 * Loaded into the script's Node process before its entrypoint: records the
 * error the script ends with (an uncaught exception or an unhandled
 * rejection), without changing how Node reports it or exits: its message, and
 * the broker request id it or an error in its cause chain carries with the
 * message of the error that carries it. Only the
 * launched process's main thread records: the destination is taken out of
 * the environment as the hook loads, so Workers and child processes, which
 * inherit the hook, have none. An error the script handles itself (an
 * uncaughtException listener or a capture callback) is not recorded; one
 * that escapes such a listener is.
 */
const EXIT_RECORD_HOOK = `import { writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
const target = process.env.${EXIT_RECORD_ENV};
delete process.env.${EXIT_RECORD_ENV};
if (isMainThread && target) {
  const record = (error) => {
    try {
      const message = error instanceof Error ? String(error.message) : String(error);
      let carrier;
      for (let current = error, depth = 0; current && depth < 8; current = current.cause, depth += 1) {
        if (typeof current.brokerRequestId === "string") { carrier = current; break; }
      }
      writeFileSync(target, JSON.stringify(carrier
        ? { message, brokerRequestId: carrier.brokerRequestId, brokerErrorMessage: String(carrier.message) }
        : { message }));
    } catch {}
  };
  process.on("uncaughtExceptionMonitor", (error) => {
    if (process.listenerCount("uncaughtException") > 0 || process.hasUncaughtExceptionCaptureCallback()) return;
    record(error);
  });
  // An uncaughtException listener that throws ends the process with that
  // error and no further monitor event, so the error that escapes it is the one the script ended with.
  const emit = process.emit;
  process.emit = function (event, ...args) {
    if (event !== "uncaughtException") return emit.call(this, event, ...args);
    try {
      return emit.call(this, event, ...args);
    } catch (escaped) {
      record(escaped);
      throw escaped;
    }
  };
}
`;
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
  const exitHookPath = path.join(workDir, "exit-record-hook.mjs");
  const exitRecordPath = path.join(workDir, "exit-record.json");
  await writeFile(exitHookPath, EXIT_RECORD_HOOK);
  const runner = options.sandboxRunner ?? createMxcSandboxRunner();
  const policy = agentTemplateToRegistrySummary(manifest);
  const broker = createSandboxBroker({
    agent: {
      slug: policy.slug,
      mode: policy.mode,
      scopes: policy.scopes,
      graphOperations: policy.graphOperations,
      ...(policy.writeLimits ? { writeLimits: policy.writeLimits } : {}),
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
          "--import",
          quoteCommandArg(pathToFileURL(exitHookPath).href),
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
              [EXIT_RECORD_ENV]: exitRecordPath,
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
          // A model reply with reasoning and no answer is kept as the cause
          // when the error the script ended with, as its process recorded
          // it, carries it. That record decides before any reading of the
          // script's output.
          const ended = await readExitRecord(exitRecordPath);
          const reasoning = ended ? broker.llmFailureFor(ended) : undefined;
          const terminal = ended ? broker.failuresEndedWith(ended) : [];
          // A script that ended on a refused model request fails with the
          // typed reason, not its stack trace. A script that caught the
          // refusal and failed later keeps its error. The recorded broker
          // failure decides; only without one is the output read for it.
          const sizeRefusals = terminal.map((error) => contextTooSmallFromError(error));
          const tooLarge = reasoning
            ? undefined
            : terminal.length > 0
              ? sizeRefusals.every((failure) => failure !== undefined) ? sizeRefusals.at(-1) : undefined
              : endedOnSizeRefusal(sandboxResult.stderr) ? broker.getContextFailure() : undefined;
          if (tooLarge) throw new ContextTooSmallError(tooLarge);
          // The script sees only the message of a Graph denial. When it exits
          // on that denial, the typed error is kept as the cause so the run
          // records the Graph denial.
          const cause = reasoning ?? broker.graphDenialFor(detail);
          throw new Error(
            `MXC script agent "${manifest.descriptor.id}" failed: ${truncate(detail, 600)}`,
            cause ? { cause } : undefined,
          );
        }

        return await readScriptResult(resultPath, manifest.descriptor.id);
      },
    );
  } finally {
    await rm(runRoot, { recursive: true, force: true });
  }
}

/** The error the script ended with, when its process recorded one. */
async function readExitRecord(recordPath: string): Promise<ScriptExitRecord | undefined> {
  try {
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { message?: unknown; brokerRequestId?: unknown; brokerErrorMessage?: unknown };
    if (typeof record.message !== "string") return undefined;
    return {
      message: record.message,
      ...(typeof record.brokerRequestId === "string" ? { brokerRequestId: record.brokerRequestId } : {}),
      ...(typeof record.brokerRequestId === "string" && typeof record.brokerErrorMessage === "string"
        ? { brokerErrorMessage: record.brokerErrorMessage }
        : {}),
    };
  } catch {
    return undefined;
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

/**
 * Whether the script ended on the size refusal. Node prints an uncaught
 * exception after the source line and a caret ("^"); the first line after
 * the last caret is what the script threw, whether an Error ("Error:
 * llm.complete: ...") or a plain string. Without a caret (the script exited
 * on its own), the last error header counts. A refusal the script logged
 * earlier and then moved past does not count.
 */
export function endedOnSizeRefusal(stderr: string): boolean {
  const lines = stderr.split("\n");
  let caret = -1;
  lines.forEach((line, index) => {
    if (/^\s*\^+\s*$/.test(line)) caret = index;
  });
  const terminal = caret >= 0
    ? lines.slice(caret + 1).find((line) => line.trim().length > 0) ?? ""
    : [...stderr.matchAll(/^(?:Uncaught )?[A-Za-z]*Error\b[^\n]*$/gm)].at(-1)?.[0] ?? "";
  return /context-too-small|tokens of context/i.test(terminal);
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
