import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  RunLlmApi,
} from "@openadminos/agent-sdk";

export interface AzureOpenAiProviderOptions {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string;
  defaultModel?: string;
  timeoutMs?: number;
}

export interface AzureOpenAiProbeResult {
  ready: boolean;
  endpoint: string;
  deployment: string;
  apiVersion: string;
  model: string;
  status: "connected" | "error";
  detail: string;
  durationMs?: number;
}

interface AzureOpenAiChatResponse {
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

const DEFAULT_AZURE_OPENAI_TIMEOUT_MS = 180_000;

export function createAzureOpenAiLlm(
  options: AzureOpenAiProviderOptions,
): RunLlmApi {
  const endpoint = options.endpoint.trim();
  const deployment = options.deployment.trim();
  const apiVersion = options.apiVersion.trim();
  const apiKey = options.apiKey.trim();
  const defaultModel = options.defaultModel ?? deployment;
  const timeoutMs =
    options.timeoutMs ??
    Number.parseInt(
      process.env.OPENADMINOS_AZURE_OPENAI_TIMEOUT_MS ??
        String(DEFAULT_AZURE_OPENAI_TIMEOUT_MS),
      10,
    );

  return {
    available: Boolean(endpoint && deployment && apiVersion && apiKey),
    defaultModel,
    async complete(opts: LlmOptions): Promise<LlmCompletion> {
      assertConfigured({ endpoint, deployment, apiVersion, apiKey });
      const url = buildChatCompletionsUrl({ endpoint, deployment, apiVersion });
      const response = await postAzureChatCompletion({
        url,
        apiKey,
        timeoutMs,
        opts,
        stream: false,
      });
      const payload = (await response.json()) as AzureOpenAiChatResponse;
      if (payload.error?.message) {
        throw new Error(`Azure OpenAI error: ${payload.error.message}`);
      }
      const text = payload.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error("Azure OpenAI returned no content.");
      }
      const tokenUsage = tokenUsageFromAzureOpenAi(payload);
      return {
        text,
        model: deployment,
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    },
    async *stream(opts: LlmOptions): AsyncIterable<LlmStreamChunk> {
      assertConfigured({ endpoint, deployment, apiVersion, apiKey });
      const url = buildChatCompletionsUrl({ endpoint, deployment, apiVersion });
      const response = await postAzureChatCompletion({
        url,
        apiKey,
        timeoutMs,
        opts,
        stream: true,
      });

      if (!response.body) {
        throw new Error("Azure OpenAI response had no body to stream.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";
      let accumulated = "";
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
                model: deployment,
                ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
              };
              return;
            }
            let payload: AzureOpenAiChatResponse;
            try {
              payload = JSON.parse(data) as AzureOpenAiChatResponse;
            } catch {
              continue;
            }
            if (payload.error?.message) {
              throw new Error(`Azure OpenAI error: ${payload.error.message}`);
            }
            const tokenUsage = tokenUsageFromAzureOpenAi(payload);
            if (tokenUsage) finalTokenUsage = tokenUsage;
            const delta = payload.choices?.[0]?.delta?.content ?? "";
            if (delta.length === 0) continue;
            accumulated += delta;
            yield {
              delta,
              accumulated,
              done: false,
              model: deployment,
              ...(tokenUsage ? { tokenUsage } : {}),
            };
          }
        }

        yield {
          delta: "",
          accumulated,
          done: true,
          model: deployment,
          ...(finalTokenUsage ? { tokenUsage: finalTokenUsage } : {}),
        };
      } finally {
        reader.releaseLock();
      }
    },
  };
}

