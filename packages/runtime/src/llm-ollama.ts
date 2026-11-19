import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  RunLlmApi,
} from "@openadminos/agent-sdk";
import { isRefusedRedirect, modelServerRedirect, redirectRefusedDetail } from "./llm-openai-compatible.js";

export interface OllamaProviderOptions {
  endpoint?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

interface OllamaChatChunk {
  model?: string;
  message?: {
    content?: string;
    /**
     * Ollama 0.10+ emits reasoning-model chain-of-thought in this
     * separate field. It is never used as the answer; it only tells us
     * the model ran out of tokens while reasoning.
     */
    thinking?: string;
  };
  done?: boolean;
  done_reason?: string;
  error?: string;
  /** Tokens consumed parsing the prompt + system message. */
  prompt_eval_count?: number;
  /** Tokens generated in the response. */
  eval_count?: number;
}

const DEFAULT_OLLAMA_TIMEOUT_MS = 180_000;
const DEFAULT_OLLAMA_ENDPOINT = "http://127.0.0.1:11434";
/** Room left for the answer when the caller sets no token limit. */
const OLLAMA_ANSWER_RESERVE_TOKENS = 4096;
const OLLAMA_SHOW_TIMEOUT_MS = 5000;

/**
 * The context size this app raised for a model, keyed by endpoint and model.
 * Later requests keep sending it so Ollama does not reload the model with
 * its smaller default between turns.
 */
const ollamaContextOverrides = new Map<string, number>();

export interface OllamaEndpointTrust {
  endpoint: string;
  isLocal: boolean;
  reason: string;
}

export function createOllamaLlm(options: OllamaProviderOptions = {}): RunLlmApi {
  const endpoint = resolveOllamaEndpoint(options.endpoint);
  const defaultModel = options.defaultModel;
  const timeoutMs =
    options.timeoutMs ??
    Number.parseInt(
      process.env.OPENAGENTS_OLLAMA_TIMEOUT_MS ?? String(DEFAULT_OLLAMA_TIMEOUT_MS),
      10,
    );

  return {
    available: true,
    defaultModel,
    streamsIncrementally: true,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      let last: LlmStreamChunk | undefined;
      for await (const chunk of this.stream(opts)) {
        last = chunk;
      }
      if (!last) {
        throw new Error("Ollama returned no content.");
      }
      return {
        text: last.accumulated,
        model: last.model,
        ...(last.tokenUsage ? { tokenUsage: last.tokenUsage } : {}),
      };
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const model = opts.model ?? defaultModel;
      if (!model) {
        throw new Error("No Ollama model available. Pull a model with `ollama pull <model>`.");
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      if (opts.signal?.aborted) {
        controller.abort();
      } else {
        opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      }
      const url = `${endpoint.replace(/\/$/, "")}/api/chat`;

      const messages: { role: string; content: string }[] = [];
      if (opts.system) {
        messages.push({ role: "system", content: opts.system });
      }
      messages.push({ role: "user", content: opts.prompt });

      const body: Record<string, unknown> = {
        model,
        messages,
        stream: true,
        // Ask Ollama to skip reasoning-model "thinking" mode and have
        // the model produce its answer directly, so the model does not
        // spend its token budget inside a hidden chain-of-thought.
        // gpt-oss ignores `false` and always reasons, so it gets the
        // lowest effort level instead.
        think: ollamaThinkSetting(model),
      };
      const optionsPayload: Record<string, number> = {};
      if (typeof opts.temperature === "number") {
        optionsPayload.temperature = opts.temperature;
      }
      if (typeof opts.maxTokens === "number") {
        optionsPayload.num_predict = opts.maxTokens;
      }
      if (Object.keys(optionsPayload).length > 0) {
        body.options = optionsPayload;
      }

      const cacheKey = `${endpoint}\0${model}`;
      const send = async (numCtx: number | undefined): Promise<Response> => {
        const payload = numCtx === undefined ? body : { ...body, options: { ...optionsPayload, num_ctx: numCtx } };
        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
            redirect: modelServerRedirect(url),
          });
        } catch (error) {
          throw abortError() ?? new Error(`Ollama not reachable at ${url}: ${describe(error)}`);
        }
        if (isRefusedRedirect(response, url)) throw new Error(redirectRefusedDetail("Ollama", url));
        return response;
      };
      const abortError = (): Error | undefined => {
        if (!controller.signal.aborted) return undefined;
        return opts.signal?.aborted
          ? new Error("Ollama request stopped by user.")
          : new Error(`Ollama timed out after ${timeoutMs}ms at ${url}.`);
      };

