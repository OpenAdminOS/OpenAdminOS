import type { ChildProcess } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { Writable } from "node:stream";

import type {
  HostPlatform,
  SandboxBrokerRequest,
  SandboxBrokerResponse,
  SandboxDiagnostics,
} from "@openadminos/agent-sdk";

export const OPENADMINOS_MXC_FLAG = "OPENADMINOS_EXPERIMENTAL_MXC";
const MXC_SCHEMA_VERSION = "0.6.0-alpha";
const MXC_PREVIEW_WARNING =
  "MXC is public preview. Microsoft documents current SDK-generated policies " +
  "as early-preview and potentially overly permissive, so OpenAdminOS does not " +
  "treat MXC as its only security boundary.";

export type MxcContainment =
  | "process"
  | "vm"
  | "microvm"
  | "processcontainer"
  | "windows_sandbox"
  | "wslc"
  | "lxc"
  | "hyperlight"
  | "seatbelt"
  | "isolation_session"
  | "bubblewrap";

export interface SandboxRunInput {
  commandLine: string;
  readonlyPaths: string[];
  readwritePaths: string[];
  containment?: MxcContainment;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
  broker?: SandboxBrokerEndpoint;
}

export interface SandboxRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface SandboxRunner {
  readonly id: "mxc";
  probe(): Promise<SandboxDiagnostics>;
  run(input: SandboxRunInput): Promise<SandboxRunResult>;
}

export interface SandboxBrokerEndpoint {
  handle(request: SandboxBrokerRequest): Promise<SandboxBrokerResponse>;
}

interface MxcPlatformSupport {
  isSupported?: boolean;
  supported?: boolean;
  reason?: string;
  detail?: string;
  availableMethods?: string[];
  isolationTier?: string;
  isolationWarnings?: string[];
  uiCapabilities?: Record<string, boolean>;
  defaultBackend?: string;
  backend?: string;
  containment?: string;
  platform?: string;
}

interface MxcContainerConfig {
  process?: {
    commandLine?: string;
    cwd?: string;
    timeout?: number;
    env?: string[];
  };
  containment?: string;
}

interface MxcSdk {
  getPlatformSupport(): MxcPlatformSupport;
  createConfigFromPolicy(
    policy: Record<string, unknown>,
    containment?: MxcContainment,
  ): MxcContainerConfig;
  spawnSandboxFromConfig(
    config: MxcContainerConfig,
    options?: Record<string, unknown>,
    workingDirectory?: string,
    env?: NodeJS.ProcessEnv,
  ): ChildProcess;
}

export interface MxcSandboxRunnerOptions {
  env?: NodeJS.ProcessEnv;
  loadSdk?: () => Promise<MxcSdk>;
}

export function isMxcSandboxEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[OPENADMINOS_MXC_FLAG] === "1";
}

export async function probeMxcSandbox(
  options: MxcSandboxRunnerOptions = {},
): Promise<SandboxDiagnostics> {
  const env = options.env ?? process.env;
  if (!isMxcSandboxEnabled(env)) {
    return {
      backend: "mxc",
      status: "disabled",
      experimentalEnabled: false,
      supported: false,
      detail: `Set ${OPENADMINOS_MXC_FLAG}=1 to enable the experimental MXC sandbox probe.`,
      remediation:
        "Normal YAML agents keep running through the manifest interpreter. Sandboxed code remains disabled and fails closed.",
      warning: MXC_PREVIEW_WARNING,
    };
  }

  let sdk: MxcSdk;
  try {
    sdk = await loadMxcSdk(options.loadSdk);
  } catch (error) {
    return {
      backend: "mxc",
      status: "unavailable",
      experimentalEnabled: true,
      supported: false,
      detail: `MXC SDK is not available: ${errorMessage(error)}`,
      remediation: hostPrepRemediation(),
      warning: MXC_PREVIEW_WARNING,
    };
  }

  try {
    const support = sdk.getPlatformSupport();
    const supported = support.isSupported ?? support.supported ?? false;
    const availableMethods = normalizeStringArray(support.availableMethods);
    const containment =
      support.defaultBackend ??
      support.backend ??
      support.containment ??
      (availableMethods.length > 0 ? availableMethods.join(", ") : undefined);
    const isolationWarnings = normalizeStringArray(support.isolationWarnings);
    return {
      backend: "mxc",
      status: supported ? "available" : "unavailable",
      experimentalEnabled: true,
      supported,
      ...(containment ? { containment } : {}),
      ...(availableMethods.length > 0 ? { availableMethods } : {}),
      ...(support.isolationTier ? { isolationTier: support.isolationTier } : {}),
      ...(isolationWarnings.length > 0 ? { isolationWarnings } : {}),
      ...(support.uiCapabilities ? { uiCapabilities: support.uiCapabilities } : {}),
      detail: supported
        ? formatSupportedDetail(
            normalizePlatformLabel(support.platform ?? process.platform),
            availableMethods,
            support.isolationTier,
            isolationWarnings,
          )
        : support.reason ??
          support.detail ??
          "MXC is installed but no supported backend was detected.",
      ...(!supported || isolationWarnings.length > 0
        ? { remediation: hostPrepRemediation(isolationWarnings) }
        : {}),
      warning: MXC_PREVIEW_WARNING,
    };
  } catch (error) {
    return {
      backend: "mxc",
      status: "error",
      experimentalEnabled: true,
      supported: false,
      detail: `MXC probe failed: ${errorMessage(error)}`,
      remediation:
        "Review the MXC diagnostic output and keep sandboxed code disabled until the probe succeeds.",
      warning: MXC_PREVIEW_WARNING,
    };
  }
}

