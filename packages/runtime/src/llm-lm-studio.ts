import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  RunLlmApi,
} from "@openadminos/agent-sdk";

export interface LmStudioProviderOptions {
  endpoint?: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface LmStudioEndpointTrust {
  endpoint: string;
  isLocal: boolean;
  reason: string;
}

export interface LmStudioProbeResult {
  ready: boolean;
  endpoint: string;
  isLocal: boolean;
  models: string[];
  defaultModel?: string;
  status: "connected" | "not-running" | "error";
  detail?: string;
}

interface LmStudioModelsResponse {
  data?: Array<{
    id?: string;
  }>;
}

interface LmStudioChatResponse {
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
  error?: {
    message?: string;
  };
}

const DEFAULT_LM_STUDIO_TIMEOUT_MS = 180_000;
const DEFAULT_LM_STUDIO_ENDPOINT = "http://localhost:1234/v1";

export function createLmStudioLlm(
  options: LmStudioProviderOptions = {},
): RunLlmApi {
  const endpoint = resolveLmStudioEndpoint(options.endpoint);
  const defaultModel = options.defaultModel;
  const timeoutMs =
    options.timeoutMs ??
    Number.parseInt(
      process.env.OPENADMINOS_LM_STUDIO_TIMEOUT_MS ?? String(DEFAULT_LM_STUDIO_TIMEOUT_MS),
      10,
    );

  return {
    available: true,
    defaultModel,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      const model = opts.model ?? defaultModel;
      if (!model) {
        throw new Error(
          "No LM Studio model available. Load a model in LM Studio and start the local server.",
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      if (opts.signal?.aborted) {
        controller.abort();
      } else {
        opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      }

      const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(createChatRequestBody({ ...opts, model, stream: false })),
          signal: controller.signal,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (opts.signal?.aborted) {
            throw new Error("LM Studio request stopped by user.");
          }
          throw new Error(`LM Studio timed out after ${timeoutMs}ms at ${url}.`);
        }
        throw new Error(`LM Studio not reachable at ${url}: ${describe(error)}`);
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(
          `LM Studio responded with HTTP ${response.status}: ${truncate(detail, 200)}`,
        );
      }
      const payload = (await response.json()) as LmStudioChatResponse;
      if (payload.error?.message) {
        throw new Error(`LM Studio error: ${payload.error.message}`);
      }
      const text = payload.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error("LM Studio returned no content.");
      }
      const tokenUsage = tokenUsageFromLmStudio(payload);
      return {
        text,
        model: payload.model ?? model,
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      const model = opts.model ?? defaultModel;
      if (!model) {
        throw new Error(
          "No LM Studio model available. Load a model in LM Studio and start the local server.",
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const abortFromCaller = () => controller.abort();
      if (opts.signal?.aborted) {
        controller.abort();
      } else {
        opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
      }

      const url = `${endpoint.replace(/\/$/, "")}/chat/completions`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(createChatRequestBody({ ...opts, model, stream: true })),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        if (error instanceof Error && error.name === "AbortError") {
          if (opts.signal?.aborted) {
            throw new Error("LM Studio request stopped by user.");
          }
          throw new Error(`LM Studio timed out after ${timeoutMs}ms at ${url}.`);
        }
        throw new Error(`LM Studio not reachable at ${url}: ${describe(error)}`);
      }

      if (!response.ok) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        const detail = await response.text().catch(() => "");
        throw new Error(`LM Studio responded with HTTP ${response.status}: ${truncate(detail, 200)}`);
      }

      if (!response.body) {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", abortFromCaller);
        throw new Error("LM Studio response had no body to stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";
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
            let payload: LmStudioChatResponse;
            try {
              payload = JSON.parse(data) as LmStudioChatResponse;
            } catch {
              continue;
            }
            if (payload.error?.message) {
              throw new Error(`LM Studio error: ${payload.error.message}`);
            }
            if (typeof payload.model === "string" && payload.model.length > 0) {
              actualModel = payload.model;
            }
            const tokenUsage = tokenUsageFromLmStudio(payload);
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

export async function probeLmStudioLlm(
  options: LmStudioProviderOptions = {},
): Promise<LmStudioProbeResult> {
  const endpoint = resolveLmStudioEndpoint(options.endpoint);
  const endpointTrust = classifyLmStudioEndpoint(endpoint);
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 1_500;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${endpoint.replace(/\/$/, "")}/models`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        ready: false,
        endpoint,
        isLocal: endpointTrust.isLocal,
        models: [],
        status: "error",
        detail: `LM Studio responded with HTTP ${response.status}.`,
      };
    }
    const payload = (await response.json()) as LmStudioModelsResponse;
    const models =
      payload.data
        ?.map((model) => model.id)
        .filter((id): id is string => Boolean(id)) ?? [];
    return {
      ready: true,
      endpoint,
      isLocal: endpointTrust.isLocal,
      models,
      defaultModel: models[0],
      status: "connected",
      detail:
        models.length > 0
          ? `LM Studio server is running on ${endpoint}.`
          : "LM Studio server is running but no models are loaded.",
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ready: false,
      endpoint,
      isLocal: endpointTrust.isLocal,
      models: [],
      status: "not-running",
      detail: aborted
        ? `LM Studio did not respond within ${timeoutMs}ms.`
        : "LM Studio isn't running or the local server is off. Start the server from LM Studio's Developer tab, then try again.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveLmStudioEndpoint(endpoint?: string): string {
  return (
    endpoint ??
    process.env.OPENADMINOS_LM_STUDIO_URL ??
    DEFAULT_LM_STUDIO_ENDPOINT
  ).trim();
}

export function classifyLmStudioEndpoint(endpoint: string): LmStudioEndpointTrust {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: "LM Studio endpoint is empty.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: "LM Studio endpoint is not a valid URL.",
    };
  }

  const host = normalizeHost(parsed.hostname);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      endpoint: trimmed,
      isLocal: false,
      reason: `LM Studio endpoint uses unsupported protocol ${parsed.protocol}`,
    };
  }

  if (host === "localhost" || host === "localhost.") {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "LM Studio endpoint uses localhost.",
    };
  }

  if (isIpv4Loopback(host) || isIpv6Loopback(host)) {
    return {
      endpoint: trimmed,
      isLocal: true,
      reason: "LM Studio endpoint uses a loopback address.",
    };
  }

  return {
    endpoint: trimmed,
    isLocal: false,
    reason: `LM Studio endpoint host ${host || "(empty)"} is not loopback.`,
  };
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

function tokenUsageFromLmStudio(payload: LmStudioChatResponse): LlmTokenUsage | undefined {
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
