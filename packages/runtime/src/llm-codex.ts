import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  RunLlmApi,
} from "@openadminos/agent-sdk";

export interface CodexProviderOptions {
  binaryPath?: string;
  homePath?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface CodexProbeResult {
  installed: boolean;
  ready: boolean;
  version?: string;
  authPath: string;
  models: string[];
  defaultModel?: string;
  detail?: string;
}

interface CodexModelsCache {
  models?: Array<{
    slug?: string;
    visibility?: string;
    supported_in_api?: boolean;
  }>;
}

const DEFAULT_TIMEOUT_MS = 180_000;

export function createCodexLlm(options: CodexProviderOptions = {}): RunLlmApi {
  const homePath = expandHome(options.homePath ?? process.env.CODEX_HOME ?? "~/.codex");
  const defaultModel = options.defaultModel;
  const configuredTimeout = Number.parseInt(process.env.OPENADMINOS_CODEX_TIMEOUT_MS ?? "", 10);
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS);
  const binaryPathPromise = resolveCodexBinary(options.binaryPath);

  return {
    available: true,
    defaultModel,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      let last: LlmStreamChunk | undefined;
      for await (const chunk of this.stream(opts)) {
        last = chunk;
      }
      if (!last) {
        throw new Error("Codex CLI returned no final assistant message.");
      }
      return { text: last.accumulated, model: last.model };
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const model = opts.model ?? defaultModel;
      const tempDir = await mkdtemp(join(tmpdir(), "openadminos-codex-"));
      const outputPath = join(tempDir, "last-message.txt");
      await writeFile(outputPath, "", "utf8");

      try {
        const binaryPath = await binaryPathPromise;
        yield* runCodexExecStream({
          binaryPath,
          homePath,
          cwd: tempDir,
          outputPath,
          model,
          prompt: formatPrompt(opts),
          timeoutMs,
        });
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
}

export async function probeCodexLlm(
  options: CodexProviderOptions = {},
): Promise<CodexProbeResult> {
  const homePath = expandHome(options.homePath ?? process.env.CODEX_HOME ?? "~/.codex");
  const authPath = join(homePath, "auth.json");

  const binaryProbe = await probeCodexBinary(options.binaryPath);
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
          ? "Codex CLI (`codex`) is not installed or not on PATH."
          : `Codex CLI exited with code ${versionResult.exitCode}.`),
    };
  }

  const version = parseVersion(versionResult.stdout || versionResult.stderr);
  if (!existsSync(authPath)) {
    return {
      installed: true,
      ready: false,
      version,
      authPath,
      models: [],
      detail: "Codex CLI is installed. Run `codex login` in a terminal to authenticate.",
    };
  }

  const modelMetadata = await readCodexModelMetadata(homePath);
  return {
    installed: true,
    ready: true,
    version,
    authPath,
    models: modelMetadata.models,
    ...(modelMetadata.defaultModel ? { defaultModel: modelMetadata.defaultModel } : {}),
    detail: version ? `Codex CLI ${version}` : "Codex CLI is installed and authenticated.",
  };
}

async function resolveCodexBinary(preferredBinaryPath?: string): Promise<string> {
  const probe = await probeCodexBinary(preferredBinaryPath);
  if (probe.versionResult.exitCode === 0) return probe.binaryPath;
  const detail = compactProcessMessage(probe.versionResult.stderr || probe.versionResult.stdout);
  throw new Error(detail || "Codex CLI is not installed or not executable.");
}

async function probeCodexBinary(preferredBinaryPath?: string): Promise<{
  binaryPath: string;
  versionResult: Awaited<ReturnType<typeof runProcess>>;
}> {
  let last:
    | {
        binaryPath: string;
        versionResult: Awaited<ReturnType<typeof runProcess>>;
      }
    | undefined;

  for (const binaryPath of codexBinaryCandidates(preferredBinaryPath)) {
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
      binaryPath: preferredBinaryPath ?? "codex",
      versionResult: {
        exitCode: "spawn-error",
        stdout: "",
        stderr: "Codex CLI (`codex`) is not installed or not on PATH.",
      },
    }
  );
}

function codexBinaryCandidates(preferredBinaryPath?: string): string[] {
  const candidates = [
    preferredBinaryPath,
    process.env.OPENADMINOS_CODEX_BINARY,
    "codex",
    process.platform === "darwin"
      ? "/Applications/Codex.app/Contents/Resources/codex"
      : undefined,
  ];
  return candidates.filter((candidate, index): candidate is string => {
    return Boolean(candidate) && candidates.indexOf(candidate) === index;
  });
}

function formatPrompt(opts: LlmOptions): string {
  if (!opts.system) return opts.prompt;
  return `${opts.system.trim()}\n\nUser request:\n${opts.prompt}`;
}