export function createMxcSandboxRunner(
  options: MxcSandboxRunnerOptions = {},
): SandboxRunner {
  return {
    id: "mxc",
    probe: () => probeMxcSandbox(options),
    run: (input) => runMxcSandbox(input, options),
  };
}

async function runMxcSandbox(
  input: SandboxRunInput,
  options: MxcSandboxRunnerOptions,
): Promise<SandboxRunResult> {
  const env = options.env ?? process.env;
  if (!isMxcSandboxEnabled(env)) {
    throw new Error(
      `MXC sandbox is disabled. Set ${OPENADMINOS_MXC_FLAG}=1 before running untrusted agent code.`,
    );
  }
  if (!input.commandLine.trim()) {
    throw new Error("MXC sandbox commandLine must be non-empty.");
  }
  const readonlyPaths = normalizePolicyPaths(input.readonlyPaths);
  const readwritePaths = normalizePolicyPaths(input.readwritePaths);
  if (readwritePaths.length === 0) {
    throw new Error("MXC sandbox requires at least one scoped read-write path.");
  }
  if (
    input.cwd &&
    !isPathWithinPolicy(input.cwd, [...readonlyPaths, ...readwritePaths])
  ) {
    throw new Error(
      "MXC sandbox cwd must be covered by readonlyPaths or readwritePaths; cwd does not grant filesystem access.",
    );
  }

  const sdk = await loadMxcSdk(options.loadSdk);
  const containment = input.containment ?? "process";
  const config = sdk.createConfigFromPolicy(
    {
      version: MXC_SCHEMA_VERSION,
      filesystem: {
        readonlyPaths,
        readwritePaths,
        clearPolicyOnExit: true,
      },
      network: {
        allowOutbound: input.allowNetwork === true,
      },
      ui: {
        allowWindows: false,
        clipboard: "none",
        allowInputInjection: false,
      },
      timeoutMs: input.timeoutMs ?? 30_000,
    },
    containment,
  );

  if (!config.process) config.process = {};
  config.process.commandLine = input.commandLine;
  if (input.cwd) {
    config.process.cwd = input.cwd;
  }

  const child = sdk.spawnSandboxFromConfig(
    config,
    {
      usePty: false,
      ...(requiresMxcExperimentalSpawn(containment) ? { experimental: true } : {}),
    },
    input.cwd,
    sanitizeSandboxEnv(input.env ?? env),
  );

  if (input.broker) {
    return await collectBrokeredChildProcess(
      child,
      input.broker,
      input.maxOutputBytes ?? 512_000,
    );
  }

  return await collectChildProcess(child, input.maxOutputBytes ?? 512_000);
}

async function loadMxcSdk(
  override?: () => Promise<MxcSdk>,
): Promise<MxcSdk> {
  if (override) return await override();
  const specifier = "@microsoft/mxc-sdk";
  const mod = (await import(specifier)) as Partial<MxcSdk>;
  if (
    typeof mod.getPlatformSupport !== "function" ||
    typeof mod.createConfigFromPolicy !== "function" ||
    typeof mod.spawnSandboxFromConfig !== "function"
  ) {
    throw new Error("@microsoft/mxc-sdk did not expose the expected API.");
  }
  return mod as MxcSdk;
}