export async function probeAzureOpenAi(
  options: AzureOpenAiProviderOptions,
): Promise<AzureOpenAiProbeResult> {
  const startedAt = Date.now();
  const model = options.defaultModel ?? options.deployment.trim();
  try {
    const completion = await createAzureOpenAiLlm(options).complete({
      prompt: "Reply with exactly: OK",
      maxTokens: 1,
    });
    return {
      ready: true,
      endpoint: options.endpoint.trim(),
      deployment: options.deployment.trim(),
      apiVersion: options.apiVersion.trim(),
      model: completion.model || model,
      status: "connected",
      detail: "Azure OpenAI returned a minimal chat completion.",
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      ready: false,
      endpoint: options.endpoint.trim(),
      deployment: options.deployment.trim(),
      apiVersion: options.apiVersion.trim(),
      model,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}

function assertConfigured(input: {
  endpoint: string;
  deployment: string;
  apiVersion: string;
  apiKey: string;
}): void {
  if (!input.endpoint || !input.deployment || !input.apiVersion || !input.apiKey) {
    throw new Error(
      "Azure OpenAI is not configured. Add your endpoint, deployment, API version, and key in Settings.",
    );
  }
}

function buildChatCompletionsUrl(input: {
  endpoint: string;
  deployment: string;
  apiVersion: string;
}): string {
  let base: URL;
  try {
    base = new URL(input.endpoint.trim().replace(/\/+$/, ""));
  } catch {
    throw new Error("Azure OpenAI endpoint is not a valid URL.");
  }
  const path = [
    base.pathname.replace(/\/+$/, ""),
    "openai",
    "deployments",
    encodeURIComponent(input.deployment),
    "chat",
    "completions",
  ]
    .filter(Boolean)
    .join("/");
  base.pathname = path.startsWith("/") ? path : `/${path}`;
  base.search = "";
  base.searchParams.set("api-version", input.apiVersion);
  return base.toString();
}

async function postAzureChatCompletion(input: {
  url: string;
  apiKey: string;
  timeoutMs: number;
  opts: LlmOptions;
  stream: boolean;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (input.opts.signal?.aborted) {
    controller.abort();
  } else {
    input.opts.signal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(input.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "api-key": input.apiKey,
      },
      body: JSON.stringify(
        createChatRequestBody({ ...input.opts, stream: input.stream }),
      ),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      if (input.opts.signal?.aborted) {
        throw new Error("Azure OpenAI request stopped by user.");
      }
      throw new Error(
        `Azure OpenAI timed out after ${input.timeoutMs}ms at ${hostFromUrl(input.url)}.`,
      );
    }
    throw new Error(`Could not reach ${hostFromUrl(input.url)}.`);
  } finally {
    clearTimeout(timer);
    input.opts.signal?.removeEventListener("abort", abortFromCaller);
  }

  if (!response.ok) {
    throw new Error(await azureOpenAiHttpError(response));
  }
  return response;
}

function createChatRequestBody(
  opts: LlmOptions & { stream: boolean },
): Record<string, unknown> {
  const messages: { role: string; content: string }[] = [];
  if (opts.system) {
    messages.push({ role: "system", content: opts.system });
  }
  messages.push({ role: "user", content: opts.prompt });

  const body: Record<string, unknown> = {
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

async function azureOpenAiHttpError(response: Response): Promise<string> {
  if (response.status === 401) {
    return "Azure OpenAI rejected the key.";
  }
  if (response.status === 404) {
    return "Deployment not found — check the deployment name and endpoint.";
  }
  const detail = await response.text().catch(() => "");
  return `Azure OpenAI responded with HTTP ${response.status}: ${truncate(detail, 200)}`;
}

function tokenUsageFromAzureOpenAi(
  payload: AzureOpenAiChatResponse,
): LlmTokenUsage | undefined {
  const prompt =
    typeof payload.usage?.prompt_tokens === "number"
      ? payload.usage.prompt_tokens
      : undefined;
  const completion =
    typeof payload.usage?.completion_tokens === "number"
      ? payload.usage.completion_tokens
      : undefined;
  const total =
    typeof payload.usage?.total_tokens === "number"
      ? payload.usage.total_tokens
      : undefined;
  if (prompt === undefined && completion === undefined && total === undefined) {
    return undefined;
  }
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

function hostFromUrl(url: string): string {
  try {
    return new URL(url).host || "(empty host)";
  } catch {
    return "(invalid endpoint)";
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}
