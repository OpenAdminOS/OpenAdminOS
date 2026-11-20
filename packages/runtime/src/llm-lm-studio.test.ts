import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  classifyLmStudioEndpoint,
  createLmStudioLlm,
  parseLmStudioContextOverflow,
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
      assert.equal(String(input), "http://127.0.0.1:1234/v1/models");
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

describe("probeLmStudioLlm reads an unexpected list as a failed check", () => {
  it("does not read a non-array data field as an empty server", async () => {
    await withFetch(async () => jsonResponse({ data: { id: "x" } }), async () => {
      const probe = await probeLmStudioLlm();
      assert.equal(probe.status, "error");
      assert.equal(probe.detail, "LM Studio answered with a response OpenAdminOS could not read.");
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

interface FakeRequest {
  method: string;
  url: string;
  body: string;
}

interface FakeLmStudio {
  endpoint: string;
  requests: FakeRequest[];
  close: () => Promise<void>;
}

/** A local HTTP server standing in for LM Studio; `handle` answers each request. */
async function fakeLmStudio(
  handle: (req: FakeRequest, res: ServerResponse) => void,
): Promise<FakeLmStudio> {
  const requests: FakeRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", body };
      requests.push(entry);
      handle(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const OLD_OVERFLOW =
  "<LM Studio error> Trying to keep the first 15857 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough. Try to load the model with a larger context length, or provide a shorter input. Error Data: n/a, Additional Data: n/a";
const NEW_OVERFLOW =
  "The number of tokens to keep from the initial prompt is greater than the context length. Try to load the model with a larger context length, or provide a shorter input. Error Data: n/a, Additional Data: n/a";

function v1Models(model: string, loaded: number, max: number) {
  return {
    models: [
      { type: "llm", key: "other/model", loaded_instances: [], max_context_length: 8192 },
      {
        type: "llm",
        key: model,
        loaded_instances: [{ id: model, config: { context_length: loaded, eval_batch_size: 512 } }],
        max_context_length: max,
      },
    ],
  };
}

describe("LM Studio context length too small", () => {
  const collect = async (llm: ReturnType<typeof createLmStudioLlm>, opts: Parameters<typeof llm.complete>[0]) => {
    let text = "";
    for await (const chunk of llm.stream!(opts)) text = chunk.accumulated;
    return text;
  };

  it("sends a request that fits unchanged and makes no other call", async () => {
    const server = await fakeLmStudio((req, res) => {
      const body = JSON.parse(req.body) as { stream: boolean };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end('data: {"model":"qwen3-8b","choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
        return;
      }
      sendJson(res, 200, { model: "qwen3-8b", choices: [{ message: { content: "OK" } }] });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      assert.equal((await llm.complete({ prompt: "hi", system: "sys", maxTokens: 64 })).text, "OK");
      assert.equal(await collect(llm, { prompt: "hi", maxTokens: 64 }), "OK");
      assert.deepEqual(server.requests.map((r) => `${r.method} ${r.url}`), ["POST /v1/chat/completions", "POST /v1/chat/completions"]);
      assert.deepEqual(JSON.parse(server.requests[0]!.body), {
        model: "qwen3-8b",
        messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
        stream: false,
        max_tokens: 64,
      });
    } finally {
      await server.close();
    }
  });

  it("names both token counts and the size to load with, from the 0.3 error", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 200, v1Models("qwen3-8b", 4096, 32768));
      sendJson(res, 400, { error: OLD_OVERFLOW });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big" }), (error: Error) => {
        assert.match(error.message, /^LM Studio context length too small: This request needs 15,857 tokens of context, but qwen3-8b is loaded in LM Studio with a context length of 4,096\./);
        assert.match(error.message, /Raise Context Length to at least 20,480 \(qwen3-8b supports up to 32,768\)/);
        assert.match(error.message, /`lms load qwen3-8b --context-length 20480`/);
        assert.match(error.message, /LM Studio said: <LM Studio error> Trying to keep the first 15857 tokens/);
        return true;
      });
      // Only reads: OpenAdminOS never loads, unloads or reloads the model.
      assert.deepEqual(server.requests.map((r) => `${r.method} ${r.url}`), ["POST /v1/chat/completions", "GET /api/v1/models"]);
    } finally {
      await server.close();
    }
  });

  it("uses the caller's answer limit for the suggested size, capped at the model's limit", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 200, v1Models("qwen3-8b", 4096, 16384));
      sendJson(res, 400, { error: OLD_OVERFLOW });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big", maxTokens: 512 }), /Raise Context Length to at least 16,384 \(qwen3-8b supports up to 16,384\)/);
    } finally {
      await server.close();
    }
  });

  it("reads the loaded size from /api/v1/models when the 0.4 error has no counts", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 200, v1Models("qwen3-8b", 8192, 40960));
      sendJson(res, 400, { error: { message: NEW_OVERFLOW } });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big" }), (error: Error) => {
        assert.match(error.message, /^LM Studio context length too small: This request does not fit in the 8,192 tokens of context qwen3-8b is loaded with in LM Studio\./);
        assert.match(error.message, /Raise Context Length \(qwen3-8b supports up to 40,960\)/);
        assert.match(error.message, /--context-length <tokens>/);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it("falls back to /api/v0/models/{model} on a server without the v1 REST API", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 404, { error: "Unexpected endpoint" });
      if (req.url === "/api/v0/models/qwen%2Fqwen3-8b") {
        return sendJson(res, 200, { id: "qwen/qwen3-8b", state: "loaded", loaded_context_length: 4096, max_context_length: 32768 });
      }
      sendJson(res, 400, { error: { message: NEW_OVERFLOW } });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen/qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big" }), /does not fit in the 4,096 tokens of context qwen\/qwen3-8b is loaded with in LM Studio\. Raise Context Length \(qwen\/qwen3-8b supports up to 32,768\)/);
    } finally {
      await server.close();
    }
  });

  it("names the model key in the command when the request used a loaded instance id", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") {
        return sendJson(res, 200, {
          models: [{ type: "llm", key: "qwen3-8b", loaded_instances: [{ id: "qwen3-8b", config: { context_length: 32768 } }, { id: "qwen3-8b:2", config: { context_length: 4096 } }], max_context_length: 32768 }],
        });
      }
      sendJson(res, 400, { error: OLD_OVERFLOW });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b:2" });
      await assert.rejects(llm.complete({ prompt: "big" }), (error: Error) => {
        assert.match(error.message, /but qwen3-8b:2 is loaded in LM Studio with a context length of 4,096/);
        assert.match(error.message, /`lms load qwen3-8b --context-length 20480`/);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it("asks /api/v0 when /api/v1 lists the model without its loaded size", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") {
        return sendJson(res, 200, { models: [{ type: "llm", key: "qwen3-8b", loaded_instances: [{ id: "qwen3-8b", config: {} }], max_context_length: 40960 }] });
      }
      if (req.url === "/api/v0/models/qwen3-8b") return sendJson(res, 200, { id: "qwen3-8b", loaded_context_length: 8192 });
      sendJson(res, 400, { error: { message: NEW_OVERFLOW } });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big" }), /does not fit in the 8,192 tokens of context qwen3-8b is loaded with in LM Studio\. Raise Context Length \(qwen3-8b supports up to 40,960\)/);
    } finally {
      await server.close();
    }
  });

  it("reads the counts from an error sent inside the stream", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 200, v1Models("qwen3-8b", 8192, 32768));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ error: { message: "The number of tokens to keep from the initial prompt is greater than the context length (n_keep: 8485 >= n_ctx: 8192). Try to load the model with a larger context length, or provide a shorter input." } })}\n\n`);
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(collect(llm, { prompt: "big" }), /This request needs 8,485 tokens of context, but qwen3-8b is loaded in LM Studio with a context length of 8,192\. Raise Context Length to at least 13,312/);
    } finally {
      await server.close();
    }
  });

  it("reads a streamed request's HTTP 400 overflow", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 200, v1Models("qwen3-8b", 4096, 32768));
      sendJson(res, 400, { error: OLD_OVERFLOW });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(collect(llm, { prompt: "big" }), /This request needs 15,857 tokens of context/);
    } finally {
      await server.close();
    }
  });

  it("says the model's limit is the problem when the request is larger than it", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 200, v1Models("qwen3-8b", 4096, 8192));
      sendJson(res, 400, { error: OLD_OVERFLOW });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big" }), (error: Error) => {
        assert.match(error.message, /qwen3-8b supports at most 8,192, so narrow the request or pick a model with a larger context window\./);
        assert.doesNotMatch(error.message, /Raise Context Length/);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it("says the model's limit is the problem when it is already loaded at its maximum", async () => {
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") return sendJson(res, 200, v1Models("qwen3-8b", 8192, 8192));
      sendJson(res, 400, { error: { message: NEW_OVERFLOW } });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big" }), /qwen3-8b supports at most 8,192, so narrow the request/);
    } finally {
      await server.close();
    }
  });

  it("does not follow a redirect from the lookup and still reports the overflow", async () => {
    const elsewhere = await fakeLmStudio((_req, res) => sendJson(res, 200, v1Models("qwen3-8b", 4096, 32768)));
    const server = await fakeLmStudio((req, res) => {
      if (req.url?.startsWith("/api/")) {
        res.writeHead(307, { location: `${elsewhere.endpoint.replace(/\/v1$/, "")}/api/v1/models` });
        res.end();
        return;
      }
      sendJson(res, 400, { error: { message: NEW_OVERFLOW } });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big" }), /LM Studio context length too small: This request does not fit in the context length qwen3-8b is loaded with in LM Studio\./);
      assert.equal(elsewhere.requests.length, 0);
    } finally {
      await server.close();
      await elsewhere.close();
    }
  });

  it("still refuses a redirect from the chat endpoint", async () => {
    const server = await fakeLmStudio((_req, res) => {
      res.writeHead(307, { location: "http://example.com/v1/chat/completions" });
      res.end();
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "hi" }), /answered with a redirect to another address/);
      await assert.rejects(collect(llm, { prompt: "hi" }), /answered with a redirect to another address/);
    } finally {
      await server.close();
    }
  });

  it("reports a stop during the lookup as a stop", async () => {
    const controller = new AbortController();
    const server = await fakeLmStudio((req, res) => {
      if (req.url === "/api/v1/models") {
        controller.abort();
        return; // never answers
      }
      sendJson(res, 400, { error: { message: NEW_OVERFLOW } });
    });
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "big", signal: controller.signal }), /LM Studio request stopped by user\./);
    } finally {
      await server.close();
    }
  });

  it("keeps the plain HTTP error for a failure that is not an overflow", async () => {
    const server = await fakeLmStudio((_req, res) => sendJson(res, 400, { error: { message: "Invalid model identifier" } }));
    try {
      const llm = createLmStudioLlm({ endpoint: server.endpoint, defaultModel: "qwen3-8b" });
      await assert.rejects(llm.complete({ prompt: "hi" }), /LM Studio responded with HTTP 400: .*Invalid model identifier/);
      assert.equal(server.requests.length, 1);
    } finally {
      await server.close();
    }
  });
});

describe("parseLmStudioContextOverflow", () => {
  it("reads each known wording", () => {
    assert.deepEqual(parseLmStudioContextOverflow(OLD_OVERFLOW), { requested: 15857, loaded: 4096 });
    assert.deepEqual(parseLmStudioContextOverflow(NEW_OVERFLOW), {});
    assert.deepEqual(parseLmStudioContextOverflow("greater than the context length (n_keep: 8485 >= n_ctx: 8192)"), { requested: 8485, loaded: 8192 });
    assert.deepEqual(parseLmStudioContextOverflow("Context size has been exceeded."), {});
    assert.deepEqual(parseLmStudioContextOverflow("Reached context length of 4096 tokens with model (arch: qwen3vlmoe) that does not currently support mid-generation context overflow."), { loaded: 4096 });
    assert.equal(parseLmStudioContextOverflow("Invalid model identifier"), undefined);
  });
});
