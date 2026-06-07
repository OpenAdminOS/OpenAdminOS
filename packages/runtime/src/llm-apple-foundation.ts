import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  RunLlmApi,
} from "@openadminos/agent-sdk";

export interface AppleFoundationProviderOptions {
  helperPath?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface AppleFoundationProbeResult {
  installed: boolean;
  ready: boolean;
  helperPath?: string;
  models: string[];
  defaultModel?: string;
  contextSize?: number;
  supportedLanguages?: string[];
  detail?: string;
}

interface AppleFoundationRequest {
  command: "probe" | "stream";
  system?: string;
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
}

interface AppleFoundationLine {
  ok?: boolean;
  type?: "chunk" | "error";
  ready?: boolean;
  detail?: string;
  error?: string;
  model?: string;
  models?: string[];
  defaultModel?: string;
  contextSize?: number;
  supportedLanguages?: string[];
  delta?: string;
  accumulated?: string;
  done?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;
export const APPLE_FOUNDATION_MODEL_ID = "system-language-model";
const HELPER_BINARY_NAME = "openadminos-apple-foundation-helper";
const APPLE_FOUNDATION_ENV_ALLOWLIST = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "TMPDIR",
  "USER",
]);

export function createAppleFoundationLlm(
  options: AppleFoundationProviderOptions = {},
): RunLlmApi {
  const defaultModel = options.defaultModel ?? APPLE_FOUNDATION_MODEL_ID;
  const configuredTimeout = Number.parseInt(
    process.env.OPENADMINOS_APPLE_FOUNDATION_TIMEOUT_MS ?? "",
    10,
  );
  const timeoutMs =
    options.timeoutMs ??
    (Number.isFinite(configuredTimeout) ? configuredTimeout : DEFAULT_TIMEOUT_MS);
  let helperPathPromise: Promise<string> | undefined;
  const getHelperPath = () =>
    (helperPathPromise ??= resolveAppleFoundationHelper(options.helperPath));

  return {
    available: true,
    defaultModel,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      let last: LlmStreamChunk | undefined;
      for await (const chunk of this.stream(opts)) {
        last = chunk;
      }
      if (!last) {
        throw new Error("Apple Foundation returned no content.");
      }
      return {
        text: last.accumulated,
        model: last.model,
        ...(last.tokenUsage ? { tokenUsage: last.tokenUsage } : {}),
      };
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const model = opts.model ?? defaultModel;
      if (model !== APPLE_FOUNDATION_MODEL_ID) {
        throw new Error(
          `Apple Foundation only exposes the system language model (${APPLE_FOUNDATION_MODEL_ID}).`,
        );
      }
      const helperPath = await getHelperPath();
      yield* runAppleFoundationStream({
        helperPath,
        request: {
          command: "stream",
          system: opts.system,
          prompt: opts.prompt,
          temperature: opts.temperature,
          maxTokens: opts.maxTokens,
        },
        timeoutMs,
        signal: opts.signal,
      });
    },
  };
}