      let response: Response;
      try {
        let numCtx = ollamaContextOverrides.get(cacheKey);
        response = await send(numCtx);
        let detail = response.ok ? "" : await response.text().catch(() => "");
        const overflow = response.status === 400 ? parseContextOverflow(detail) : undefined;
        if (overflow) {
          // Ollama sizes the context from its own default and free memory,
          // not from the model's limit. Ask for enough room for this prompt
          // plus the answer, up to what the model supports, and retry once.
          const modelMax = await readOllamaContextLength(endpoint, model, controller.signal);
          const stopped = abortError();
          if (stopped) throw stopped;
          const wanted = roundUp(overflow.requested + (opts.maxTokens ?? OLLAMA_ANSWER_RESERVE_TOKENS), 1024);
          const target = modelMax === undefined ? wanted : Math.min(wanted, modelMax);
          if (target <= Math.max(overflow.available, overflow.requested)) {
            throw new Error(contextTooSmallMessage(model, overflow.requested, modelMax ?? overflow.available, true));
          }
          numCtx = target;
          response = await send(numCtx);
          detail = response.ok ? "" : await response.text().catch(() => "");
          const retryOverflow = response.status === 400 ? parseContextOverflow(detail) : undefined;
          if (retryOverflow) {
            throw new Error(contextTooSmallMessage(model, retryOverflow.requested, retryOverflow.available, false));
          }
          if (response.ok) ollamaContextOverrides.set(cacheKey, numCtx);
        }
        if (!response.ok) {
          if (response.status === 404 && detail.toLowerCase().includes("model")) {
            throw new Error(
              `Ollama model "${model}" is not pulled. Run \`ollama pull ${model}\`.`,
            );
          }
          throw new Error(`Ollama responded with HTTP ${response.status}: ${truncate(detail, 200)}`);
        }
      } catch (error) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        throw error;
      }

      if (!response.body) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        throw new Error("Ollama response had no body to stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";
      let reasoningOnly = "";
      let actualModel = model;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            let chunk: OllamaChatChunk;
            try {
              chunk = JSON.parse(trimmed) as OllamaChatChunk;
            } catch {
              continue;
            }
            if (chunk.error) {
              throw new Error(`Ollama error: ${chunk.error}`);
            }
            if (typeof chunk.model === "string" && chunk.model.length > 0) {
              actualModel = chunk.model;
            }
            const tokenUsage = extractTokenUsage(chunk);
            const delta = chunk.message?.content ?? "";
            // Track reasoning-model chain-of-thought separately so an
            // empty answer can be reported as a reasoning overrun.
            const reasoningDelta = chunk.message?.thinking ?? "";
            if (reasoningDelta.length > 0) {
              reasoningOnly += reasoningDelta;
            }
            if (delta.length > 0) {
              accumulated += delta;
              yield {
                delta,
                accumulated,
                done: Boolean(chunk.done),
                model: actualModel,
                ...(tokenUsage ? { tokenUsage } : {}),
              };
            }
            if (chunk.done) {
              // A model that hit num_predict while still reasoning has no
              // answer. Its reasoning is not one, so never return it.
              if (accumulated.length === 0 && reasoningOnly.length > 0) {
                throw new Error(
                  `Ollama model "${actualModel}" used its whole token budget on reasoning and wrote no answer. ` +
                    "Raise the step's maxTokens or pick a model that answers without reasoning.",
                );
              }
              if (delta.length === 0) {
                yield {
                  delta: "",
                  accumulated,
                  done: true,
                  model: actualModel,
                  ...(tokenUsage ? { tokenUsage } : {}),
                };
              }
              return;
            }
          }
        }
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        reader.releaseLock();
      }
    },
  };
}

/**
 * Ollama's `think` value for a model. gpt-oss cannot turn reasoning off and
 * ignores `false`, so it gets the lowest effort level.
 */
export function ollamaThinkSetting(model: string): false | "low" {
  return /(^|\/)gpt-oss([:-]|$)/i.test(model) ? "low" : false;
}

export function resolveOllamaEndpoint(endpoint?: string): string {
  return (endpoint ?? ollamaEndpointOverride() ?? DEFAULT_OLLAMA_ENDPOINT).trim();
}

/** The non-default endpoint configured for this device, if any. */
export function ollamaEndpointOverride(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.OPENAGENTS_OLLAMA_URL ?? ollamaHostEndpoint(env.OLLAMA_HOST);
}

/**
 * Read Ollama's own OLLAMA_HOST setting the way the Ollama client does, so a
 * server moved to another port is still found. A wildcard bind address
 * (0.0.0.0 or ::) is reached through loopback. Returns undefined when unset
 * or when it names the default endpoint.
 */
