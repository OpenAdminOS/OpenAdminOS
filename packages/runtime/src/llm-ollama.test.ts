import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { classifyOllamaEndpoint, createOllamaLlm, ollamaEndpointOverride, ollamaHostEndpoint, parseContextOverflow } from "./llm-ollama.js";

describe("classifyOllamaEndpoint", () => {
  it("treats loopback and Unix socket endpoints as local", () => {
    for (const endpoint of [
      "http://localhost:11434",
      "http://localhost.:11434",
      "http://127.0.0.1:11434",
      "http://127.42.0.9:11434",
      "http://[::1]:11434",
      "http://[0:0:0:0:0:0:0:1]:11434",
      "http://[::ffff:127.0.0.1]:11434",
      "unix:/var/run/ollama.sock",
      "http+unix:/var/run/ollama.sock",
    ]) {
      assert.equal(classifyOllamaEndpoint(endpoint).isLocal, true, endpoint);
    }
  });

  it("treats LAN, internet, wildcard, and invalid endpoints as external", () => {
    for (const endpoint of [
      "http://192.168.1.10:11434",
      "http://10.0.0.5:11434",
      "https://ollama.example.com",
      "http://0.0.0.0:11434",
      "notaurl",
      "",
    ]) {
      assert.equal(classifyOllamaEndpoint(endpoint).isLocal, false, endpoint);
    }
  });
});

describe("ollamaHostEndpoint", () => {
  it("reads OLLAMA_HOST the way the Ollama client does", () => {
    for (const [value, expected] of [
      [undefined, undefined],
      ["", undefined],
      ["127.0.0.1:11434", undefined],
      ["0.0.0.0", undefined],
      ["0.0.0.0:11434", undefined],
      [":11434", undefined],
      ["0.0.0.0:11500", "http://127.0.0.1:11500"],
      [":11500", "http://127.0.0.1:11500"],
      ["localhost:8080", "http://localhost:8080"],
      ["[::]:11500", "http://127.0.0.1:11500"],
      ["[::1]:11500", "http://[::1]:11500"],
      ["http://gpu-box", "http://gpu-box:80"],
      ["https://ollama.example.com/", "https://ollama.example.com:443"],
      ["gpu-box", "http://gpu-box:11434"],
      ["ftp://gpu-box", undefined],
    ] as const) {
      assert.equal(ollamaHostEndpoint(value), expected, String(value));
    }
  });

  it("prefers the OpenAdminOS override and labels a remote OLLAMA_HOST as external", () => {
    assert.equal(
      ollamaEndpointOverride({ OPENAGENTS_OLLAMA_URL: "http://127.0.0.1:9", OLLAMA_HOST: "gpu-box" }),
      "http://127.0.0.1:9",
    );
    const remote = ollamaEndpointOverride({ OLLAMA_HOST: "gpu-box" })!;
    assert.equal(classifyOllamaEndpoint(remote).isLocal, false);
    assert.equal(classifyOllamaEndpoint(ollamaEndpointOverride({ OLLAMA_HOST: ":11500" })!).isLocal, true);
  });
});

