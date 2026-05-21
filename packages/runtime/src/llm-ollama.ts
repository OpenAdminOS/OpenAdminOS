import type {
  LlmCompletion,
  LlmOptions,
  LlmStreamChunk,
  LlmTokenUsage,
  RunLlmApi,
} from "@openadminos/agent-sdk";

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
     * separate field. We capture it so the Reasoning tab can show it
     * and so we can fall back to using it as the answer if the model
     * exhausts its token budget inside the reasoning phase.
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

export function createOllamaLlm(options: OllamaProviderOptions = {}): RunLlmApi {
  const endpoint =
    options.endpoint ?? process.env.OPENAGENTS_OLLAMA_URL ?? "http://127.0.0.1:11434";
  const defaultModel = options.defaultModel;
  const timeoutMs =
    options.timeoutMs ??
    Number.parseInt(process.env.OPENAGENTS_OLLAMA_TIMEOUT_MS ?? "60000", 10);

  return {
    available: true,
    defaultModel,
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
        // the model produce its answer directly. For reasoning models
        // (deepseek-r1, qwen-qwq, gpt-oss, etc.) this prevents the
        // model from spending its entire token budget inside a hidden
        // chain-of-thought and emitting empty `message.content`. For
        // non-reasoning models the flag is silently ignored.
        think: false,
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

      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error(`Ollama timed out after ${timeoutMs}ms at ${url}.`);
        }
        throw new Error(`Ollama not reachable at ${url}: ${describe(error)}`);
      }

      if (!response.ok) {
        clearTimeout(timer);
        const detail = await response.text().catch(() => "");
        if (response.status === 404 && detail.toLowerCase().includes("model")) {
          throw new Error(
            `Ollama model "${model}" is not pulled. Run \`ollama pull ${model}\`.`,
          );
        }
        throw new Error(`Ollama responded with HTTP ${response.status}: ${truncate(detail, 200)}`);
      }

      if (!response.body) {
        clearTimeout(timer);
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
            // Capture reasoning-model chain-of-thought separately. We
            // don't yield this as content (the renderer surfaces it via
            // the runtime's thinking hook on the accumulated stream),
            // but we keep it around so we can fall back to it if the
            // model never produced visible content.
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
              // If the model never emitted visible content but did
              // produce reasoning (e.g. it hit num_predict mid-thought),
              // surface the reasoning so the agent has *something* to
              // work with. The cleanLlmText filter in the runtime will
              // re-strip <think> tags if the model also wrapped output.
              if (delta.length === 0 && accumulated.length === 0 && reasoningOnly.length > 0) {
                accumulated = reasoningOnly;
                yield {
                  delta: reasoningOnly,
                  accumulated,
                  done: true,
                  model: actualModel,
                  ...(tokenUsage ? { tokenUsage } : {}),
                };
              } else if (delta.length === 0) {
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
        reader.releaseLock();
      }
    },
  };
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

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
