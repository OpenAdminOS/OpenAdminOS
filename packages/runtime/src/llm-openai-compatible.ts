import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  RunLlmApi,
} from "@openadminos/agent-sdk";

/**
 * A local model server that speaks the OpenAI chat completions API
 * (`GET {endpoint}/models`, `POST {endpoint}/chat/completions`). LM Studio
 * and Lemonade share this adapter; each supplies its name, default
 * endpoint, environment overrides and the copy for its states.
 */
export interface OpenAiCompatibleServer {
  /** Name used in every message, e.g. "LM Studio". */
  name: string;
  defaultEndpoint: string;
  /** Environment variable that overrides the endpoint. */
  endpointEnv: string;
  /** Environment variable that overrides the request timeout in ms. */
  timeoutEnv: string;
  /** Thrown when a request has no model to use. */
  noModelMessage: string;
  /** Probe detail when the server refuses the connection. */
  notRunningDetail: string;
  /** Probe detail when the server runs but lists no usable model. */
  noModelsDetail: string;
  /** Probe detail for an HTTP status, when the server has its own copy for it. */
  httpStatusDetail?: (status: number) => string | undefined;
  /** Keeps the ids of models that can answer a chat. Defaults to every id. */
  chatModelIds?: (data: OpenAiCompatibleModel[]) => string[];
  /**
   * When set, every request first checks the model against a fresh model
   * list, filtered by `chatModelIds`, and refuses an unlisted one with this
   * message (`entry` is the server's record of it, when it has one).
   * Lemonade downloads an unlisted registry model on request and routes
   * cloud models off the device, so it sends only a listed model.
   */
  unlistedModelMessage?: (model: string, entry: OpenAiCompatibleModel | undefined) => string;
  /**
   * Whether a response's `model` field names the model. Lemonade puts the
   * model file path there in streamed chunks, so its responses keep the
   * requested id. Defaults to true.
   */
  streamNamesModel?: boolean;
  /**
   * The message for a request that failed because the prompt did not fit in
   * the context the server loaded the model with, or undefined when the
   * failure is something else. Called with the failed response's body, or
   * the error a streamed or JSON answer carried.
   */
  contextOverflowMessage?: (failure: OpenAiCompatibleFailure) => Promise<string | undefined>;
  /**
   * Whether an `error` field that is a plain string fails the request.
   * LM Studio 0.3.x sends its errors that way. Context overflow errors fail
   * the request for either server. Defaults to false.
   */
  stringErrors?: boolean;
}