function collectChildProcess(
  child: ChildProcess,
  maxOutputBytes: number,
): Promise<SandboxRunResult> {
  let stdout = "";
  let stderr = "";
  let stdoutBytes = 0;
  let stderrBytes = 0;

  child.stdout?.on("data", (chunk: Buffer | string) => {
    const next = appendCapped(stdout, stdoutBytes, chunk, maxOutputBytes);
    stdout = next.text;
    stdoutBytes = next.bytes;
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const next = appendCapped(stderr, stderrBytes, chunk, maxOutputBytes);
    stderr = next.text;
    stderrBytes = next.bytes;
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function collectBrokeredChildProcess(
  child: ChildProcess,
  broker: SandboxBrokerEndpoint,
  maxOutputBytes: number,
): Promise<SandboxRunResult> {
  if (!child.stdin) {
    return Promise.reject(
      new Error("MXC sandbox broker requires a writable child stdin pipe."),
    );
  }

  let stderr = "";
  let stderrBytes = 0;
  let protocolBuffer = "";
  let protocolError: Error | undefined;
  let pending = Promise.resolve();
  const echoedResponseIds = new Set<string>();

  child.stdout?.on("data", (chunk: Buffer | string) => {
    if (protocolError) return;
    protocolBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(protocolBuffer, "utf8") > maxOutputBytes) {
      failBrokerProtocol(
        child,
        new Error("MXC sandbox broker protocol exceeded the output byte cap."),
        (error) => {
          protocolError = error;
        },
      );
      return;
    }

    let newlineIndex = protocolBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = protocolBuffer.slice(0, newlineIndex).trim();
      protocolBuffer = protocolBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        pending = pending
          .then(() =>
            handleBrokerProtocolLine(
              child.stdin!,
              broker,
              line,
              echoedResponseIds,
            ),
          )
          .catch((error: unknown) => {
            failBrokerProtocol(child, error, (next) => {
              protocolError = next;
            });
          });
      }
      newlineIndex = protocolBuffer.indexOf("\n");
    }
  });

  child.stderr?.on("data", (chunk: Buffer | string) => {
    const next = appendCapped(stderr, stderrBytes, chunk, maxOutputBytes);
    stderr = next.text;
    stderrBytes = next.bytes;
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (protocolBuffer.trim().length > 0 && !protocolError) {
        protocolError = new Error(
          "MXC sandbox broker received an incomplete JSON line before process exit.",
        );
      }
      pending
        .then(() => {
          if (protocolError) {
            reject(protocolError);
            return;
          }
          resolve({
            exitCode,
            signal,
            stdout: "",
            stderr,
          });
        })
        .catch(reject);
    });
  });
}

async function handleBrokerProtocolLine(
  stdin: Writable,
  broker: SandboxBrokerEndpoint,
  line: string,
  echoedResponseIds: Set<string>,
): Promise<void> {
  const request = parseBrokerRequestLine(line, echoedResponseIds);
  if (!request) return;
  const response = await broker.handle(request);
  await writeBrokerResponse(stdin, response, echoedResponseIds);
}