export function ollamaHostEndpoint(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let scheme = "http";
  let hostport = raw;
  let defaultPort = "11434";
  const separator = raw.indexOf("://");
  if (separator >= 0) {
    scheme = raw.slice(0, separator).toLowerCase();
    hostport = raw.slice(separator + 3);
    if (scheme === "http") defaultPort = "80";
    else if (scheme === "https") defaultPort = "443";
    else return undefined;
  }
  hostport = hostport.split("/")[0]!;
  let host = hostport;
  let port = defaultPort;
  const bracketed = /^\[([^\]]*)\](?::(\d*))?$/.exec(hostport);
  if (bracketed) {
    host = bracketed[1]!;
    port = bracketed[2] || defaultPort;
  } else if (hostport.split(":").length === 2) {
    [host, port] = hostport.split(":") as [string, string];
    port ||= defaultPort;
  }
  if (!host || host === "0.0.0.0" || host === "::") host = "127.0.0.1";
  const endpoint = `${scheme}://${host.includes(":") ? `[${host}]` : host}:${port}`;
  return endpoint === DEFAULT_OLLAMA_ENDPOINT ? undefined : endpoint;
}

export function classifyOllamaEndpoint(endpoint: string): OllamaEndpointTrust {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: "Ollama endpoint is empty.",
    };
  }

  if (/^(unix|http\+unix):/i.test(trimmed)) {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "Ollama endpoint uses a local Unix socket.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: "Ollama endpoint is not a valid URL.",
    };
  }

  const host = normalizeHost(parsed.hostname);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: `Ollama endpoint uses unsupported protocol ${parsed.protocol}`,
    };
  }

  if (host === "localhost" || host === "localhost.") {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "Ollama endpoint uses localhost.",
    };
  }

  if (isIpv4Loopback(host) || isIpv6Loopback(host)) {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "Ollama endpoint uses a loopback address.",
    };
  }

  return {
    endpoint: trimmed,
    isLocal: false,
    reason: `Ollama endpoint host ${host || "(empty)"} is not loopback.`,
  };
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isIpv4Loopback(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 10);
  });
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

function isIpv6Loopback(host: string): boolean {
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  const dottedMapped = host.match(/^::ffff:(127(?:\.\d{1,3}){3})$/);
  if (dottedMapped) return isIpv4Loopback(dottedMapped[1] ?? "");
  const hexMapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexMapped) return false;
  const high = Number.parseInt(hexMapped[1] ?? "", 16);
  const low = Number.parseInt(hexMapped[2] ?? "", 16);
  if (!Number.isInteger(high) || !Number.isInteger(low)) return false;
  const ipv4 = [
    (high >> 8) & 255,
    high & 255,
    (low >> 8) & 255,
    low & 255,
  ].join(".");
  return isIpv4Loopback(ipv4);
}

export const noopLlm: RunLlmApi = {
  available: false,
  async complete(): Promise<LlmCompletion> {
    throw new Error("No LLM provider is configured for this run.");
  },
  async *stream(): AsyncIterable<LlmStreamChunk> {
    throw new Error("No LLM provider is configured for this run.");
  },
};

function extractTokenUsage(chunk: OllamaChatChunk): LlmTokenUsage | undefined {
  const prompt = typeof chunk.prompt_eval_count === "number" ? chunk.prompt_eval_count : undefined;
  const completion = typeof chunk.eval_count === "number" ? chunk.eval_count : undefined;
  if (prompt === undefined && completion === undefined) return undefined;
  const usage: LlmTokenUsage = {};
  if (prompt !== undefined) usage.promptTokens = prompt;
  if (completion !== undefined) usage.completionTokens = completion;
  if (prompt !== undefined && completion !== undefined) {
    usage.totalTokens = prompt + completion;
  }
  return usage;
}

/** Reads Ollama's "request (N tokens) exceeds the available context size (M tokens)" error. */
export function parseContextOverflow(detail: string): { requested: number; available: number } | undefined {
  const match = /request \((\d+) tokens?\) exceeds the available context size \((\d+) tokens?\)/i.exec(detail);
  if (!match) return undefined;
  return { requested: Number(match[1]), available: Number(match[2]) };
}

/** The model's maximum context length from /api/show, if Ollama reports it. */
async function readOllamaContextLength(endpoint: string, model: string, signal: AbortSignal): Promise<number | undefined> {
  const timeout = AbortSignal.timeout(OLLAMA_SHOW_TIMEOUT_MS);
  const url = `${endpoint.replace(/\/$/, "")}/api/show`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.any([signal, timeout]),
      redirect: modelServerRedirect(url),
    });
    if (!response.ok) return undefined;
    const data = (await response.json()) as { model_info?: Record<string, unknown> };
    for (const [key, value] of Object.entries(data.model_info ?? {})) {
      if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value;
    }
    return undefined;
  } catch {
    // The caller checks its own signal for a stop or timeout.
    return undefined;
  }
}

function contextTooSmallMessage(model: string, requested: number, limit: number, modelLimit: boolean): string {
  const needs = `This request needs ${requested.toLocaleString("en-US")} tokens of context`;
  return modelLimit
    ? `Ollama context size too small: ${needs}, but ${model} supports at most ${limit.toLocaleString("en-US")}.`
    : `Ollama context size too small: ${needs}, but Ollama could only give ${model} ${limit.toLocaleString("en-US")}, usually because free memory ran out.`;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
