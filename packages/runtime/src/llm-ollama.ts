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
  /** How long reading the model's context limit may take (tests). */
  lookupTimeoutMs?: number;
}

interface OllamaChatChunk {
  model?: string;
  message?: {
    content?: string;
    /**
     * Ollama 0.10+ emits reasoning-model chain-of-thought in this
     * separate field. It is never used as the answer; it only tells us
     * the model reasoned without writing one.
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
 * its smaller default between turns. It is dropped when a request that sends
 * it fails with a context overflow or an out-of-memory error.
 */
// TODO(ugur): Should small requests keep sending the raised size (no model
// reload between turns, but the larger context keeps its memory until the
// app restarts), or go back to Ollama's default (saves memory, but the next
// large request reloads the model and retries)? SPEC.md is silent, so the
// raised size is kept for every later request.
const ollamaContextOverrides = new Map<string, number>();

/**
 * How often a context size failed, keyed by endpoint, model and size. A retry
 * keeps its size only if that size has not failed since the retry started, so
 * a retry that finishes late cannot bring back a size a newer request saw fail.
 */
const ollamaContextFailures = new Map<string, number>();
const contextFailureKey = (cacheKey: string, size: number) => `${cacheKey}\0${size}`;

export interface OllamaEndpointTrust {
  endpoint: string;
  isLocal: boolean;
  reason: string;
}

export function createOllamaLlm(options: OllamaProviderOptions = {}): RunLlmApi {
  const endpoint = resolveOllamaEndpoint(options.endpoint);
  const defaultModel = options.defaultModel;
  const lookupTimeoutMs = options.lookupTimeoutMs ?? OLLAMA_SHOW_TIMEOUT_MS;
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

      // Each request to /api/chat gets its own controller and timeout, so a
      // retry is not charged for the time the first request and the model
      // lookup took. A stop from the caller aborts whichever one is running.
      let controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      // How a timeout message names the request that timed out.
      let attemptLabel = "";
      const startAttempt = (label: string) => {
        clearTimeout(timer);
        const current = new AbortController();
        controller = current;
        attemptLabel = label;
        if (opts.signal?.aborted) current.abort();
        else timer = setTimeout(() => current.abort(), timeoutMs);
      };
      const abortFromCaller = () => controller.abort();
      opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
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
      /** The body of a failed response; a stop or timeout while reading it keeps its own message. */
      const errorDetail = async (response: Response): Promise<string> => {
        if (response.ok) return "";
        try {
          return await response.text();
        } catch (error) {
          throw abortError() ?? new Error(`Ollama not reachable at ${url}: ${describe(error)}`);
        }
      };
      const stoppedByUser = () => new Error("Ollama request stopped by user.");
      const abortError = (): Error | undefined => {
        if (!controller.signal.aborted) return undefined;
        return opts.signal?.aborted
          ? stoppedByUser()
          : new Error(`Ollama timed out after ${timeoutMs}ms at ${url}${attemptLabel}.`);
      };

      let response: Response;
      let raisedCtx: number | undefined;
      // Set while the retry runs, so a memory failure can name both sizes.
      let retry: { requested: number; numCtx: number } | undefined;
      let modelMax: number | undefined;
      const cachedCtx = ollamaContextOverrides.get(cacheKey);
      /**
       * Forgets a size the attempt that just failed sent. A failure is
       * evidence only about the size that attempt asked for, at the moment it
       * failed, so it never touches another size, and it forgets this size
       * even when a concurrent request has kept it since.
       */
      const forgetSize = (size: number | undefined) => {
        if (size === undefined) return;
        const failureKey = contextFailureKey(cacheKey, size);
        ollamaContextFailures.set(failureKey, (ollamaContextFailures.get(failureKey) ?? 0) + 1);
        if (ollamaContextOverrides.get(cacheKey) === size) ollamaContextOverrides.delete(cacheKey);
      };
      // The failure count of the retry's size when the retry started.
      let retryFailuresAtStart = 0;
      /**
       * A failure, from an HTTP answer or the stream, that shows the context
       * the running attempt sent did not fit or could not be loaded. Forgets
       * that size and returns the message; undefined for other failures.
       */
      const contextFailure = (text: string, answering: boolean): Error | undefined => {
        const counted = parseContextOverflow(text);
        const memory = isOllamaMemoryError(text);
        if (!counted && !memory && !isOllamaPromptTooLong(text)) return undefined;
        // Ollama still giving all of the size this attempt sent means the
        // prompt outgrew it (Ollama can reject a prompt that exactly fills
        // the context), not that memory ran out; that size stays.
        const sent = retry ? retry.numCtx : cachedCtx;
        const sentSizeGiven = counted !== undefined && sent !== undefined && counted.available >= sent;
        if (!sentSizeGiven) forgetSize(sent);
        if (memory) {
          if (retry) {
            return new Error(
              answering
                ? `Ollama failed partway through an answer from ${model} on the retry with a ${formatTokens(retry.numCtx)} token context size, usually because free memory ran out. Ollama said: ${truncate(text, 200)}`
                : contextMemoryMessage(model, retry.requested, retry.numCtx, text),
            );
          }
          if (cachedCtx !== undefined) return new Error(cachedContextMemoryMessage(model, cachedCtx, text, answering));
          return undefined;
        }
        if (counted) {
          const atModelLimit = modelMax !== undefined && counted.available >= modelMax;
          if (!atModelLimit && sent !== undefined && counted.available >= sent) {
            // Ollama gave all the context asked for; the request outgrew it.
            return new Error(`Ollama context size too small: This request needs ${formatTokens(counted.requested)} tokens of context and did not fit in the ${formatTokens(counted.available)} Ollama loaded for ${model}.`);
          }
          return new Error(contextTooSmallMessage(model, counted.requested, counted.available, atModelLimit));
        }
        return new Error(notFitMessage(model, retry ? { size: retry.numCtx, kept: false } : cachedCtx !== undefined ? { size: cachedCtx, kept: true } : undefined, text));
      };
      try {
        let numCtx = cachedCtx;

        startAttempt(cachedCtx === undefined ? "" : ` with the ${formatTokens(cachedCtx)} token context kept from an earlier request`);
        response = await send(numCtx);
        let detail = await errorDetail(response);
        const overflow = response.status === 400 ? parseContextOverflow(detail) : undefined;
        if (overflow) {
          // Less room than the kept size asked for means Ollama can no longer
          // give it. Otherwise the prompt grew and the kept size stays.
          if (cachedCtx !== undefined && overflow.available < cachedCtx) forgetSize(cachedCtx);
          // The first request's budget ends here; the lookup has its own.
          clearTimeout(timer);
          // Ollama sizes the context from its own default and free memory,
          // not from the model's limit. Ask for enough room for this prompt
          // plus the answer, up to what the model supports, and retry once.
          modelMax = await readOllamaContextLength(endpoint, model, opts.signal ?? new AbortController().signal, lookupTimeoutMs);
          if (opts.signal?.aborted) throw stoppedByUser();
          const wanted = roundUp(overflow.requested + (opts.maxTokens ?? OLLAMA_ANSWER_RESERVE_TOKENS), 1024);
          if (modelMax !== undefined && overflow.requested > modelMax) {
            throw new Error(contextTooSmallMessage(model, overflow.requested, modelMax, true));
          }
          numCtx = modelMax === undefined ? wanted : Math.min(wanted, modelMax);
          retry = { requested: overflow.requested, numCtx };
          retryFailuresAtStart = ollamaContextFailures.get(contextFailureKey(cacheKey, numCtx)) ?? 0;
          startAttempt(` on the retry with a ${formatTokens(numCtx)} token context`);
          response = await send(numCtx);
          detail = await errorDetail(response);
          if (response.ok) raisedCtx = numCtx;
        }
        if (!response.ok) {
          const failed = contextFailure(detail, false);
          if (failed) throw failed;
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
          let read: Awaited<ReturnType<typeof reader.read>>;
          try {
            read = await reader.read();
          } catch (error) {
            // A stop or the deadline mid-stream keeps its own message.
            throw abortError() ?? error;
          }
          const { value, done } = read;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            // A stop while the caller handled the last chunk ends the stream
            // before records that were already buffered.
            const stopped = abortError();
            if (stopped) throw stopped;
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            let chunk: OllamaChatChunk;
            try {
              chunk = JSON.parse(trimmed) as OllamaChatChunk;
            } catch {
              continue;
            }
            if (chunk.error) {
              // Ollama can accept a request and then fail to load the model
              // with its context, or run out of room or memory mid-answer.
              throw contextFailure(errorText(chunk.error), accumulated.length > 0) ?? new Error(`Ollama error: ${chunk.error}`);
            }
            if (
              chunk.done &&
              raisedCtx !== undefined &&
              (ollamaContextFailures.get(contextFailureKey(cacheKey, raisedCtx)) ?? 0) === retryFailuresAtStart
            ) {
              // Kept only once the stream finished cleanly, and before the
              // caller sees the last chunk and may stop reading. Concurrent
              // requests can raise it at once; keep the largest that worked.
              ollamaContextOverrides.set(cacheKey, Math.max(ollamaContextOverrides.get(cacheKey) ?? 0, raisedCtx));
            }
            if (typeof chunk.model === "string" && chunk.model.length > 0) {
              actualModel = chunk.model;
            }
            const tokenUsage = extractTokenUsage(chunk);
            const delta = chunk.message?.content ?? "";
            // Track reasoning-model chain-of-thought separately so a
            // reply with reasoning and no answer fails with that cause.
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
              // Reasoning is not an answer, so it is never returned as one.
              if (accumulated.trim().length === 0 && reasoningOnly.trim().length > 0) {
                throw new Error(reasoningWithoutAnswerMessage(actualModel, chunk.done_reason));
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

/** The failure for a reply that has reasoning and no answer. */
export function reasoningWithoutAnswerMessage(model: string, doneReason: string | undefined): string {
  return doneReason === "length"
    ? `Ollama stopped "${model}" at the token limit while it was still reasoning, so there is no answer. ` +
        "Raise the token limit, shorten the request, or pick a model that answers without reasoning."
    : `Ollama returned only reasoning from "${model}" and no answer. Retry, or pick a model that answers without reasoning.`;
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

/**
 * The model's maximum context length from /api/show. Undefined only when
 * Ollama answered successfully without that metadata; a stop of the caller's signal
 * returns undefined so the caller reports it, and a failed or timed out
 * lookup throws.
 */
async function readOllamaContextLength(
  endpoint: string,
  model: string,
  signal: AbortSignal,
  timeoutMs = OLLAMA_SHOW_TIMEOUT_MS,
): Promise<number | undefined> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const url = `${endpoint.replace(/\/$/, "")}/api/show`;
  const failure = (error: unknown): Error | undefined => {
    if (signal.aborted) return undefined;
    if (timeout.aborted) return new Error(`Ollama did not report the model's context limit within ${timeoutMs}ms at ${url}.`);
    return new Error(`Ollama not reachable at ${url}: ${describe(error)}`);
  };
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.any([signal, timeout]),
      redirect: modelServerRedirect(url),
    });
  } catch (error) {
    const failed = failure(error);
    if (failed) throw failed;
    return undefined;
  }
  if (isRefusedRedirect(response, url)) throw new Error(redirectRefusedDetail("Ollama", url));
  let raw: string;
  try {
    raw = await response.text();
  } catch (error) {
    const failed = failure(error);
    if (failed) throw failed;
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Ollama could not report the model's context limit: HTTP ${response.status} at ${url}: ${truncate(raw, 200)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Ollama could not report the model's context limit: the answer from ${url} was not JSON: ${truncate(raw, 200)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`Ollama could not report the model's context limit: the answer from ${url} was not a JSON object.`);
  }
  const answer = data as { error?: unknown; model_info?: unknown };
  if (answer.error !== undefined) {
    throw new Error(`Ollama could not report the model's context limit: ${url} answered with an error: ${truncate(errorText(answer.error), 200)}`);
  }
  // A valid answer without the metadata leaves the limit unknown.
  if (typeof answer.model_info !== "object" || answer.model_info === null) return undefined;
  for (const [key, value] of Object.entries(answer.model_info as Record<string, unknown>)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value;
  }
  return undefined;
}

/** Readable text for an error field of any shape. */
function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "an unreadable error";
  } catch {
    return "an unreadable error";
  }
}

/**
 * Ollama's out-of-memory wording: the substrings its own classifier uses
 * (llm/status.go outOfMemorySubstrings) plus the scheduler's messages when a
 * model and its context do not fit.
 */
const OLLAMA_MEMORY_ERRORS = [
  "out of memory",
  "out of device memory",
  "cudamalloc failed",
  "hipmalloc failed",
  "failed to allocate",
  "allocation failed",
  "not enough memory",
  "insufficient memory",
  "vk_error_out_of_device_memory",
  "erroroutofmemory",
  "failed to reserve graph",
  "requires more system memory",
  "unable to load full model",
];

/** Ollama's overflow message without token counts (llm/llama_server.go promptTooLongMessage). */
function isOllamaPromptTooLong(detail: string): boolean {
  return detail.toLowerCase().includes("the prompt is longer than the context length currently available");
}

function isOllamaMemoryError(detail: string): boolean {
  const lower = detail.toLowerCase();
  return OLLAMA_MEMORY_ERRORS.some((text) => lower.includes(text));
}

function contextMemoryMessage(model: string, requested: number, numCtx: number, detail: string): string {
  return `Ollama context size too small: This request needs ${requested.toLocaleString("en-US")} tokens of context, but Ollama could not load ${model} with ${numCtx.toLocaleString("en-US")}, usually because free memory ran out. Ollama said: ${truncate(detail, 200)}`;
}

function cachedContextMemoryMessage(model: string, numCtx: number, detail: string, answering = false): string {
  const failed = answering ? "failed partway through an answer from" : "could not load";
  return `Ollama ${failed} ${model} with the ${formatTokens(numCtx)} token context size kept from an earlier request, usually because free memory ran out. Ollama said: ${truncate(detail, 200)}`;
}

function notFitMessage(model: string, sent: { size: number; kept: boolean } | undefined, detail: string): string {
  const where = sent === undefined
    ? `the context Ollama loaded for ${model}`
    : sent.kept
      ? `the ${formatTokens(sent.size)} token context kept from an earlier request`
      : `the ${formatTokens(sent.size)} token context of the retry`;
  return `Ollama context size too small: This request did not fit in ${where}. Ollama said: ${truncate(detail, 200)}`;
}

function formatTokens(value: number): string {
  return value.toLocaleString("en-US");
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
