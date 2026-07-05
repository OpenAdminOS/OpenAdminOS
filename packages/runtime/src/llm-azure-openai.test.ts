import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createAzureOpenAiLlm,
  probeAzureOpenAi,
} from "./llm-azure-openai.js";

describe("createAzureOpenAiLlm", () => {
  it("posts chat completions to the Azure deployment URL with api-key auth", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    let capturedApiKey: string | null = null;

    await withFetch(async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedApiKey = new Headers(init?.headers).get("api-key");
      return jsonResponse({
        choices: [{ message: { content: "OK" } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    }, async () => {
      const llm = createAzureOpenAiLlm({
        endpoint: "https://contoso.openai.azure.com/",
        deployment: "gpt-4o-mini-prod",
        apiVersion: "2024-10-21",
        apiKey: "secret-key",
      });

      const completion = await llm.complete({
        system: "System text",
        prompt: "User text",
        temperature: 0.2,
        maxTokens: 12,
      });

      assert.equal(
        capturedUrl,
        "https://contoso.openai.azure.com/openai/deployments/gpt-4o-mini-prod/chat/completions?api-version=2024-10-21",
      );
      assert.equal(capturedApiKey, "secret-key");
      assert.equal(capturedBody?.stream, false);
      assert.equal(capturedBody?.temperature, 0.2);
      assert.equal(capturedBody?.max_tokens, 12);
      assert.equal(capturedBody?.model, undefined);
      assert.deepEqual(capturedBody?.messages, [
        { role: "system", content: "System text" },
        { role: "user", content: "User text" },
      ]);
      assert.equal(completion.text, "OK");
      assert.equal(completion.model, "gpt-4o-mini-prod");
      assert.deepEqual(completion.tokenUsage, {
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      });
    });
  });

  it("parses Azure chat-completion SSE chunks", async () => {
    await withFetch(async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"O"}}]}\n\n',
            ),
          );
          controller.enqueue(
            encoder.encode(
              'data: {"choices":[{"delta":{"content":"K"}}],"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n',
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
      const llm = createAzureOpenAiLlm({
        endpoint: "https://contoso.openai.azure.com",
        deployment: "gpt-4o-mini-prod",
        apiVersion: "2024-10-21",
        apiKey: "secret-key",
      });
      const chunks = [];
      for await (const chunk of llm.stream({ prompt: "Reply OK" })) {
        chunks.push(chunk);
      }

      assert.equal(chunks.at(0)?.delta, "O");
      assert.equal(chunks.at(1)?.accumulated, "OK");
      assert.equal(chunks.at(-1)?.done, true);
      assert.equal(chunks.at(-1)?.model, "gpt-4o-mini-prod");
      assert.deepEqual(chunks.at(-1)?.tokenUsage, {
        promptTokens: 2,
        completionTokens: 1,
        totalTokens: 3,
      });
    });
  });

  it("maps Azure auth and deployment errors to admin-facing messages", async () => {
    await withFetch(async () => new Response("unauthorized", { status: 401 }), async () => {
      const llm = createAzureOpenAiLlm({
        endpoint: "https://contoso.openai.azure.com",
        deployment: "gpt-4o-mini-prod",
        apiVersion: "2024-10-21",
        apiKey: "bad-key",
      });
      await assert.rejects(() => llm.complete({ prompt: "test" }), {
        message: "Azure OpenAI rejected the key.",
      });
    });

    await withFetch(async () => new Response("missing", { status: 404 }), async () => {
      const llm = createAzureOpenAiLlm({
        endpoint: "https://contoso.openai.azure.com",
        deployment: "missing-deployment",
        apiVersion: "2024-10-21",
        apiKey: "secret-key",
      });
      await assert.rejects(() => llm.complete({ prompt: "test" }), {
        message: "Deployment not found — check the deployment name and endpoint.",
      });
    });
  });

  it("maps network failures to the endpoint host", async () => {
    await withFetch(async () => {
      throw new TypeError("fetch failed");
    }, async () => {
      const llm = createAzureOpenAiLlm({
        endpoint: "https://contoso.openai.azure.com",
        deployment: "gpt-4o-mini-prod",
        apiVersion: "2024-10-21",
        apiKey: "secret-key",
      });

      await assert.rejects(() => llm.complete({ prompt: "test" }), {
        message: "Could not reach contoso.openai.azure.com.",
      });
    });
  });
});

describe("probeAzureOpenAi", () => {
  it("runs a one-token chat completion probe", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    await withFetch(async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        choices: [{ message: { content: "OK" } }],
      });
    }, async () => {
      const probe = await probeAzureOpenAi({
        endpoint: "https://contoso.openai.azure.com",
        deployment: "gpt-4o-mini-prod",
        apiVersion: "2024-10-21",
        apiKey: "secret-key",
      });

      assert.equal(probe.ready, true);
      assert.equal(probe.status, "connected");
      assert.equal(probe.model, "gpt-4o-mini-prod");
      assert.equal(capturedBody?.max_tokens, 1);
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