async function readCodexModelMetadata(
  homePath: string,
): Promise<{ models: string[]; defaultModel?: string }> {
  const [models, defaultModel] = await Promise.all([
    readCodexModelsCache(join(homePath, "models_cache.json")),
    readCodexDefaultModel(join(homePath, "config.toml")),
  ]);

  return {
    models,
    ...(defaultModel ? { defaultModel } : {}),
  };
}

async function readCodexModelsCache(filePath: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as CodexModelsCache;
    const seen = new Set<string>();
    const models: string[] = [];
    for (const model of parsed.models ?? []) {
      const slug = model.slug?.trim();
      if (!slug || seen.has(slug)) continue;
      if (model.visibility && model.visibility !== "list") continue;
      if (model.supported_in_api === false) continue;
      seen.add(slug);
      models.push(slug);
    }
    return models;
  } catch {
    return [];
  }
}

async function readCodexDefaultModel(filePath: string): Promise<string | undefined> {
  try {
    const config = await readFile(filePath, "utf8");
    const match = config.match(/^model\s*=\s*"([^"]+)"/m);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function* runCodexExecStream(input: {
  binaryPath: string;
  homePath: string;
  cwd: string;
  outputPath: string;
  model?: string;
  prompt: string;
  timeoutMs: number;
}): AsyncIterable<LlmStreamChunk> {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--json",
    ...(input.model ? ["--model", input.model] : []),
    "--config",
    'model_reasoning_effort="low"',
    "--output-last-message",
    input.outputPath,
    "-",
  ];
  const child = spawn(input.binaryPath, args, {
    cwd: input.cwd,
    env: { ...process.env, CODEX_HOME: input.homePath },
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let accumulated = "";
  let yielded = false;
  let settled = false;
  const model = input.model ?? "codex-default";
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
  child.stdin.end(input.prompt);

  if (!child.stdout) {
    clearTimeout(timer);
    throw new Error("Codex CLI did not expose stdout.");
  }

  child.stdout.setEncoding("utf8");
  for await (const raw of child.stdout) {
    stdout += String(raw);
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      const event = parseCodexJsonLine(line);
      if (!event) continue;
      const next = extractCodexAssistantText(event);
      if (!next) continue;
      if (next.kind === "delta") {
        accumulated += next.text;
      } else {
        if (accumulated.length > 0 && next.text.startsWith(accumulated)) {
          accumulated = next.text;
        } else if (accumulated.length === 0) {
          accumulated = next.text;
        } else if (next.text !== accumulated) {
          accumulated = next.text;
        }
      }
      yielded = true;
      yield {
        delta: next.kind === "delta" ? next.text : accumulated,
        accumulated,
        done: false,
        model,
      };
    }
  }

  const exitCode = await closePromise;
  settled = true;
  clearTimeout(timer);

  if (exitCode !== 0) {
    const detail = stderr || stdout;
    throw new Error(
      detail
        ? `Codex CLI command failed: ${truncate(detail, 500)}`
        : `Codex CLI command failed with code ${exitCode}.`,
    );
  }

  const finalText = (await readFile(input.outputPath, "utf8").catch(() => "")).trim() || accumulated.trim();
  if (!finalText) {
    throw new Error("Codex CLI returned no final assistant message.");
  }
  yield {
    delta: yielded && finalText.startsWith(accumulated)
      ? finalText.slice(accumulated.length)
      : finalText,
    accumulated: finalText,
    done: true,
    model,
  };
}

function parseCodexJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function extractCodexAssistantText(event: unknown): { kind: "delta" | "message"; text: string } | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";
  const item = record.item && typeof record.item === "object" ? record.item as Record<string, unknown> : undefined;
  const itemType = typeof item?.type === "string" ? item.type : "";

  if (type.includes("delta")) {
    const text = stringField(record, "delta") ?? stringField(record, "text") ?? stringField(item, "delta") ?? stringField(item, "text");
    return text ? { kind: "delta", text } : undefined;
  }
  if (type === "item.completed" && itemType === "agent_message") {
    const text = stringField(item, "text");
    return text ? { kind: "message", text } : undefined;
  }
  if (type.includes("agent_message")) {
    const text = stringField(record, "text") ?? stringField(record, "delta") ?? stringField(item, "text") ?? stringField(item, "delta");
    return text ? { kind: type.includes("delta") ? "delta" : "message", text } : undefined;
  }
  return undefined;
}

function stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function runProcess(input: {
  binaryPath: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs: number;
}): Promise<{ exitCode: number | "spawn-error"; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn(input.binaryPath, input.args, {
      cwd: input.cwd,
      env: { ...process.env, ...input.env },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolveResult({
        exitCode: -1,
        stdout,
        stderr: stderr || `Codex CLI timed out after ${input.timeoutMs}ms.`,
      });
    }, input.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exitCode: "spawn-error", stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ exitCode: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    if (input.stdin !== undefined) {
      child.stdin.end(input.stdin);
    } else {
      child.stdin.end();
    }
  });
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
  return match?.[1] ?? trimmed.split(/\s+/).at(-1);
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