export interface OpenAiCompatibleFailure {
  endpoint: string;
  model: string;
  /** What the server said. */
  detail: string;
  /** The caller's token limit for the answer, when it set one. */
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface OpenAiCompatibleModel {
  id?: string;
  labels?: unknown;
  recipe?: unknown;
  downloaded?: unknown;
  /** Lemonade: set on a model it routes to a cloud provider. */
  cloud_provider?: unknown;
}

export interface OpenAiCompatibleProviderOptions {
  endpoint?: string;
  /** Stops the request, for the first-launch scan timeout. */
  signal?: AbortSignal;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface OpenAiCompatibleEndpointTrust {
  endpoint: string;
  isLocal: boolean;
  reason: string;
}

export interface OpenAiCompatibleProbeResult {
  ready: boolean;
  endpoint: string;
  isLocal: boolean;
  models: string[];
  defaultModel?: string;
  status: "connected" | "not-running" | "error";
  detail?: string;
}

interface ModelsResponse {
  data?: OpenAiCompatibleModel[];
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
    delta?: {
      content?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  /** An object in the OpenAI shape; older LM Studio releases send a string. */
  error?: { message?: string; type?: string; code?: string; n_prompt_tokens?: number; n_ctx?: number } | string;
}

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;

export function createOpenAiCompatibleLlm(
  server: OpenAiCompatibleServer,
  options: OpenAiCompatibleProviderOptions = {},
): RunLlmApi {
  const { name } = server;
  const endpoint = resolveOpenAiCompatibleEndpoint(server, options.endpoint);
  const defaultModel = options.defaultModel;
  const timeoutMs =
    options.timeoutMs ??
    Number.parseInt(process.env[server.timeoutEnv] ?? String(DEFAULT_TIMEOUT_MS), 10);
  const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
  const modelsUrl = `${endpoint.replace(/\/$/, "")}/models`;

  const requestError = (error: unknown, target: string, callerSignal: AbortSignal | undefined): Error => {
    if (error instanceof Error && error.name === "AbortError") {
      if (callerSignal?.aborted) {
        return new Error(`${name} request stopped by user.`);
      }
      return new Error(`${name} timed out after ${timeoutMs}ms at ${target}.`);
    }
    return new Error(`${name} not reachable at ${target}: ${describe(error)}`);
  };

  const ensureListed = async (model: string, signal: AbortSignal, callerSignal: AbortSignal | undefined) => {
    if (!server.unlistedModelMessage) return;
    let response: Response;
    try {
      response = await fetchLocal(modelsUrl, { signal });
    } catch (error) {
      throw requestError(error, modelsUrl, callerSignal);
    }
    if (isRefusedRedirect(response, modelsUrl)) throw new Error(redirectRefusedDetail(name, modelsUrl));
    if (!response.ok) {
      throw new Error(
        server.httpStatusDetail?.(response.status) ??
          `${name} responded with HTTP ${response.status} at ${modelsUrl}.`,
      );
    }
    let data: OpenAiCompatibleModel[];
    try {
      const payload = (await response.json()) as ModelsResponse;
      if (!Array.isArray(payload.data)) throw new TypeError("The model list is not an array.");
      data = payload.data;
    } catch (error) {
      // A stopped or timed-out read is that, not a missing model.
      if (error instanceof Error && error.name === "AbortError") throw requestError(error, modelsUrl, callerSignal);
      throw new Error(`${name} answered ${modelsUrl} with a model list OpenAdminOS could not read. Try again.`);
    }
    if ((server.chatModelIds ?? allModelIds)(data).includes(model)) return;
    throw new Error(server.unlistedModelMessage(model, data.find((entry) => entry.id === model)));
  };

  /** The server's own error for a prompt larger than the loaded context, if it is one. */
  const contextOverflow = async (detail: string, model: string, opts: LlmOptions): Promise<Error | undefined> => {
    if (!server.contextOverflowMessage) return undefined;
    const message = await server.contextOverflowMessage({
      endpoint,
      model,
      detail,
      ...(typeof opts.maxTokens === "number" ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (message === undefined) return undefined;
    if (opts.signal?.aborted) return new Error(`${name} request stopped by user.`);
    return new Error(message);
  };

  return {
    available: true,
    defaultModel,
    streamsIncrementally: true,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      const model = opts.model ?? defaultModel;
      if (!model) {
        throw new Error(server.noModelMessage);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      if (opts.signal?.aborted) {
        controller.abort();
      } else {
        opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      }

      let response: Response;
      try {
        await ensureListed(model, controller.signal, opts.signal);
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(createChatRequestBody({ ...opts, model, stream: false })),
            signal: controller.signal,
            redirect: modelServerRedirect(url),
          });
        } catch (error) {
          throw requestError(error, url, opts.signal);
        }
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
      }

      if (isRefusedRedirect(response, url)) throw new Error(redirectRefusedDetail(name, url));
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw (await contextOverflow(detail, model, opts)) ??
          new Error(`${name} responded with HTTP ${response.status}: ${truncate(detail, 200)}`);
      }
      const payload = (await response.json()) as ChatResponse;
      const payloadError = errorMessage(payload, server.stringErrors ?? false);
      if (payloadError) {
        throw (await contextOverflow(payloadError, model, opts)) ?? new Error(`${name} error: ${payloadError}`);
      }
      const text = payload.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error(`${name} returned no content.`);
      }
      const tokenUsage = tokenUsageFrom(payload);
      return {
        text,
        model: (server.streamNamesModel ?? true) ? payload.model ?? model : model,
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const model = opts.model ?? defaultModel;
      if (!model) {
        throw new Error(server.noModelMessage);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      if (opts.signal?.aborted) {
        controller.abort();
      } else {
        opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      }

      let response: Response;
      try {
        await ensureListed(model, controller.signal, opts.signal);
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(createChatRequestBody({ ...opts, model, stream: true })),
            signal: controller.signal,
            redirect: modelServerRedirect(url),
          });
        } catch (error) {
          throw requestError(error, url, opts.signal);
        }
      } catch (error) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        throw error;
      }

      if (!response.ok) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        if (isRefusedRedirect(response, url)) throw new Error(redirectRefusedDetail(name, url));
        const detail = await response.text().catch(() => "");
        throw (await contextOverflow(detail, model, opts)) ??
          new Error(`${name} responded with HTTP ${response.status}: ${truncate(detail, 200)}`);
      }

