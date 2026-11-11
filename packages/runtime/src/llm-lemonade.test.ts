import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLemonadeEndpoint,
  createLemonadeLlm,
  lemonadeChatModelIds,
  probeLemonadeLlm,
  resolveLemonadeEndpoint,
} from "./llm-lemonade.js";

describe("resolveLemonadeEndpoint", () => {
  it("defaults to Lemonade's port on loopback and honours the override", () => {
    const saved = process.env.OPENADMINOS_LEMONADE_URL;
    delete process.env.OPENADMINOS_LEMONADE_URL;
    try {
      assert.equal(resolveLemonadeEndpoint(), "http://127.0.0.1:13305/v1");
      process.env.OPENADMINOS_LEMONADE_URL = " http://192.168.1.20:13305/api/v1 ";
      assert.equal(resolveLemonadeEndpoint(), "http://192.168.1.20:13305/api/v1");
      assert.equal(classifyLemonadeEndpoint(resolveLemonadeEndpoint()).isLocal, false);
      assert.equal(resolveLemonadeEndpoint("http://localhost:9000/v1"), "http://localhost:9000/v1");
    } finally {
      if (saved === undefined) delete process.env.OPENADMINOS_LEMONADE_URL;
      else process.env.OPENADMINOS_LEMONADE_URL = saved;
    }
  });
});

describe("lemonadeChatModelIds", () => {
  it("keeps downloaded chat models and leaves out other kinds and cloud routes", () => {
    assert.deepEqual(
      lemonadeChatModelIds([
        { id: "Qwen3-0.6B-GGUF", labels: ["chat", "reasoning", "tool-calling"], recipe: "llamacpp" },
        { id: "Qwen3-Embedding-0.6B-GGUF", labels: ["embeddings"], recipe: "llamacpp" },
        { id: "Whisper-Tiny", labels: ["transcription"], recipe: "whispercpp" },
        { id: "SD-Turbo", labels: ["image"], recipe: "sd-cpp" },
        { id: "Gemma-3-4b-it-GGUF", labels: ["chat", "vision"], recipe: "llamacpp" },
        { id: "openai.gpt-5", labels: ["chat"], recipe: "cloud" },
        { id: "no-labels", recipe: "llamacpp" },
        { labels: ["chat"], recipe: "llamacpp" },
      ]),
      ["Qwen3-0.6B-GGUF", "Gemma-3-4b-it-GGUF"],
    );
  });
});

describe("probeLemonadeLlm", () => {
  it("lists chat models from /models and names the first as default", async () => {
    await withFetch(async (input) => {
      assert.equal(String(input), "http://127.0.0.1:13305/v1/models");
      return jsonResponse({
        object: "list",
        data: [
          { id: "nomic-embed-text-v1-GGUF", labels: ["embeddings"], recipe: "llamacpp", downloaded: true },
          { id: "Qwen3-0.6B-GGUF", labels: ["chat", "reasoning"], recipe: "llamacpp", downloaded: true },
        ],
      });
    }, async () => {
      const probe = await probeLemonadeLlm();

      assert.equal(probe.ready, true);
      assert.equal(probe.status, "connected");
      assert.deepEqual(probe.models, ["Qwen3-0.6B-GGUF"]);
      assert.equal(probe.defaultModel, "Qwen3-0.6B-GGUF");
      assert.equal(probe.isLocal, true);
      assert.equal(probe.detail, "Lemonade server is running on http://127.0.0.1:13305/v1.");
    });
  });

  it("says when Lemonade runs without a chat model", async () => {
    await withFetch(async () => jsonResponse({ object: "list", data: [] }), async () => {
      const probe = await probeLemonadeLlm();
      assert.equal(probe.status, "connected");
      assert.deepEqual(probe.models, []);
      assert.equal(probe.defaultModel, undefined);
      assert.equal(probe.detail, "Lemonade is running but has no chat model downloaded.");
    });
  });

  it("reads a refused connection as not running", async () => {
    await withFetch(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }, async () => {
      const probe = await probeLemonadeLlm();
      assert.equal(probe.status, "not-running");
      assert.equal(probe.detail, "Lemonade isn't running. Start Lemonade Server, then try again.");
    });
  });

  it("names the API key when Lemonade answers 401", async () => {
    await withFetch(async () => new Response(JSON.stringify({ error: "Invalid or missing API key" }), { status: 401 }), async () => {
      const probe = await probeLemonadeLlm();
      assert.equal(probe.status, "error");
      assert.match(probe.detail ?? "", /LEMONADE_API_KEY/);
    });
  });

  it("keeps the plain HTTP message for other statuses", async () => {
    await withFetch(async () => new Response("", { status: 500 }), async () => {
      const probe = await probeLemonadeLlm();
      assert.equal(probe.status, "error");
      assert.equal(probe.detail, "Lemonade responded with HTTP 500.");
    });
  });
});