export async function probeAppleFoundationLlm(
  options: AppleFoundationProviderOptions = {},
): Promise<AppleFoundationProbeResult> {
  if (process.platform !== "darwin") {
    return {
      installed: false,
      ready: false,
      models: [],
      detail: "Apple Foundation is available only on macOS.",
    };
  }

  let helperPath: string;
  try {
    helperPath = await resolveAppleFoundationHelper(options.helperPath);
  } catch (error) {
    return {
      installed: false,
      ready: false,
      models: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const response = await runAppleFoundationProbe({
      helperPath,
      timeoutMs: options.timeoutMs ?? 10_000,
    });
    const ready = response.ready === true;
    const models =
      response.models?.filter((model): model is string => typeof model === "string") ??
      (ready ? [APPLE_FOUNDATION_MODEL_ID] : []);
    const defaultModel =
      typeof response.defaultModel === "string"
        ? response.defaultModel
        : ready
          ? APPLE_FOUNDATION_MODEL_ID
          : undefined;
    const contextSize =
      typeof response.contextSize === "number" && Number.isFinite(response.contextSize)
        ? response.contextSize
        : undefined;
    const supportedLanguages =
      response.supportedLanguages?.filter(
        (language): language is string => typeof language === "string" && language.length > 0,
      ) ?? undefined;
    return {
      installed: true,
      ready,
      helperPath,
      models,
      ...(defaultModel ? { defaultModel } : {}),
      ...(contextSize !== undefined ? { contextSize } : {}),
      ...(supportedLanguages && supportedLanguages.length > 0 ? { supportedLanguages } : {}),
      detail: response.detail,
    };
  } catch (error) {
    return {
      installed: true,
      ready: false,
      helperPath,
      models: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createAppleFoundationProcessEnv(input: {
  source?: NodeJS.ProcessEnv;
} = {}): NodeJS.ProcessEnv {
  const source = input.source ?? process.env;
  const env: NodeJS.ProcessEnv = {};

  for (const key of APPLE_FOUNDATION_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

export async function resolveAppleFoundationHelper(
  preferredHelperPath?: string,
): Promise<string> {
  for (const candidate of listAppleFoundationHelperCandidates(preferredHelperPath)) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Apple Foundation helper is not built. Run `npm run build:apple-foundation-helper -w @openadminos/desktop` on a compatible Mac.",
  );
}

export function listAppleFoundationHelperCandidates(preferredHelperPath?: string): string[] {
  const candidates: string[] = [];
  if (preferredHelperPath) candidates.push(preferredHelperPath);
  if (process.env.OPENADMINOS_APPLE_FOUNDATION_HELPER) {
    candidates.push(process.env.OPENADMINOS_APPLE_FOUNDATION_HELPER);
  }
  const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
  if (typeof electronProcess.resourcesPath === "string") {
    candidates.push(
      join(
        electronProcess.resourcesPath,
        "native",
        "apple-foundation-helper",
        HELPER_BINARY_NAME,
      ),
    );
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  candidates.push(
    resolve(
      process.cwd(),
      "electron/native/apple-foundation-helper",
      HELPER_BINARY_NAME,
    ),
    resolve(
      process.cwd(),
      "apps/desktop/electron/native/apple-foundation-helper",
      HELPER_BINARY_NAME,
    ),
    resolve(
      moduleDir,
      "../../../apps/desktop/electron/native/apple-foundation-helper",
      HELPER_BINARY_NAME,
    ),
    resolve(moduleDir, "../native/apple-foundation-helper/.build/release", HELPER_BINARY_NAME),
    resolve(moduleDir, "../../native/apple-foundation-helper/.build/release", HELPER_BINARY_NAME),
  );

  return [...new Set(candidates)];
}

async function runAppleFoundationProbe(input: {
  helperPath: string;
  timeoutMs: number;
}): Promise<AppleFoundationLine> {
  const lines: AppleFoundationLine[] = [];
  for await (const line of runAppleFoundationProcess({
    helperPath: input.helperPath,
    request: { command: "probe" },
    timeoutMs: input.timeoutMs,
  })) {
    lines.push(line);
  }
  const response = lines.at(-1);
  if (!response) {
    throw new Error("Apple Foundation helper returned no probe response.");
  }
  if (response.ok === false) {
    throw new Error(response.error ?? "Apple Foundation probe failed.");
  }
  return response;
}

async function* runAppleFoundationStream(input: {
  helperPath: string;
  request: AppleFoundationRequest;
  timeoutMs: number;
  signal?: AbortSignal;
}): AsyncIterable<LlmStreamChunk> {
  let sawChunk = false;
  for await (const line of runAppleFoundationProcess(input)) {
    if (line.type === "error" || line.ok === false) {
      throw new Error(line.error ?? "Apple Foundation generation failed.");
    }
    if (line.type !== "chunk") continue;
    sawChunk = true;
    const tokenUsage = tokenUsageFromLine(line);
    yield {
      delta: line.delta ?? "",
      accumulated: line.accumulated ?? "",
      done: line.done === true,
      model: line.model ?? APPLE_FOUNDATION_MODEL_ID,
      ...(tokenUsage ? { tokenUsage } : {}),
    };
  }
  if (!sawChunk) {
    throw new Error("Apple Foundation helper returned no stream chunks.");
  }
}

function tokenUsageFromLine(
  line: AppleFoundationLine,
): LlmStreamChunk["tokenUsage"] | undefined {
  const promptTokens =
    typeof line.promptTokens === "number" && Number.isFinite(line.promptTokens)
      ? line.promptTokens
      : undefined;
  const completionTokens =
    typeof line.completionTokens === "number" && Number.isFinite(line.completionTokens)
      ? line.completionTokens
      : undefined;
  const totalTokens =
    typeof line.totalTokens === "number" && Number.isFinite(line.totalTokens)
      ? line.totalTokens
      : undefined;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

async function* runAppleFoundationProcess(input: {
  helperPath: string;
  request: AppleFoundationRequest;
  timeoutMs: number;
  signal?: AbortSignal;
}): AsyncIterable<AppleFoundationLine> {
  const child = spawn(input.helperPath, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: createAppleFoundationProcessEnv(),
  });
  const stderr: Buffer[] = [];
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, input.timeoutMs);
  const abortFromCaller = () => child.kill("SIGTERM");
  if (input.signal?.aborted) {
    abortFromCaller();
  } else {
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolveClose, rejectClose) => {
      child.once("error", rejectClose);
      child.once("close", (code, signal) => resolveClose({ code, signal }));
    },
  );

  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });
  child.stdin.end(`${JSON.stringify(input.request)}\n`);

  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk as Buffer, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const parsed = parseAppleFoundationLine(line);
        if (parsed) yield parsed;
      }
    }
    if (buffer.trim().length > 0) {
      const parsed = parseAppleFoundationLine(buffer);
      if (parsed) yield parsed;
    }

    const { code, signal } = await closePromise;
    if (input.signal?.aborted) {
      throw new Error("Apple Foundation request stopped by user.");
    }
    if (timedOut) {
      throw new Error(`Apple Foundation timed out after ${input.timeoutMs}ms.`);
    }
    if (code !== 0) {
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      throw new Error(
        detail ||
          `Apple Foundation helper exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
      );
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseAppleFoundationLine(line: string): AppleFoundationLine | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed) as AppleFoundationLine;
  } catch {
    return {
      ok: false,
      type: "error",
      error: `Apple Foundation helper returned invalid JSON: ${trimmed.slice(0, 200)}`,
    };
  }
}