      if (!response.body) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        throw new Error(`${name} response had no body to stream.`);
      }

      // A server can return a regular JSON error even when streaming was requested.
      if (response.headers.get("content-type")?.includes("application/json")) {
        try {
          const payload = (await response.json()) as ChatResponse;
          const detail = errorMessage(payload, server.stringErrors ?? false);
          if (detail) throw (await contextOverflow(detail, model, opts)) ?? new Error(`${name} error: ${detail}`);
          throw new Error(`${name} returned JSON without a stream. Try again.`);
        } finally {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", abortFromCaller);
        }
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";
      const streamNamesModel = server.streamNamesModel ?? true;
      let actualModel = model;
      let finalTokenUsage: LlmTokenUsage | undefined;

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice("data:".length).trim();
            if (data === "[DONE]") {
              yield {
                delta: "",
                accumulated,
                done: true,
                model: actualModel,
                ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
              };
              return;
            }
            let payload: ChatResponse;
            try {
              payload = JSON.parse(data) as ChatResponse;
            } catch {
              continue;
            }
            const payloadError = errorMessage(payload, server.stringErrors ?? false);
            if (payloadError) {
              throw (await contextOverflow(payloadError, model, opts)) ?? new Error(`${name} error: ${payloadError}`);
            }
            if (streamNamesModel && typeof payload.model === "string" && payload.model.length > 0) {
              actualModel = payload.model;
            }
            const tokenUsage = tokenUsageFrom(payload);
            if (tokenUsage) finalTokenUsage = tokenUsage;
            const delta = payload.choices?.[0]?.delta?.content ?? "";
            if (delta.length === 0) continue;
            accumulated += delta;
            yield {
              delta,
              accumulated,
              done: false,
              model: actualModel,
              ...(tokenUsage ? { tokenUsage } : {}),
            };
          }
        }

        yield {
          delta: "",
          accumulated,
          done: true,
          model: actualModel,
          ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
        };
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        reader.releaseLock();
      }
    },
  };
}

export async function probeOpenAiCompatibleLlm(
  server: OpenAiCompatibleServer,
  options: OpenAiCompatibleProviderOptions = {},
): Promise<OpenAiCompatibleProbeResult> {
  const { name } = server;
  const endpoint = resolveOpenAiCompatibleEndpoint(server, options.endpoint);
  const endpointTrust = classifyOpenAiCompatibleEndpoint(name, endpoint);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  const url = `${endpoint.replace(/\/$/, "")}/models`;

  try {
    const response = await fetchLocal(url, { signal: controller.signal });
    if (isRefusedRedirect(response, url)) {
      return { ready: false, endpoint, isLocal: endpointTrust.isLocal, models: [], status: "error", detail: redirectRefusedDetail(name, url) };
    }
    if (!response.ok) {
      return {
        ready: false,
        endpoint,
        isLocal: endpointTrust.isLocal,
        models: [],
        status: "error",
        detail:
          server.httpStatusDetail?.(response.status) ??
          `${name} responded with HTTP ${response.status}.`,
      };
    }
    const payload = (await response.json()) as ModelsResponse;
    if (payload.data !== undefined && !Array.isArray(payload.data)) {
      throw new TypeError("The model list is not an array.");
    }
    const models = (server.chatModelIds ?? allModelIds)(payload.data ?? []);
    return {
      ready: true,
      endpoint,
      isLocal: endpointTrust.isLocal,
      models,
      defaultModel: models[0],
      status: "connected",
      detail:
        models.length > 0
          ? `${name} server is running on ${endpoint}.`
          : server.noModelsDetail,
    };
  } catch (error) {
    // Only a refused connection means the server is not running. A timeout,
    // a stopped check or an unreadable response is a failed check.
    if (isConnectionRefused(error)) {
      return {
        ready: false,
        endpoint,
        isLocal: endpointTrust.isLocal,
        models: [],
        status: "not-running",
        detail: server.notRunningDetail,
      };
    }
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ready: false,
      endpoint,
      isLocal: endpointTrust.isLocal,
      models: [],
      status: "error",
      detail: aborted
        ? `${name} did not respond within ${timeoutMs}ms.`
        : `${name} answered with a response OpenAdminOS could not read.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveOpenAiCompatibleEndpoint(
  server: Pick<OpenAiCompatibleServer, "defaultEndpoint" | "endpointEnv">,
  endpoint?: string,
): string {
  return (endpoint ?? process.env[server.endpointEnv] ?? server.defaultEndpoint).trim();
}

export function classifyOpenAiCompatibleEndpoint(
  name: string,
  endpoint: string,
): OpenAiCompatibleEndpointTrust {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: `${name} endpoint is empty.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: `${name} endpoint is not a valid URL.`,
    };
  }

  const host = normalizeHost(parsed.hostname);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: `${name} endpoint uses unsupported protocol ${parsed.protocol}`,
    };
  }

  if (host === "localhost" || host === "localhost.") {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: `${name} endpoint uses localhost.`,
    };
  }

  if (isIpv4Loopback(host) || isIpv6Loopback(host)) {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: `${name} endpoint uses a loopback address.`,
    };
  }

  return {
    endpoint: trimmed,
    isLocal: false,
    reason: `${name} endpoint host ${host || "(empty)"} is not loopback.`,
  };
}

