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
        { id: "anthropic.claude", labels: ["chat"], recipe: "cloud-anthropic" },
        { id: "routed", labels: ["chat"], recipe: "llamacpp", cloud_provider: "openrouter" },
        { id: "spaced", labels: ["chat"], recipe: " Cloud " },
        { id: "catalog-only", labels: ["chat"], recipe: "llamacpp", downloaded: false },
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
      if (String(input).endsWith("/models")) return listed("Qwen3-0.6B-GGUF");
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

    await withFetch(async (input) => (String(input).endsWith("/models") ? listed("Nope-GGUF") : new Response("model_not_found", { status: 404 })), async () => {
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
    await withFetch(async (input) => {
      if (String(input).endsWith("/models")) return listed("Qwen3-0.6B-GGUF");
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

function listed(id: string): Response {
  return jsonResponse({ object: "list", data: [{ id, labels: ["chat"], recipe: "llamacpp" }] });
}

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

describe("createLemonadeLlm sends only a listed chat model", () => {
  const list = (data: unknown[]) => jsonResponse({ object: "list", data });

  it("refuses a cloud-routed, a non-chat and an undownloaded model before any chat request", async () => {
    const cases: Array<[string, RegExp]> = [
      ["openai.gpt-5", /^Error: Lemonade sends openai\.gpt-5 to a cloud API, so OpenAdminOS does not use it as a local model\./],
      ["nomic-embed-text-v1-GGUF", /^Error: nomic-embed-text-v1-GGUF is not a chat model in Lemonade\./],
      ["Qwen3-8B-GGUF", /^Error: Lemonade has no downloaded chat model named Qwen3-8B-GGUF\. Download it in Lemonade or choose another model, then try again\.$/],
      ["Qwen3-4B-GGUF", /^Error: Lemonade has no downloaded chat model named Qwen3-4B-GGUF\. Download it in Lemonade or choose another model, then try again\.$/],
    ];
    for (const [model, message] of cases) {
      const urls: string[] = [];
      await withFetch(async (input) => {
        urls.push(String(input));
        return list([
          { id: "Qwen3-0.6B-GGUF", labels: ["chat"], recipe: "llamacpp" },
          { id: "openai.gpt-5", labels: ["chat"], recipe: "cloud" },
          { id: "nomic-embed-text-v1-GGUF", labels: ["embeddings"], recipe: "llamacpp" },
          { id: "Qwen3-4B-GGUF", labels: ["chat"], recipe: "llamacpp", downloaded: false },
        ]);
      }, async () => {
        const llm = createLemonadeLlm({ defaultModel: model });
        await assert.rejects(llm.complete({ prompt: "x" }), message);
        await assert.rejects(async () => {
          for await (const _ of llm.stream({ prompt: "x" })) { /* nothing is streamed */ }
        }, message);
      });
      assert.deepEqual(urls, ["http://127.0.0.1:13305/v1/models", "http://127.0.0.1:13305/v1/models"], model);
    }
  });

  it("checks the list on every request, then sends a listed model", async () => {
    const urls: string[] = [];
    await withFetch(async (input) => {
      urls.push(String(input));
      if (String(input).endsWith("/models")) return list([{ id: "Qwen3-0.6B-GGUF", labels: ["chat"], recipe: "llamacpp" }]);
      return jsonResponse({ model: "Qwen3-0.6B-GGUF", choices: [{ message: { content: "OK" } }] });
    }, async () => {
      const llm = createLemonadeLlm({ defaultModel: "Qwen3-0.6B-GGUF" });
      assert.equal((await llm.complete({ prompt: "x" })).text, "OK");
      assert.equal((await llm.complete({ prompt: "y" })).text, "OK");
    });
    assert.deepEqual(urls, [
      "http://127.0.0.1:13305/v1/models",
      "http://127.0.0.1:13305/v1/chat/completions",
      "http://127.0.0.1:13305/v1/models",
      "http://127.0.0.1:13305/v1/chat/completions",
    ]);
  });

  it("names the API key and an unreachable server from the list check", async () => {
    await withFetch(async () => new Response("", { status: 401 }), async () => {
      await assert.rejects(createLemonadeLlm({ defaultModel: "m" }).complete({ prompt: "x" }), /LEMONADE_API_KEY/);
    });
    await withFetch(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    }, async () => {
      await assert.rejects(createLemonadeLlm({ defaultModel: "m" }).complete({ prompt: "x" }), /^Error: Lemonade not reachable at http:\/\/127\.0\.0\.1:13305\/v1\/models: fetch failed$/);
    });
  });
});

describe("createLemonadeLlm when the model list cannot be read", () => {
  const send = async (llm: ReturnType<typeof createLemonadeLlm>, mode: "complete" | "stream", signal?: AbortSignal) => {
    if (mode === "complete") return llm.complete({ prompt: "x", ...(signal ? { signal } : {}) });
    for await (const _ of llm.stream({ prompt: "x", ...(signal ? { signal } : {}) })) { /* nothing */ }
  };

  for (const mode of ["complete", "stream"] as const) {
    it(`${mode}: names an unreadable list, a timeout and a stop, never a missing model`, async () => {
      let posted = false;
      await withFetch(async (input) => {
        if (!String(input).endsWith("/models")) posted = true;
        return new Response("{not json", { status: 200, headers: { "content-type": "application/json" } });
      }, async () => {
        await assert.rejects(send(createLemonadeLlm({ defaultModel: "m" }), mode), /^Error: Lemonade answered http:\/\/127\.0\.0\.1:13305\/v1\/models with a model list OpenAdminOS could not read\. Try again\.$/);
      });

      // Headers arrive, then the body stalls until the request is aborted.
      const stalled: typeof fetch = async (input, init) => {
        if (!String(input).endsWith("/models")) posted = true;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      };
      await withFetch(stalled, async () => {
        await assert.rejects(send(createLemonadeLlm({ defaultModel: "m", timeoutMs: 30 }), mode), /^Error: Lemonade timed out after 30ms at http:\/\/127\.0\.0\.1:13305\/v1\/models\.$/);
        const controller = new AbortController();
        const pending = send(createLemonadeLlm({ defaultModel: "m" }), mode, controller.signal);
        setTimeout(() => controller.abort(), 10);
        await assert.rejects(pending, /^Error: Lemonade request stopped by user\.$/);
      });
      assert.equal(posted, false, "no chat request is sent without a readable list");
    });
  }
});