describe("createLemonadeLlm", () => {
  it("posts chat completions and names errors after Lemonade", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> | undefined;
    await withFetch(async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({
        model: "Qwen3-0.6B-GGUF",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "France" } }],
        usage: { prompt_tokens: 26, completion_tokens: 6, total_tokens: 32 },
      });
    }, async () => {
      const completion = await createLemonadeLlm({ defaultModel: "Qwen3-0.6B-GGUF" }).complete({
        system: "Answer in one word.",
        prompt: "Capital of France?",
      });
      assert.equal(capturedUrl, "http://127.0.0.1:13305/v1/chat/completions");
      assert.equal(capturedBody?.model, "Qwen3-0.6B-GGUF");
      assert.equal(completion.text, "France");
      assert.equal(completion.model, "Qwen3-0.6B-GGUF");
      assert.deepEqual(completion.tokenUsage, { promptTokens: 26, completionTokens: 6, totalTokens: 32 });
    });

    await withFetch(async () => new Response("model_not_found", { status: 404 }), async () => {
      await assert.rejects(
        createLemonadeLlm({ defaultModel: "Nope-GGUF" }).complete({ prompt: "x" }),
        /^Error: Lemonade responded with HTTP 404: model_not_found$/,
      );
    });
  });

  it("refuses to send without a model", async () => {
    await assert.rejects(
      createLemonadeLlm().complete({ prompt: "x" }),
      /No Lemonade model available\. Download a chat model in Lemonade, then try again\./,
    );
  });

  it("streams deltas and keeps the requested model id, not the file path", async () => {
    await withFetch(async () => {
      const encoder = new TextEncoder();
      const path = "/Users/admin/.cache/huggingface/hub/models--unsloth--Qwen3-0.6B-GGUF/Qwen3-0.6B-Q4_0.gguf";
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"model":"${path}","choices":[{"delta":{"role":"assistant","content":null}}]}\n\n`));
          controller.enqueue(encoder.encode(`data: {"model":"${path}","choices":[{"delta":{"content":"Hi"}}]}\n\n`));
          controller.enqueue(encoder.encode(`data: {"model":"${path}","choices":[{"delta":{"content":"!"}}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n`));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }, async () => {
      const chunks = [];
      for await (const chunk of createLemonadeLlm({ defaultModel: "Qwen3-0.6B-GGUF" }).stream({ prompt: "Say hi" })) {
        chunks.push(chunk);
      }
      assert.deepEqual(chunks.map((chunk) => chunk.delta), ["Hi", "!", ""]);
      assert.equal(chunks.at(-1)?.accumulated, "Hi!");
      assert.equal(chunks.at(-1)?.done, true);
      assert.ok(chunks.every((chunk) => chunk.model === "Qwen3-0.6B-GGUF"));
      assert.deepEqual(chunks.at(-1)?.tokenUsage, { promptTokens: 4, completionTokens: 2, totalTokens: 6 });
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