function errorMessage(payload: ChatResponse, stringErrors: boolean): string | undefined {
  const { error } = payload;
  if (typeof error === "string") {
    return (stringErrors && error.length > 0) || /exceed_context_size_error|exceeds the available context size|context size has been exceeded/i.test(error) ? error : undefined;
  }
  if (error?.type === "exceed_context_size_error" || error?.code === "exceed_context_size_error") {
    const { message, type, code, n_prompt_tokens, n_ctx } = error;
    return JSON.stringify({ type, code, n_prompt_tokens, n_ctx, message });
  }
  return error?.message || undefined;
}

function allModelIds(data: OpenAiCompatibleModel[]): string[] {
  return data
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function createChatRequestBody(
  opts: LlmOptions & { model: string; stream: boolean },
): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (opts.system) {
    messages.push({ role: "system", content: opts.system });
  }
  messages.push({ role: "user", content: opts.prompt });

  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
    stream: opts.stream,
  };
  if (typeof opts.temperature === "number") {
    body.temperature = opts.temperature;
  }
  if (typeof opts.maxTokens === "number") {
    body.max_tokens = opts.maxTokens;
  }
  return body;
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

function tokenUsageFrom(payload: ChatResponse): LlmTokenUsage | undefined {
  const prompt =
    typeof payload.usage?.prompt_tokens === "number" ? payload.usage.prompt_tokens : undefined;
  const completion =
    typeof payload.usage?.completion_tokens === "number"
      ? payload.usage.completion_tokens
      : undefined;
  const total =
    typeof payload.usage?.total_tokens === "number" ? payload.usage.total_tokens : undefined;
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

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

/**
 * A GET to a local server that retries once when the pooled keep-alive
 * socket it reused had already been closed (`UND_ERR_SOCKET`, "other side
 * closed"). A server stopped after an earlier check leaves that socket in
 * the pool; on Linux the reuse fails before the close is noticed. The
 * retry opens a new connection, which is refused when the server is gone.
 */
export async function fetchLocal(url: string, init: { signal?: AbortSignal } = {}): Promise<Response> {
  const request = { ...init, redirect: modelServerRedirect(url) };
  try {
    return await fetch(url, request);
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    if (code !== "UND_ERR_SOCKET" || init.signal?.aborted) throw error;
    return fetch(url, request);
  }
}

/**
 * A request to a model server on this device never follows a redirect: a
 * loopback server that answers 3xx could otherwise send a model-list read
 * or a prompt to another host. The 3xx answer is returned as it is.
 */
export function modelServerRedirect(url: string): "manual" | "follow" {
  return classifyOpenAiCompatibleEndpoint("Model server", url).isLocal ? "manual" : "follow";
}

/** A model server on this device answered with a redirect, which was not followed. */
export function isRefusedRedirect(response: Response, url: string): boolean {
  return response.status >= 300 && response.status < 400 && modelServerRedirect(url) === "manual";
}

export function redirectRefusedDetail(name: string, url: string): string {
  return `${name} at ${url} answered with a redirect to another address. OpenAdminOS does not follow redirects from a model server on this device, so nothing was sent there.`;
}

const NOT_RUNNING_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH", "ENOTFOUND", "EADDRNOTAVAIL"]);

/**
 * A refused or unreachable loopback connection: the server is not running.
 * `fetch` puts the socket error in `cause`. A host name with both an IPv4
 * and an IPv6 address (`localhost`) fails with an AggregateError of one
 * error per address; it counts only when every address was refused.
 */
export function isConnectionRefused(error: unknown): boolean {
  type Coded = { code?: unknown; cause?: unknown; errors?: unknown };
  const notRunning = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== "object" || depth > 3) return false;
    const { code, cause, errors } = value as Coded;
    if (typeof code === "string" && NOT_RUNNING_CODES.has(code)) return true;
    if (Array.isArray(errors) && errors.length > 0) return errors.every((entry) => notRunning(entry, depth + 1));
    return notRunning(cause, depth + 1);
  };
  return notRunning(error, 0);
}