describe("Ollama context size", () => {
  const overflow = (requested: number, available: number) =>
    JSON.stringify({ error: `request (${requested} tokens) exceeds the available context size (${available} tokens), try increasing it` });

  async function fakeOllama(options: {
    modelMax?: number;
    limit: (numCtx: number | undefined) => number;
    onShow?: (res: ServerResponse) => void;
    retryStreamError?: boolean;
    /** Reject a request that exactly fills the context too. */
    rejectAtLimit?: boolean;
    retryRedirect?: boolean;
    showStatus?: number;
    showBody?: string;
    resetOverflowBody?: boolean;
    retryMemoryError?: "http" | "stream";
    showRedirect?: boolean;
    requested?: (prompt: string) => number;
    stallOverflowBody?: (res: ServerResponse) => void;
    delayRetryMs?: (prompt: string) => number;
  }) {
    const chats: Array<{ num_ctx?: number }> = [];
    const shows: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        const body = JSON.parse(raw) as { options?: { num_ctx?: number }; messages?: Array<{ content: string }> };
        if (req.url === "/api/show") {
          shows.push(raw);
          if (options.showBody !== undefined) {
            res.end(options.showBody);
            return;
          }
          if (options.showStatus) {
            res.statusCode = options.showStatus;
            res.end("busy");
            return;
          }
          if (options.showRedirect) {
            res.writeHead(307, { location: "http://example.com/api/show" });
            res.end();
            return;
          }
          if (options.onShow) {
            options.onShow(res);
            return;
          }
          res.end(JSON.stringify({ model_info: options.modelMax ? { "qwen3.context_length": options.modelMax } : {} }));
          return;
        }
        const numCtx = body.options?.num_ctx;
        const prompt = body.messages?.at(-1)?.content ?? "";
        const requested = options.requested?.(prompt) ?? 40652;
        chats.push(numCtx === undefined ? {} : { num_ctx: numCtx });
        const available = options.limit(numCtx);
        if (requested > available || (options.rejectAtLimit && requested === available)) {
          if (options.resetOverflowBody) {
            res.writeHead(400, { "content-type": "application/json", "content-length": "500" });
            res.write("{");
            setTimeout(() => res.socket?.destroy(), 10);
            return;
          }
          if (options.stallOverflowBody) {
            res.writeHead(400, { "content-type": "application/json" });
            res.write("{");
            options.stallOverflowBody(res);
            return;
          }
          res.statusCode = 400;
          res.end(overflow(requested, options.limit(numCtx)));
          return;
        }
        if (numCtx !== undefined && options.retryMemoryError === "http") {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: "model requires more system memory (24.1 GiB) than is available (12.0 GiB)" }));
          return;
        }
        if (numCtx !== undefined && options.retryMemoryError === "stream") {
          res.end(`${JSON.stringify({ error: "unable to load full model on GPU" })}\n`);
          return;
        }
        if (numCtx !== undefined && options.retryRedirect) {
          res.writeHead(307, { location: "http://example.com/api/chat" });
          res.end();
          return;
        }
        if (numCtx !== undefined && options.retryStreamError) {
          res.end(`${JSON.stringify({ model: "m", message: { content: "partial" }, done: false })}\n${JSON.stringify({ error: "model runner has unexpectedly stopped" })}\n`);
          return;
        }
        const delay = numCtx === undefined ? 0 : options.delayRetryMs?.(prompt) ?? 0;
        if (delay > 0) {
          setTimeout(() => res.end(`${JSON.stringify({ model: "m", message: { content: "ok" }, done: true })}\n`), delay);
          return;
        }
        res.end(`${JSON.stringify({ model: "m", message: { content: "ok" }, done: true, prompt_eval_count: 40652, eval_count: 1 })}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { endpoint, chats, shows, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  it("parses Ollama's context overflow error", () => {
    assert.deepEqual(parseContextOverflow(overflow(40652, 16384)), { requested: 40652, available: 16384 });
    assert.equal(parseContextOverflow('{"error":"model not found"}'), undefined);
  });

  it("raises num_ctx up to the model's limit, retries once, and keeps it for later requests", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "m" });
      const first = await llm.complete({ prompt: "big" });
      assert.equal(first.text, "ok");
      assert.deepEqual(fake.chats, [{}, { num_ctx: 45056 }]);
      await llm.complete({ prompt: "big again" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 45056 });
      assert.equal(fake.chats.length, 3);
    } finally {
      await fake.close();
    }
  });

  it("caps num_ctx at the model's limit", async () => {
    const fake = await fakeOllama({ modelMax: 40960, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "capped" });
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 40960 });
    } finally {
      await fake.close();
    }
  });

  it("names the model's limit when the prompt is larger than the model supports", async () => {
    const fake = await fakeOllama({ modelMax: 32768, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "small" });
      await assert.rejects(llm.complete({ prompt: "big" }), /needs 40,652 tokens of context, but small supports at most 32,768/);
      assert.equal(fake.chats.length, 1);
    } finally {
      await fake.close();
    }
  });

  it("explains a memory limit when Ollama still gives less context after the retry", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: () => 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "tight" });
      await assert.rejects(llm.complete({ prompt: "big" }), /Ollama could only give tight 16,384, usually because free memory ran out/);
      assert.equal(fake.chats.length, 2);
    } finally {
      await fake.close();
    }
  });

  it("reports a stop during the model lookup as stopped by the user", async () => {
    const stop = new AbortController();
    const fake = await fakeOllama({ limit: () => 16384, onShow: () => stop.abort() });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "stopped" });
      await assert.rejects(llm.complete({ prompt: "big", signal: stop.signal }), /^Error: Ollama request stopped by user\.$/);
      assert.equal(fake.chats.length, 1);
    } finally {
      fake.close().catch(() => {});
    }
  });

  it("retries a prompt exactly at the model's limit with the limit", async () => {
    const fake = await fakeOllama({ modelMax: 40960, requested: () => 40960, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "exact" });
      assert.equal((await llm.complete({ prompt: "big" })).text, "ok");
      assert.deepEqual(fake.chats, [{}, { num_ctx: 40960 }]);
    } finally {
      await fake.close();
    }
  });

  it("refuses a redirect from the model lookup instead of retrying without a limit", async () => {
    const fake = await fakeOllama({ showRedirect: true, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "redirected" });
      await assert.rejects(llm.complete({ prompt: "big" }), /answered with a redirect to another address/);
      assert.equal(fake.chats.length, 1);
    } finally {
      await fake.close();
    }
  });

  it("reports a stop while reading an error body as stopped by the user", async () => {
    const stop = new AbortController();
    const open: ServerResponse[] = [];
    const fake = await fakeOllama({
      limit: () => 16384,
      stallOverflowBody: (res) => {
        open.push(res);
        setTimeout(() => stop.abort(), 20);
      },
    });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "stalled" });
      await assert.rejects(llm.complete({ prompt: "big", signal: stop.signal }), /^Error: Ollama request stopped by user\.$/);
    } finally {
      for (const res of open) res.destroy();
      await fake.close();
    }
  });

  it("keeps the largest context when concurrent retries finish out of order", async () => {
    const fake = await fakeOllama({
      modelMax: 131072,
      requested: (prompt) => (prompt === "huge" ? 80000 : 40652),
      limit: (numCtx) => numCtx ?? 16384,
      delayRetryMs: (prompt) => (prompt === "huge" ? 0 : 150),
    });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "concurrent" });
      await Promise.all([llm.complete({ prompt: "big" }), llm.complete({ prompt: "huge" })]);
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 84992 });
    } finally {
      await fake.close();
    }
  });

  it("retries when the loaded context already equals the model's limit and names that limit", async () => {
    const fake = await fakeOllama({ modelMax: 40960, requested: () => 40960, limit: () => 40960, rejectAtLimit: true });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "full" });
      await assert.rejects(llm.complete({ prompt: "big" }), /needs 40,960 tokens of context, but full supports at most 40,960/);
      assert.deepEqual(fake.chats, [{}, { num_ctx: 40960 }]);
    } finally {
      await fake.close();
    }
  });

  it("reports an unreachable model lookup instead of retrying without a limit", async () => {
    const fake = await fakeOllama({ limit: (numCtx) => numCtx ?? 16384, onShow: (res) => res.socket?.destroy() });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "reset" });
      await assert.rejects(llm.complete({ prompt: "big" }), /Ollama not reachable at http:\/\/127\.0\.0\.1:\d+\/api\/show/);
      assert.equal(fake.chats.length, 1);
    } finally {
      await fake.close();
    }
  });

  it("reports a model lookup that does not answer in time", async () => {
    const open: ServerResponse[] = [];
    const fake = await fakeOllama({ limit: (numCtx) => numCtx ?? 16384, onShow: (res) => {
      open.push(res);
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
    } });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "slow", lookupTimeoutMs: 100 });
      await assert.rejects(llm.complete({ prompt: "big" }), /did not report the model's context limit within 100ms/);
      assert.equal(fake.chats.length, 1);
    } finally {
      for (const res of open) res.destroy();
      await fake.close();
    }
  });

  it("does not keep a raised context when the retry's stream fails", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryStreamError: true });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "broken" });
      await assert.rejects(llm.complete({ prompt: "big" }), /model runner has unexpectedly stopped/);
      await assert.rejects(llm.complete({ prompt: "big" }));
      assert.deepEqual(fake.chats.at(-2), {});
    } finally {
      await fake.close();
    }
  });

  it("leaves a request that fits unchanged: no num_ctx and no model lookup", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: () => 65536 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "fits" });
      assert.equal((await llm.complete({ prompt: "big" })).text, "ok");
      assert.deepEqual(fake.chats, [{}]);
      assert.equal(fake.shows.length, 0);
    } finally {
      await fake.close();
    }
  });

  it("leaves room for the caller's maxTokens instead of the default reserve", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "budget" });
      await llm.complete({ prompt: "big", maxTokens: 10000 });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 51200 });
      assert.equal(fake.shows.length, 1);
    } finally {
      await fake.close();
    }
  });

  it("refuses a redirect on the retry", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryRedirect: true });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "moved" });
      await assert.rejects(llm.complete({ prompt: "big" }), /answered with a redirect to another address/);
      assert.equal(fake.chats.length, 2);
    } finally {
      await fake.close();
    }
  });

  it("reports a model lookup that answers with an HTTP error", async () => {
    const fake = await fakeOllama({ showStatus: 503, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "busy" });
      await assert.rejects(llm.complete({ prompt: "big" }), /could not report the model's context limit: HTTP 503/);
      assert.equal(fake.chats.length, 1);
    } finally {
      await fake.close();
    }
  });

  it("reports a connection reset while reading an error body as unreachable", async () => {
    const fake = await fakeOllama({ resetOverflowBody: true, limit: () => 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "reset-body" });
      await assert.rejects(llm.complete({ prompt: "big" }), /^Error: Ollama not reachable at http:\/\/127\.0\.0\.1:\d+\/api\/chat: /);
    } finally {
      await fake.close();
    }
  });

  it("keeps the raised context even when the caller stops reading at the last chunk", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "early-exit" });
      for await (const chunk of llm.stream({ prompt: "big" })) {
        if (chunk.done) break;
      }
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 45056 });
      assert.equal(fake.chats.length, 3);
      assert.equal(fake.shows.length, 1);
    } finally {
      await fake.close();
    }
  });

  for (const [label, showBody, message] of [
    ["an HTML page", "<html>proxy error</html>", /the answer from http:\/\/127\.0\.0\.1:\d+\/api\/show was not JSON/],
    ["a JSON error", JSON.stringify({ error: "model is loading" }), /answered with an error: model is loading/],
  ] as const) {
    it(`reports a model lookup that answers with ${label} instead of retrying without a limit`, async () => {
      const fake = await fakeOllama({ showBody, limit: (numCtx) => numCtx ?? 16384 });
      try {
        const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "invalid" });
        await assert.rejects(llm.complete({ prompt: "big" }), message);
        assert.equal(fake.chats.length, 1);
      } finally {
        await fake.close();
      }
    });
  }

  it("retries without a cap when a valid model lookup has no context metadata", async () => {
    const fake = await fakeOllama({ showBody: JSON.stringify({ capabilities: ["completion"] }), limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "no-metadata" });
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 45056 });
    } finally {
      await fake.close();
    }
  });

  it("keeps the lookup diagnostic for a structured error answer", async () => {
    const fake = await fakeOllama({ showBody: JSON.stringify({ error: { toString: "invalid" } }), limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "structured" });
      await assert.rejects(llm.complete({ prompt: "big" }), /answered with an error: \{"toString":"invalid"\}/);
      assert.equal(fake.chats.length, 1);
    } finally {
      await fake.close();
    }
  });

  it("names the model lookup when the overall deadline passes during it", async () => {
    const open: ServerResponse[] = [];
    const fake = await fakeOllama({ limit: (numCtx) => numCtx ?? 16384, onShow: (res) => open.push(res) });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "deadline", timeoutMs: 150 });
      await assert.rejects(llm.complete({ prompt: "big" }), /^Error: Ollama timed out after 150ms at http:\/\/127\.0\.0\.1:\d+\/api\/show\.$/);
    } finally {
      for (const res of open) res.destroy();
      await fake.close();
    }
  });

  for (const mode of ["http", "stream"] as const) {
    it(`reports a memory failure on the retry (${mode}) with both context sizes`, async () => {
      const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryMemoryError: mode });
      try {
        const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "heavy" });
        await assert.rejects(
          llm.complete({ prompt: "big" }),
          /^Error: Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could not load heavy with 45,056, usually because free memory ran out\. Ollama said: /,
        );
        assert.equal(fake.chats.length, 2);
        await assert.rejects(llm.complete({ prompt: "big" }));
        assert.deepEqual(fake.chats.at(-2), {});
      } finally {
        await fake.close();
      }
    });
  }
});
