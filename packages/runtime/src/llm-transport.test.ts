import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createLmStudioLlm } from "./llm-lm-studio.js";
import { llmErrorCode } from "./llm-errors.js";
import { createOllamaLlm } from "./llm-ollama.js";

describe("model clients with a host transport", () => {
  it("send their chat requests through the given fetch", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input));
      throw new Error("refused by transport");
    }) as typeof fetch;
    await assert.rejects(createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "m", fetchImpl }).complete({ prompt: "x" }), /refused by transport/);
    await assert.rejects(createLmStudioLlm({ endpoint: "http://127.0.0.1:1234/v1", defaultModel: "m", fetchImpl }).complete({ prompt: "x" }), /refused by transport/);
    assert.deepEqual(urls, ["http://127.0.0.1:11434/api/chat", "http://127.0.0.1:1234/v1/chat/completions"]);
  });
});

/** A chat stream that sends one chunk and then stalls, erroring only when the request aborts. */
function stallingChat(firstLine: string): typeof fetch {
  return (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`${firstLine}\n`));
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

const ollamaLine = JSON.stringify({ model: "m", message: { content: "partial" }, done: false });
const lmStudioLine = `data: ${JSON.stringify({ model: "m", choices: [{ delta: { content: "partial" } }] })}`;

/** Reads a stream to its end, as the runtime does for every model step. */
async function drain(llm: { stream(options: { prompt: string; signal?: AbortSignal }): AsyncIterable<unknown> }, signal?: AbortSignal): Promise<void> {
  for await (const _chunk of llm.stream({ prompt: "x", ...(signal ? { signal } : {}) })) {
    // keep reading
  }
}

describe("model clients name a stalled stream", () => {
  for (const [label, create] of [
    ["Ollama", (fetchImpl: typeof fetch) => createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "m", timeoutMs: 50, fetchImpl })],
    ["LM Studio", (fetchImpl: typeof fetch) => createLmStudioLlm({ endpoint: "http://127.0.0.1:1234/v1", defaultModel: "m", timeoutMs: 50, fetchImpl })],
  ] as const) {
    it(`${label}: a timeout mid-stream is model-timeout, a caller stop is model-cancelled`, async () => {
      const line = label === "Ollama" ? ollamaLine : lmStudioLine;
      await assert.rejects(drain(create(stallingChat(line))), (error: unknown) => llmErrorCode(error) === "model-timeout" && /timed out after 50ms/.test((error as Error).message));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10);
      try {
        const slow = label === "Ollama"
          ? createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "m", timeoutMs: 60_000, fetchImpl: stallingChat(line) })
          : createLmStudioLlm({ endpoint: "http://127.0.0.1:1234/v1", defaultModel: "m", timeoutMs: 60_000, fetchImpl: stallingChat(line) });
        await assert.rejects(drain(slow, controller.signal), (error: unknown) => llmErrorCode(error) === "model-cancelled");
      } finally {
        clearTimeout(timer);
      }
    });
  }
});
