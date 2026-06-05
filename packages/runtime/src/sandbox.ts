import type { ChildProcess } from "node:child_process";

import type { HostPlatform, SandboxDiagnostics } from "@openadminos/agent-sdk";

export const OPENADMINOS_MXC_FLAG = "OPENADMINOS_EXPERIMENTAL_MXC";
const MXC_SCHEMA_VERSION = "0.6.0-alpha";
const MXC_PREVIEW_WARNING =
  "MXC is public preview and is not treated as OpenAdminOS's only security boundary.";

export interface SandboxRunInput {
  commandLine: string;
  readonlyPaths: string[];
  readwritePaths: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  allowNetwork?: boolean;
  maxOutputBytes?: number;
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

interface MxcPlatformSupport {
  isSupported?: boolean;
  supported?: boolean;
  reason?: string;
  detail?: string;
  defaultBackend?: string;
  backend?: string;
  containment?: string;
  platform?: string;
}

interface MxcContainerConfig {
  process?: {
    commandLine?: string;
  };
}

interface MxcSdk {
  getPlatformSupport(): MxcPlatformSupport;
  createConfigFromPolicy(
    policy: Record<string, unknown>,
    containment?: "process" | "vm" | "microvm",
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
      warning: MXC_PREVIEW_WARNING,
    };
  }

  try {
    const support = sdk.getPlatformSupport();
    const supported = support.isSupported ?? support.supported ?? false;
    const containment =
      support.defaultBackend ?? support.backend ?? support.containment;
    return {
      backend: "mxc",
      status: supported ? "available" : "unavailable",
      experimentalEnabled: true,
      supported,
      ...(containment ? { containment } : {}),
      detail: supported
        ? `MXC reports sandbox support on ${normalizePlatformLabel(support.platform)}.`
        : support.reason ?? support.detail ?? "MXC is installed but no supported backend was detected.",
      warning: MXC_PREVIEW_WARNING,
    };
  } catch (error) {
    return {
      backend: "mxc",
      status: "error",
      experimentalEnabled: true,
      supported: false,
      detail: `MXC probe failed: ${errorMessage(error)}`,
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
  if (input.readwritePaths.length === 0) {
    throw new Error("MXC sandbox requires at least one scoped read-write path.");
  }

  const sdk = await loadMxcSdk(options.loadSdk);
  const config = sdk.createConfigFromPolicy(
    {
      version: MXC_SCHEMA_VERSION,
      filesystem: {
        readonlyPaths: dedupePaths(input.readonlyPaths),
        readwritePaths: dedupePaths(input.readwritePaths),
      },
      network: {
        allowOutbound: input.allowNetwork === true,
      },
      ui: {
        allowWindows: false,
      },
      timeoutMs: input.timeoutMs ?? 30_000,
    },
    "process",
  );

  if (!config.process) config.process = {};
  config.process.commandLine = input.commandLine;

  const child = sdk.spawnSandboxFromConfig(
    config,
    {
      usePty: false,
      experimental: true,
    },
    input.cwd,
    sanitizeSandboxEnv(input.env ?? env),
  );

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

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim().length > 0))];
}

function normalizePlatformLabel(platform: string | undefined): HostPlatform {
  if (platform === "darwin" || platform === "macos") return "macos";
  if (platform === "win32" || platform === "windows") return "windows";
  if (platform === "linux") return "linux";
  return "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
