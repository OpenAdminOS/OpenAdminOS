import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  RunLlmApi,
} from "@openadminos/agent-sdk";

export interface ClaudeCodeProviderOptions {
  binaryPath?: string;
  homePath?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface ClaudeCodeProbeResult {
  installed: boolean;
  ready: boolean;
  version?: string;
  binaryPath?: string;
  authPath: string;
  models: string[];
  defaultModel?: string;
  detail?: string;
}

interface ClaudeCodeStreamEvent {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  result?: string;
  error?: string;
  message?: {
    model?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_CLAUDE_CODE_VERSION = "2.1.200";
const DEFAULT_CLAUDE_CODE_MODEL = "claude-sonnet-5";
const CLAUDE_CODE_MODELS = [
  "claude-fable-5",
  "claude-opus-4-8",
  DEFAULT_CLAUDE_CODE_MODEL,
  "claude-haiku-4-5-20251001",
];

const CLAUDE_CODE_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "all_proxy",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NODE_EXTRA_CA_CERTS",
  "NO_PROXY",
  "no_proxy",
  "PATH",
  "Path",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SystemRoot",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]);

export function createClaudeCodeLlm(
  options: ClaudeCodeProviderOptions = {},
): RunLlmApi {
  const homePath = resolveClaudeCodeHome(options.homePath);
  const defaultModel = options.defaultModel ?? DEFAULT_CLAUDE_CODE_MODEL;
  const configuredTimeout = Number.parseInt(
    process.env.OPENADMINOS_CLAUDE_CODE_TIMEOUT_MS ?? "",
    10,
  );
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS);
  const binaryPathPromise = resolveClaudeCodeBinary(options.binaryPath);

  return {
    available: true,
    defaultModel,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      const binaryPath = await binaryPathPromise;
      const tempDir = await mkdtemp(join(tmpdir(), "openadminos-claude-code-"));
      try {
        return await runClaudeCodeJson({
          binaryPath,
          homePath,
          cwd: tempDir,
          model: opts.model ?? defaultModel,
          system: opts.system,
          prompt: opts.prompt,
          timeoutMs,
          signal: opts.signal,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const binaryPath = await binaryPathPromise;
      const tempDir = await mkdtemp(join(tmpdir(), "openadminos-claude-code-"));
      try {
        yield* runClaudeCodeStream({
          binaryPath,
          homePath,
          cwd: tempDir,
          model: opts.model ?? defaultModel,
          system: opts.system,
          prompt: opts.prompt,
          timeoutMs,
          signal: opts.signal,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export async function probeClaudeCodeLlm(
  options: ClaudeCodeProviderOptions = {},
): Promise<ClaudeCodeProbeResult> {
  const homePath = resolveClaudeCodeHome(options.homePath);
  const authPath = join(homePath, ".credentials.json");
  const binaryProbe = await probeClaudeCodeBinary(options.binaryPath);
  const { versionResult } = binaryProbe;

  if (versionResult.exitCode !== 0) {
    const detail = compactProcessMessage(versionResult.stderr || versionResult.stdout);
    return {
      installed: versionResult.exitCode !== "spawn-error",
      ready: false,
      authPath,
      models: [],
      detail:
        detail ||
        (versionResult.exitCode === "spawn-error"
          ? "Claude Code CLI (`claude`) is not installed or not on PATH."
          : `Claude Code CLI exited with code ${versionResult.exitCode}.`),
    };
  }

  const version = parseVersion(versionResult.stdout || versionResult.stderr);
  if (version && compareVersions(version, MIN_CLAUDE_CODE_VERSION) < 0) {
    return {
      installed: true,
      ready: false,
      version,
      binaryPath: binaryProbe.binaryPath,
      authPath,
      models: [],
      detail: `Claude Code ${version} is installed. Update to ${MIN_CLAUDE_CODE_VERSION} or newer with \`claude update\` so OpenAdminOS can disable Claude Code tools safely.`,
    };
  }

  const authResult = await runProcess({
    binaryPath: binaryProbe.binaryPath,
    args: ["auth", "status", "--text"],
    timeoutMs: 5_000,
    env: createClaudeCodeProcessEnv({
      overrides: claudeCodeEnvOverrides(homePath),
    }),
  });
  if (authResult.exitCode !== 0) {
    const detail = compactProcessMessage(authResult.stderr || authResult.stdout);
    return {
      installed: true,
      ready: false,
      version,
      binaryPath: binaryProbe.binaryPath,
      authPath,
      models: [],
      detail:
        detail ||
        "Claude Code is installed. Run `claude auth login` in a terminal to authenticate.",
    };
  }

  return {
    installed: true,
    ready: true,
    version,
    binaryPath: binaryProbe.binaryPath,
    authPath,
    models: CLAUDE_CODE_MODELS,
    defaultModel: DEFAULT_CLAUDE_CODE_MODEL,
    detail: version
      ? `Claude Code ${version}`
      : "Claude Code is installed and authenticated.",
  };
}

export function createClaudeCodeProcessEnv(input: {
  source?: NodeJS.ProcessEnv;
  overrides?: NodeJS.ProcessEnv;
} = {}): NodeJS.ProcessEnv {
  const source = input.source ?? process.env;
  const env: NodeJS.ProcessEnv = {};

  for (const key of CLAUDE_CODE_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  for (const [key, value] of Object.entries(input.overrides ?? {})) {
    if (
      key !== "CLAUDE_CONFIG_DIR" &&
      key !== "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" &&
      !CLAUDE_CODE_ENV_ALLOWLIST.has(key)
    ) {
      continue;
    }
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

async function resolveClaudeCodeBinary(preferredBinaryPath?: string): Promise<string> {
  const probe = await probeClaudeCodeBinary(preferredBinaryPath);
  if (probe.versionResult.exitCode === 0) {
    const version = parseVersion(probe.versionResult.stdout || probe.versionResult.stderr);
    if (version && compareVersions(version, MIN_CLAUDE_CODE_VERSION) < 0) {
      throw new Error(
        `Claude Code ${version} is installed. Update to ${MIN_CLAUDE_CODE_VERSION} or newer with \`claude update\` so OpenAdminOS can disable Claude Code tools safely.`,
      );
    }
    return probe.binaryPath;
  }
  const detail = compactProcessMessage(probe.versionResult.stderr || probe.versionResult.stdout);
  throw new Error(detail || "Claude Code CLI is not installed or not executable.");
}

async function probeClaudeCodeBinary(preferredBinaryPath?: string): Promise<{
  binaryPath: string;
  versionResult: Awaited<ReturnType<typeof runProcess>>;
}> {
  let last:
    | {
        binaryPath: string;
        versionResult: Awaited<ReturnType<typeof runProcess>>;
      }
    | undefined;

  for (const binaryPath of claudeCodeBinaryCandidates(preferredBinaryPath)) {
    const versionResult = await runProcess({
      binaryPath,
      args: ["--version"],
      timeoutMs: 5_000,
    });
    const current = { binaryPath, versionResult };
    if (versionResult.exitCode === 0) return current;
    last = current;
  }

  return (
    last ?? {
      binaryPath: preferredBinaryPath ?? "claude",
      versionResult: {
        exitCode: "spawn-error",
        stdout: "",
        stderr: "Claude Code CLI (`claude`) is not installed or not on PATH.",
      },
    }
  );
}

function claudeCodeBinaryCandidates(preferredBinaryPath?: string): string[] {
  const candidates = [
    preferredBinaryPath,
    process.env.OPENADMINOS_CLAUDE_CODE_BINARY,
    "claude",
    join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.cmd" : "claude"),
    process.platform === "darwin" ? "/opt/homebrew/bin/claude" : undefined,
    process.platform === "darwin" ? "/usr/local/bin/claude" : undefined,
  ];
  return candidates.filter((candidate, index): candidate is string => {
    return Boolean(candidate) && candidates.indexOf(candidate) === index;
  });
}

async function runClaudeCodeJson(input: {
  binaryPath: string;
  homePath: string;
  cwd: string;
  model?: string;
  system?: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<LlmCompletion> {
  const result = await runProcess({
    binaryPath: input.binaryPath,
    args: [
      "-p",
      "--output-format",
      "json",
      ...claudeCodeSafetyArgs(),
      ...(input.model ? ["--model", input.model] : []),
      ...(input.system ? ["--append-system-prompt", input.system] : []),
      "--",
      input.prompt,
    ],
    cwd: input.cwd,
    env: createClaudeCodeProcessEnv({
      overrides: claudeCodeEnvOverrides(input.homePath),
    }),
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });

  if (result.exitCode !== 0) {
    if (input.signal?.aborted) {
      throw new Error("Claude Code request stopped by user.");
    }
    const detail = result.stderr || result.stdout;
    throw new Error(
      detail
        ? `Claude Code command failed: ${truncate(detail, 500)}`
        : `Claude Code command failed with code ${result.exitCode}.`,
    );
  }

  const parsed = parseClaudeCodeJson(result.stdout);
  if (!parsed) {
    throw new Error("Claude Code returned no JSON result.");
  }
  if (parsed.is_error === true || parsed.subtype === "error") {
    throw new Error(parsed.error ?? parsed.result ?? "Claude Code generation failed.");
  }
  const text = extractClaudeCodeResultText(parsed);
  if (!text) {
    throw new Error("Claude Code returned no final assistant message.");
  }
  return {
    text,
    model: extractClaudeCodeModel(parsed) ?? input.model ?? DEFAULT_CLAUDE_CODE_MODEL,
    ...(tokenUsageFromClaudeEvent(parsed) ? { tokenUsage: tokenUsageFromClaudeEvent(parsed) } : {}),
  };
}

async function* runClaudeCodeStream(input: {
  binaryPath: string;
  homePath: string;
  cwd: string;
  model?: string;
  system?: string;
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): AsyncIterable<LlmStreamChunk> {
  const child = spawn(
    input.binaryPath,
    [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      ...claudeCodeSafetyArgs(),
      ...(input.model ? ["--model", input.model] : []),
      ...(input.system ? ["--append-system-prompt", input.system] : []),
      "--",
      input.prompt,
    ],
    {
      cwd: input.cwd,
      env: createClaudeCodeProcessEnv({
        overrides: claudeCodeEnvOverrides(input.homePath),
      }),
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let accumulated = "";
  let finalText = "";
  let yielded = false;
  let settled = false;
  let actualModel = input.model ?? DEFAULT_CLAUDE_CODE_MODEL;
  let finalTokenUsage: LlmTokenUsage | undefined;
  const abortFromCaller = () => {
    if (!settled) {
      child.kill("SIGKILL");
    }
  };
  if (input.signal?.aborted) {
    abortFromCaller();
  } else {
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const closePromise = new Promise<number | null>((resolveResult, rejectResult) => {
    child.on("error", rejectResult);
    child.on("close", resolveResult);
  });
  const timer = setTimeout(() => {
    if (settled) return;
    child.kill("SIGKILL");
  }, input.timeoutMs);

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  if (!child.stdout) {
    clearTimeout(timer);
    throw new Error("Claude Code CLI did not expose stdout.");
  }

  child.stdout.setEncoding("utf8");
  for await (const raw of child.stdout) {
    stdout += String(raw);
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseClaudeCodeJson(line);
      if (!event) continue;
      const model = extractClaudeCodeModel(event);
      if (model) actualModel = model;
      const tokenUsage = tokenUsageFromClaudeEvent(event);
      if (tokenUsage) finalTokenUsage = tokenUsage;
      if (event.is_error === true || event.subtype === "error") {
        throw new Error(event.error ?? event.result ?? "Claude Code generation failed.");
      }
      const next = extractClaudeCodeStreamText(event);
      if (!next) continue;
      if (next.kind === "result") {
        finalText = next.text;
        continue;
      }
      if (next.kind === "delta") {
        accumulated += next.text;
      } else if (accumulated.length > 0 && next.text.startsWith(accumulated)) {
        accumulated = next.text;
      } else if (accumulated.length === 0) {
        accumulated = next.text;
      } else if (next.text !== accumulated) {
        accumulated = next.text;
      }
      yielded = true;
      yield {
        delta: next.kind === "delta" ? next.text : accumulated,
        accumulated,
        done: false,
        model: actualModel,
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    }
  }

  const exitCode = await closePromise;
  settled = true;
  clearTimeout(timer);
  input.signal?.removeEventListener("abort", abortFromCaller);

  if (exitCode !== 0) {
    if (input.signal?.aborted) {
      throw new Error("Claude Code request stopped by user.");
    }
    const detail = stderr || stdout;
    throw new Error(
      detail
        ? `Claude Code command failed: ${truncate(detail, 500)}`
        : `Claude Code command failed with code ${exitCode}.`,
    );
  }

  const text = finalText.trim() || accumulated.trim();
  if (!text) {
    throw new Error("Claude Code returned no final assistant message.");
  }
  yield {
    delta: yielded && text.startsWith(accumulated) ? text.slice(accumulated.length) : text,
    accumulated: text,
    done: true,
    model: actualModel,
    ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
  };
}

function claudeCodeSafetyArgs(): string[] {
  return [
    "--safe-mode",
    "--no-session-persistence",
    "--permission-mode",
    "manual",
    "--tools",
    "",
    "--disallowed-tools",
    "*",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--max-turns",
    "1",
  ];
}

function claudeCodeEnvOverrides(homePath: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_CONFIG_DIR: homePath,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

async function runProcess(input: {
  binaryPath: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | "spawn-error"; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(input.binaryPath, input.args, {
      cwd: input.cwd,
      env: input.env ?? createClaudeCodeProcessEnv(),
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: {
      exitCode: number | "spawn-error";
      stdout: string;
      stderr: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);
      resolveResult(result);
    };
    const abortFromCaller = () => {
      if (settled) return;
      child.kill("SIGKILL");
      finish({
        exitCode: -1,
        stdout,
        stderr: "Claude Code request stopped by user.",
      });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      finish({
        exitCode: -1,
        stdout,
        stderr: stderr || `Claude Code timed out after ${input.timeoutMs}ms.`,
      });
    }, input.timeoutMs);

    if (input.signal?.aborted) {
      abortFromCaller();
    } else {
      input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      finish({ exitCode: "spawn-error", stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      finish({ exitCode: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function resolveClaudeCodeHome(homePath?: string): string {
  return expandHome(homePath ?? process.env.CLAUDE_CONFIG_DIR ?? "~/.claude");
}

function parseClaudeCodeJson(line: string): ClaudeCodeStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as ClaudeCodeStreamEvent;
  } catch {
    return undefined;
  }
}

function extractClaudeCodeResultText(event: ClaudeCodeStreamEvent): string | undefined {
  if (typeof event.result === "string" && event.result.length > 0) {
    return event.result;
  }
  return assistantContentText(event);
}

function extractClaudeCodeStreamText(
  event: ClaudeCodeStreamEvent,
): { kind: "delta" | "message" | "result"; text: string } | undefined {
  if (event.type === "result") {
    const text = extractClaudeCodeResultText(event);
    return text ? { kind: "result", text } : undefined;
  }

  const text = assistantContentText(event);
  if (!text) return undefined;
  const type = event.type ?? "";
  return {
    kind: type.includes("delta") || type.includes("partial") ? "delta" : "message",
    text,
  };
}

function assistantContentText(event: ClaudeCodeStreamEvent): string | undefined {
  const content = event.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
  return text.length > 0 ? text : undefined;
}

function extractClaudeCodeModel(event: ClaudeCodeStreamEvent): string | undefined {
  return typeof event.message?.model === "string" && event.message.model.length > 0
    ? event.message.model
    : undefined;
}

function tokenUsageFromClaudeEvent(event: ClaudeCodeStreamEvent): LlmTokenUsage | undefined {
  const prompt =
    typeof event.usage?.input_tokens === "number" ? event.usage.input_tokens : undefined;
  const completion =
    typeof event.usage?.output_tokens === "number" ? event.usage.output_tokens : undefined;
  const total =
    typeof event.usage?.total_tokens === "number" ? event.usage.total_tokens : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  const usage: LlmTokenUsage = {};
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (total !== undefined) {
    usage.totalTokens = total;
  } else if (prompt !== undefined && completion !== undefined) {
    usage.totalTokens = prompt + completion;
  }
  return usage;
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function parseVersion(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const match = trimmed.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/);
  return match?.[1] ?? trimmed.split(/\s+/).at(0);
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index] ?? 0;
    const r = right[index] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function compactProcessMessage(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ? truncate(firstLine, 220) : "";
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