function parseBrokerRequestLine(
  line: string,
  echoedResponseIds: Set<string>,
): SandboxBrokerRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(`MXC sandbox broker received invalid JSON: ${errorMessage(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("MXC sandbox broker request must be a JSON object.");
  }
  if (
    typeof parsed.id === "string" &&
    typeof parsed.ok === "boolean" &&
    typeof parsed.method !== "string" &&
    echoedResponseIds.delete(parsed.id)
  ) {
    return null;
  }
  if (typeof parsed.id !== "string" || parsed.id.length === 0) {
    throw new Error("MXC sandbox broker request requires a non-empty string id.");
  }
  if (typeof parsed.method !== "string" || parsed.method.length === 0) {
    throw new Error("MXC sandbox broker request requires a non-empty string method.");
  }
  if (!isRecord(parsed.params)) {
    throw new Error("MXC sandbox broker request requires an object params field.");
  }
  return parsed as unknown as SandboxBrokerRequest;
}

function writeBrokerResponse(
  stdin: Writable,
  response: SandboxBrokerResponse,
  echoedResponseIds: Set<string>,
): Promise<void> {
  const line = `${JSON.stringify(response)}\n`;
  echoedResponseIds.add(response.id);
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stdin.off("error", onError);
      stdin.off("drain", onDrain);
    };

    stdin.once("error", onError);
    if (stdin.write(line, "utf8")) {
      cleanup();
      resolve();
      return;
    }
    stdin.once("drain", onDrain);
  });
}

function failBrokerProtocol(
  child: ChildProcess,
  error: unknown,
  setError: (error: Error) => void,
): void {
  const next = error instanceof Error ? error : new Error(String(error));
  setError(next);
  child.kill();
}

function appendCapped(
  current: string,
  currentBytes: number,
  chunk: Buffer | string,
  maxBytes: number,
): { text: string; bytes: number } {
  if (currentBytes >= maxBytes) {
    return { text: current, bytes: currentBytes };
  }
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  const nextBytes = currentBytes + Buffer.byteLength(text, "utf8");
  if (nextBytes <= maxBytes) {
    return { text: current + text, bytes: nextBytes };
  }

  const remaining = Math.max(0, maxBytes - currentBytes);
  return {
    text: current + Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8"),
    bytes: maxBytes,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSandboxEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowedKeys = [
    "PATH",
    "SystemRoot",
    "WINDIR",
    "TMP",
    "TEMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "LOCALAPPDATA",
    "ELECTRON_RUN_AS_NODE",
    "OPENADMINOS_BROKER_DIR",
  ];
  const clean: NodeJS.ProcessEnv = {};
  for (const key of allowedKeys) {
    const value = env[key];
    if (typeof value === "string" && value.length > 0) {
      clean[key] = value;
    }
  }
  return clean;
}

function normalizePolicyPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of paths) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const resolved = realpathIfPresent(path.resolve(trimmed));
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(resolved);
    }
  }
  return normalized;
}

function realpathIfPresent(value: string): string {
  try {
    return existsSync(value) ? realpathSync(value) : value;
  } catch {
    return value;
  }
}

function isPathWithinPolicy(target: string, policyPaths: string[]): boolean {
  const resolvedTarget = realpathIfPresent(path.resolve(target));
  return policyPaths.some((policyPath) => pathContains(policyPath, resolvedTarget));
}

function pathContains(parent: string, child: string): boolean {
  const resolvedParent = realpathIfPresent(path.resolve(parent));
  const resolvedChild = realpathIfPresent(path.resolve(child));
  if (process.platform === "win32") {
    const parentLower = resolvedParent.toLowerCase();
    const childLower = resolvedChild.toLowerCase();
    const relative = path.relative(parentLower, childLower);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }
  const relative = path.relative(resolvedParent, resolvedChild);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function requiresMxcExperimentalSpawn(containment: MxcContainment): boolean {
  if (
    containment === "microvm" ||
    containment === "vm" ||
    containment === "windows_sandbox" ||
    containment === "wslc" ||
    containment === "hyperlight" ||
    containment === "seatbelt" ||
    containment === "isolation_session"
  ) {
    return true;
  }
  return containment === "process" && process.platform === "darwin";
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is string => typeof value === "string");
}

function formatSupportedDetail(
  platform: HostPlatform,
  methods: string[],
  isolationTier: string | undefined,
  warnings: string[],
): string {
  const parts = [`MXC reports sandbox support on ${platform}.`];
  if (methods.length > 0) {
    parts.push(`Available methods: ${methods.join(", ")}.`);
  }
  if (isolationTier) {
    parts.push(`Windows isolation tier: ${isolationTier}.`);
  }
  if (warnings.length > 0) {
    parts.push(`Probe warnings: ${warnings.join(" ")}`);
  }
  return parts.join(" ");
}

function normalizePlatformLabel(platform: string | undefined): HostPlatform {
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "win32" || platform === "windows") return "windows";
  if (platform === "linux") return "linux";
  return "unknown";
}

function hostPrepRemediation(isolationWarnings: string[] = []): string {
  if (process.platform === "win32") {
    const warningSuffix =
      isolationWarnings.length > 0
        ? ` Probe warning: ${isolationWarnings.join(" ")}`
        : "";
    return (
      "Enterprise admins can prepare MXC hosts with wxc-host-prep.exe from " +
      "the MXC SDK: run prepare-system-drive once when AppContainer " +
      "system-drive ACLs are missing, and prepare-null-device once per boot " +
      "when NUL device access is missing. OpenAdminOS does not elevate or run " +
      `host-prep automatically.${warningSuffix}`
    );
  }
  if (process.platform === "linux") {
    return "Install the optional @microsoft/mxc-sdk package plus Bubblewrap or the LXC toolset for the selected backend, then re-run the probe.";
  }
  if (process.platform === "darwin") {
    return "Install an MXC SDK build that includes mxc-exec-mac for this architecture; macOS uses the experimental seatbelt backend while OpenAdminOS' MXC feature flag is enabled.";
  }
  return "Install a supported MXC SDK/backend for this host before enabling sandboxed code.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
