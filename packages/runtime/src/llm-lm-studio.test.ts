import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLmStudioEndpoint,
  createLmStudioLlm,
  probeLmStudioLlm,
} from "./llm-lm-studio.js";

describe("classifyLmStudioEndpoint", () => {
  it("treats loopback endpoints as local", () => {
    for (const endpoint of [
      "http://localhost:1234/v1",
      "http://localhost.:1234/v1",
      "http://127.0.0.1:1234/v1",
      "http://127.42.0.9:1234/v1",
      "http://[::1]:1234/v1",
      "http://[0:0:0:0:0:0:0:1]:1234/v1",
      "http://[::ffff:127.0.0.1]:1234/v1",
    ]) {
      assert.equal(classifyLmStudioEndpoint(endpoint).isLocal, true, endpoint);
    }
  });

  it("treats LAN, internet, wildcard, and invalid endpoints as external", () => {
    for (const endpoint of [
      "http://192.168.1.10:1234/v1",
      "http://10.0.0.5:1234/v1",
      "https://lmstudio.example.com/v1",
      "http://0.0.0.0:1234/v1",
      "notaurl",
      "",
    ]) {
      assert.equal(classifyLmStudioEndpoint(endpoint).isLocal, false, endpoint);
    }
  });
});

describe("probeLmStudioLlm", () => {
  it("reads OpenAI-compatible model ids from /models", async () => {
    await withFetch(async (input) => {
      assert.equal(String(input), "http://localhost:1234/v1/models");
      return jsonResponse({
        data: [{ id: "local-model-a" }, { id: "local-model-b" }],
      });
    }, async () => {
      const probe = await probeLmStudioLlm();

      assert.equal(probe.ready, true);
      assert.equal(probe.status, "connected");
      assert.deepEqual(probe.models, ["local-model-a", "local-model-b"]);
      assert.equal(probe.defaultModel, "local-model-a");
      assert.equal(probe.isLocal, true);
    });
  });
});

describe("createLmStudioLlm", () => {
  it("posts chat completions with system and user messages", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    await withFetch(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        model: "local-model-a",
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    }, async () => {
      const llm = createLmStudioLlm({ defaultModel: "local-model-a" });
      const completion = await llm.complete({
        system: "System text",
        prompt: "User text",
        maxTokens: 12,
      });

      assert.equal(completion.text, "OK");
      assert.equal(completion.model, "local-model-a");
      assert.deepEqual(completion.tokenUsage, {
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      });
      assert.equal(capturedBody?.model, "local-model-a");
      assert.equal(capturedBody?.stream, false);
      assert.equal(capturedBody?.max_tokens, 12);
      assert.deepEqual(capturedBody?.messages, [
        { role: "system", content: "System text" },
        { role: "user", content: "User text" },
      ]);
    });
  });

  it("parses SSE chat-completion chunks", async () => {
    await withFetch(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"model":"local-model-a","choices":[{"delta":{"content":"O"}}]}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'data: {"model":"local-model-a","choices":[{"delta":{"content":"K"}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
            ),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }, async () => {
      const llm = createLmStudioLlm({ defaultModel: "local-model-a" });
      const chunks = [];
      for await (const chunk of llm.stream({ prompt: "Reply OK" })) {
        chunks.push(chunk);
      }

      assert.equal(chunks.at(0)?.delta, "O");
      assert.equal(chunks.at(1)?.accumulated, "OK");
      assert.equal(chunks.at(-1)?.done, true);
      assert.deepEqual(chunks.at(-1)?.tokenUsage, {
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      });
    });
  });
});

async function withFetch(
  fetchImpl: typeof fetch,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
