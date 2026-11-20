import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getEventListeners } from "node:events";
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
    retryMemoryError?: readonly ["http" | "stream", string];
    showRedirect?: boolean;
    requested?: (prompt: string) => number;
    stallOverflowBody?: (res: ServerResponse) => void;
    delayRetryMs?: (prompt: string) => number;
    /** Wait this long before answering a request with a context overflow. */
    delayOverflowMs?: number;
    /** Called when a request with num_ctx arrives. */
    onRetry?: () => void;
    /** A request with num_ctx streams one token, then this error. */
    retryPartialError?: string;
    /** A request with num_ctx streams one token, then this takes over the response. */
    retryStallAfterToken?: (res: ServerResponse) => void;
    /** A request with num_ctx sends a token and the final record in one write. */
    retryOneWrite?: boolean;
    /** A request with num_ctx gets Ollama's overflow without token counts. */
    retryPromptTooLong?: boolean;
    /** A request with this num_ctx waits, then gets this memory error. */
    failCtx?: { numCtx: number; delayMs: number; error: string };
    /** Send one chunk on the first request or the retry, then keep the stream open. */
    stallStream?: { on: "first" | "retry"; open: ServerResponse[] };
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
        if (numCtx !== undefined) options.onRetry?.();
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
          if (options.delayOverflowMs) {
            setTimeout(() => res.end(overflow(requested, options.limit(numCtx))), options.delayOverflowMs);
            return;
          }
          res.end(overflow(requested, options.limit(numCtx)));
          return;
        }
        if (numCtx !== undefined && options.retryMemoryError) {
          const [mode, text] = options.retryMemoryError;
          if (mode === "http") {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: text }));
          } else {
            res.end(`${JSON.stringify({ error: text })}\n`);
          }
          return;
        }
        if (numCtx !== undefined && options.retryRedirect) {
          res.writeHead(307, { location: "http://example.com/api/chat" });
          res.end();
          return;
        }
        if (options.failCtx && numCtx === options.failCtx.numCtx) {
          const { delayMs, error } = options.failCtx;
          setTimeout(() => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error }));
          }, delayMs);
          return;
        }
        if (numCtx !== undefined && options.retryPromptTooLong) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "the prompt is longer than the context length currently available to the model; shorten the prompt, adjust the context length in settings, or use a model with a longer context length" }));
          return;
        }
        if (numCtx !== undefined && options.retryPartialError) {
          res.end(`${JSON.stringify({ model: "m", message: { content: "partial" }, done: false })}\n${JSON.stringify({ error: options.retryPartialError })}\n`);
          return;
        }
        if (numCtx !== undefined && options.retryStallAfterToken) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(`${JSON.stringify({ model: "m", message: { content: "partial" }, done: false })}\n`);
          options.retryStallAfterToken(res);
          return;
        }
        if (numCtx !== undefined && options.retryOneWrite) {
          res.end(`${JSON.stringify({ model: "m", message: { content: "a" }, done: false })}\n${JSON.stringify({ model: "m", message: { content: "b" }, done: true })}\n`);
          return;
        }
        if (numCtx !== undefined && options.retryStreamError) {
          res.end(`${JSON.stringify({ model: "m", message: { content: "partial" }, done: false })}\n${JSON.stringify({ error: "model runner has unexpectedly stopped" })}\n`);
          return;
        }
        if (options.stallStream && (numCtx === undefined) === (options.stallStream.on === "first")) {
          res.writeHead(200, { "content-type": "application/x-ndjson" });
          res.write(`${JSON.stringify({ model: "m", message: { content: "partial" }, done: false })}\n`);
          options.stallStream.open.push(res);
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
    return { endpoint, chats, shows, options, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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
    ["JSON that is not an object", "[]", /the answer from http:\/\/127\.0\.0\.1:\d+\/api\/show was not a JSON object/],
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

  it("gives the model lookup its own budget instead of the first request's", async () => {
    const fake = await fakeOllama({
      modelMax: 131072,
      limit: (numCtx) => numCtx ?? 16384,
      onShow: (res) => setTimeout(() => res.end(JSON.stringify({ model_info: { "qwen3.context_length": 131072 } })), 800),
    });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "slow-lookup", timeoutMs: 500 });
      assert.equal((await llm.complete({ prompt: "big" })).text, "ok");
      assert.deepEqual(fake.chats, [{}, { num_ctx: 45056 }]);
    } finally {
      await fake.close();
    }
  });

  it("gives the retry a fresh timeout instead of what the first request left", async () => {
    // Each request takes 300ms of a 500ms budget; together they take 600ms.
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, delayOverflowMs: 300, delayRetryMs: () => 300 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "slow-machine", timeoutMs: 500 });
      assert.equal((await llm.complete({ prompt: "big" })).text, "ok");
      assert.deepEqual(fake.chats, [{}, { num_ctx: 45056 }]);
    } finally {
      await fake.close();
    }
  });

  it("names the retry when the retry times out", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, delayRetryMs: () => 1000 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "slow-retry", timeoutMs: 500 });
      await assert.rejects(
        llm.complete({ prompt: "big" }),
        /^Error: Ollama timed out after 500ms at http:\/\/127\.0\.0\.1:\d+\/api\/chat on the retry with a 45,056 token context\.$/,
      );
    } finally {
      await fake.close();
    }
  });

  it("names the first request when it times out", async () => {
    const fake = await fakeOllama({ limit: () => 16384, delayOverflowMs: 1000 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "slow-first", timeoutMs: 500 });
      await assert.rejects(llm.complete({ prompt: "big" }), /^Error: Ollama timed out after 500ms at http:\/\/127\.0\.0\.1:\d+\/api\/chat\.$/);
      assert.equal(fake.shows.length, 0);
    } finally {
      await fake.close();
    }
  });

  it("names the kept context when a request that sends it times out", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "slow-kept", timeoutMs: 500 });
      await llm.complete({ prompt: "big" });
      fake.options.delayRetryMs = () => 1000;
      await assert.rejects(
        llm.complete({ prompt: "big" }),
        /^Error: Ollama timed out after 500ms at http:\/\/127\.0\.0\.1:\d+\/api\/chat with the 45,056 token context kept from an earlier request\.$/,
      );
    } finally {
      await fake.close();
    }
  });

  it("stops the retry at once when the user stops", async () => {
    const stop = new AbortController();
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, delayRetryMs: () => 2000, onRetry: () => stop.abort() });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "stop-retry", timeoutMs: 5000 });
      const started = Date.now();
      await assert.rejects(llm.complete({ prompt: "big", signal: stop.signal }), /^Error: Ollama request stopped by user\.$/);
      assert.ok(Date.now() - started < 1000);
      assert.equal(fake.chats.length, 2);
    } finally {
      fake.close().catch(() => {});
    }
  });

  for (const failure of [
    ["http", "model requires more system memory (24.1 GiB) than is available (12.0 GiB)"],
    ["stream", "ggml_vulkan: Device memory allocation failed: VK_ERROR_OUT_OF_DEVICE_MEMORY"],
  ] as const) {
    it(`drops the kept context when a later request that sends it hits a memory failure (${failure[0]})`, async () => {
      const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
      try {
        const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: `kept-memory-${failure[0]}` });
        await llm.complete({ prompt: "big" });
        fake.options.retryMemoryError = failure;
        await assert.rejects(
          llm.complete({ prompt: "big" }),
          /^Error: Ollama could not load kept-memory-\w+ with the 45,056 token context size kept from an earlier request, usually because free memory ran out\. The next request starts from Ollama's default context size\. Ollama said: /,
        );
        assert.deepEqual(fake.chats, [{}, { num_ctx: 45056 }, { num_ctx: 45056 }]);
        fake.options.retryMemoryError = undefined;
        fake.options.limit = () => 65536;
        await llm.complete({ prompt: "big" });
        assert.deepEqual(fake.chats.at(-1), {});
      } finally {
        await fake.close();
      }
    });
  }

  it("drops the kept context when Ollama runs out of memory after the answer started", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-partial" });
      await llm.complete({ prompt: "big" });
      fake.options.retryPartialError = "ggml_vulkan: Device memory allocation failed: VK_ERROR_OUT_OF_DEVICE_MEMORY";
      await assert.rejects(
        llm.complete({ prompt: "big" }),
        /^Error: Ollama failed partway through an answer from kept-partial with the 45,056 token context size kept from an earlier request, usually because free memory ran out\./,
      );
      fake.options.retryPartialError = undefined;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("drops the kept context on Ollama's overflow without token counts", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-no-counts" });
      await llm.complete({ prompt: "big" });
      fake.options.retryPromptTooLong = true;
      await assert.rejects(
        llm.complete({ prompt: "big" }),
        /^Error: Ollama context size too small: This request did not fit in the 45,056 token context kept from an earlier request\. The next request starts from Ollama's default context size\. Ollama said: /,
      );
      fake.options.retryPromptTooLong = false;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("names the retry's size when the retry runs out of memory after its answer started", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "retry-partial" });
      await llm.complete({ prompt: "big" });
      fake.options.requested = (prompt) => (prompt === "huge" ? 80000 : 40652);
      fake.options.retryPartialError = "out of memory";
      await assert.rejects(
        llm.complete({ prompt: "huge" }),
        /^Error: Ollama failed partway through an answer from retry-partial on the retry with a 84,992 token context size, usually because free memory ran out\./,
      );
      assert.deepEqual(fake.chats.slice(2), [{ num_ctx: 45056 }, { num_ctx: 84992 }]);
      fake.options.retryPartialError = undefined;
      fake.options.limit = () => 131072;
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("drops a size a concurrent request kept when this request's retry with it runs out of memory", async () => {
    let lookups = 0;
    const answerShow = (res: ServerResponse) => res.end(JSON.stringify({ model_info: { "qwen3.context_length": 131072 } }));
    const fake = await fakeOllama({
      limit: (numCtx) => numCtx ?? 16384,
      onShow: (res) => {
        lookups += 1;
        if (lookups === 1) {
          answerShow(res);
          return;
        }
        // B's lookup waits until A has kept 45,056; B's retry then runs out of memory.
        setTimeout(() => {
          fake.options.retryMemoryError = ["http", "model requires more system memory (24.1 GiB) than is available (12.0 GiB)"];
          answerShow(res);
        }, 200);
      },
    });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "concurrent-memory" });
      // Whichever lookup arrives first is answered first.
      const results = await Promise.allSettled([llm.complete({ prompt: "big" }), llm.complete({ prompt: "big" })]);
      assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      assert.match(String(failed.reason), /could not load concurrent-memory with 45,056/);
      fake.options.retryMemoryError = undefined;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("does not keep a retry's size that a newer request saw fail while the retry's last record waited", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryOneWrite: true });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "late-retry" });
      // The older request reads its first token; its final record stays buffered.
      const older = llm.stream({ prompt: "big" })[Symbol.asyncIterator]();
      assert.equal((await older.next()).value?.delta, "a");
      fake.options.retryOneWrite = false;
      fake.options.retryMemoryError = ["http", "model requires more system memory (24.1 GiB) than is available (12.0 GiB)"];
      await assert.rejects(llm.complete({ prompt: "big" }), /could not load late-retry with 45,056/);
      while (!(await older.next()).done) {
        // Drain the older stream; its final record arrives after the failure.
      }
      fake.options.retryMemoryError = undefined;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("does not forget a size again that a newer request restored while this request's retry ran", async () => {
    let olderPhase = false;
    const fake = await fakeOllama({
      modelMax: 131072,
      requested: (prompt) => (prompt === "huge" ? 80000 : 40652),
      limit: (numCtx) => {
        if (numCtx === 45056) olderPhase = false;
        return olderPhase && numCtx === 84992 ? 16384 : numCtx ?? 16384;
      },
    });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "restored" });
      await llm.complete({ prompt: "huge" });
      // The older request finds 84,992 no longer fits, forgets it and retries at 45,056, which fails late.
      olderPhase = true;
      fake.options.failCtx = { numCtx: 45056, delayMs: 300, error: "model requires more system memory (24.1 GiB) than is available (12.0 GiB)" };
      const older = llm.complete({ prompt: "big" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Meanwhile a newer request raises 84,992 again and keeps it.
      await llm.complete({ prompt: "huge" });
      await assert.rejects(older, /could not load restored with 45,056/);
      const before = fake.chats.length;
      await llm.complete({ prompt: "huge" });
      // One request with the restored size, no overflow and retry.
      assert.deepEqual(fake.chats.slice(before), [{ num_ctx: 84992 }]);
    } finally {
      await fake.close();
    }
  });

  it("drops the kept context on an overflow with token counts in the stream", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-stream-overflow" });
      await llm.complete({ prompt: "big" });
      fake.options.retryPartialError = "request (50000 tokens) exceeds the available context size (16384 tokens), try increasing it";
      await assert.rejects(llm.complete({ prompt: "big" }), /^Error: Ollama context size too small: This request needs 50,000 tokens of context, but Ollama could only give kept-stream-overflow 16,384/);
      assert.equal(fake.chats.length, 3);
      fake.options.retryPartialError = undefined;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("does not blame memory when Ollama gave all of the kept context and the request outgrew it", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-outgrown" });
      await llm.complete({ prompt: "big" });
      fake.options.retryPartialError = "request (50000 tokens) exceeds the available context size (45056 tokens), try increasing it";
      await assert.rejects(llm.complete({ prompt: "big" }), /^Error: Ollama context size too small: This request needs 50,000 tokens of context, more than the 45,056 Ollama loaded for kept-outgrown\.$/);
      fake.options.retryPartialError = undefined;
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 45056 });
    } finally {
      await fake.close();
    }
  });

  it("gives a retry that gets Ollama's overflow without token counts a context size message", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryPromptTooLong: true });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "retry-no-counts" });
      await assert.rejects(
        llm.complete({ prompt: "big" }),
        /^Error: Ollama context size too small: This request did not fit in the 45,056 token context of the retry\. Ollama said: \{"error":"the prompt is longer/,
      );
      assert.deepEqual(fake.chats, [{}, { num_ctx: 45056 }]);
    } finally {
      await fake.close();
    }
  });

  it("names the retry when the retry stalls after its first token", async () => {
    const open: ServerResponse[] = [];
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryStallAfterToken: (res) => open.push(res) });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "stall-retry", timeoutMs: 500 });
      await assert.rejects(
        llm.complete({ prompt: "big" }),
        /^Error: Ollama timed out after 500ms at http:\/\/127\.0\.0\.1:\d+\/api\/chat on the retry with a 45,056 token context\.$/,
      );
    } finally {
      for (const res of open) res.destroy();
      await fake.close();
    }
  });

  it("stops before a buffered final record and does not keep the raised context", async () => {
    const stop = new AbortController();
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryOneWrite: true });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "stop-buffered" });
      const seen: string[] = [];
      await assert.rejects(
        (async () => {
          for await (const chunk of llm.stream({ prompt: "big", signal: stop.signal })) {
            seen.push(chunk.delta);
            stop.abort();
          }
        })(),
        /^Error: Ollama request stopped by user\.$/,
      );
      assert.deepEqual(seen, ["a"]);
      fake.options.retryOneWrite = false;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("keeps the kept context when a larger prompt is beyond the model's limit", async () => {
    const fake = await fakeOllama({ modelMax: 65536, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-too-big" });
      await llm.complete({ prompt: "big" });
      fake.options.requested = (prompt) => (prompt === "huge" ? 80000 : 40652);
      await assert.rejects(llm.complete({ prompt: "huge" }), /needs 80,000 tokens of context, but kept-too-big supports at most 65,536/);
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 45056 });
    } finally {
      await fake.close();
    }
  });

  it("keeps the kept context when the user stops the retry for a larger prompt", async () => {
    const stop = new AbortController();
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-stopped" });
      await llm.complete({ prompt: "big" });
      fake.options.requested = (prompt) => (prompt === "huge" ? 80000 : 40652);
      fake.options.delayRetryMs = (prompt) => (prompt === "huge" ? 2000 : 0);
      fake.options.onRetry = () => {
        if (fake.chats.length === 4) stop.abort();
      };
      await assert.rejects(llm.complete({ prompt: "huge", signal: stop.signal }), /^Error: Ollama request stopped by user\.$/);
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 84992 });
      fake.options.onRetry = undefined;
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 45056 });
    } finally {
      fake.close().catch(() => {});
    }
  });

  it("drops the kept context when a request that sends it overflows and the retry fails", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-overflow" });
      await llm.complete({ prompt: "big" });
      // Ollama can now give only 16,384, whatever is asked for.
      fake.options.limit = () => 16384;
      await assert.rejects(llm.complete({ prompt: "big" }), /Ollama could only give kept-overflow 16,384, usually because free memory ran out/);
      assert.deepEqual(fake.chats, [{}, { num_ctx: 45056 }, { num_ctx: 45056 }, { num_ctx: 45056 }]);
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      await fake.close();
    }
  });

  it("keeps the new size when a request that sends the kept context overflows and the retry works", async () => {
    const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "kept-grow" });
      await llm.complete({ prompt: "big" });
      fake.options.requested = (prompt) => (prompt === "huge" ? 80000 : 40652);
      await llm.complete({ prompt: "huge" });
      assert.deepEqual(fake.chats.slice(2), [{ num_ctx: 45056 }, { num_ctx: 84992 }]);
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 84992 });
    } finally {
      await fake.close();
    }
  });

  for (const failure of [
    ["http", "model requires more system memory (24.1 GiB) than is available (12.0 GiB)"],
    ["stream", "unable to load full model on GPU"],
    ["http", "llama runner process has terminated: failed to reserve graph buffers"],
    ["stream", "ggml_vulkan: Device memory allocation failed: VK_ERROR_OUT_OF_DEVICE_MEMORY"],
  ] as const) {
    it(`reports a memory failure on the retry (${failure[0]}: ${failure[1]}) with both context sizes`, async () => {
      const fake = await fakeOllama({ modelMax: 131072, limit: (numCtx) => numCtx ?? 16384, retryMemoryError: failure });
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

  for (const on of ["first", "retry"] as const) {
    const request = on === "first" ? "a request" : "the context retry";
    const limit = on === "first" ? () => 131072 : (numCtx: number | undefined) => numCtx ?? 16384;

    it(`reports a stop after the first chunk of ${request} as stopped by the user`, async () => {
      const stop = new AbortController();
      const open: ServerResponse[] = [];
      const fake = await fakeOllama({ modelMax: 131072, limit, stallStream: { on, open } });
      try {
        const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: `stall-${on}` });
        const seen: string[] = [];
        await assert.rejects(
          (async () => {
            for await (const chunk of llm.stream({ prompt: "big", signal: stop.signal })) {
              seen.push(chunk.delta);
              stop.abort();
            }
          })(),
          /^Error: Ollama request stopped by user\.$/,
        );
        assert.deepEqual(seen, ["partial"]);
        assert.equal(fake.chats.length, on === "first" ? 1 : 2);
        assert.equal(getEventListeners(stop.signal, "abort").length, 0);
      } finally {
        for (const res of open) res.destroy();
        await fake.close();
      }
    });

    it(`reports the overall deadline after the first chunk of ${request} as a timeout`, async () => {
      const caller = new AbortController();
      const open: ServerResponse[] = [];
      const fake = await fakeOllama({ modelMax: 131072, limit, stallStream: { on, open } });
      try {
        const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: `deadline-${on}`, timeoutMs: 1000 });
        const seen: string[] = [];
        await assert.rejects(
          (async () => {
            for await (const chunk of llm.stream({ prompt: "big", signal: caller.signal })) seen.push(chunk.delta);
          })(),
          on === "first"
            ? /^Error: Ollama timed out after 1000ms at http:\/\/127\.0\.0\.1:\d+\/api\/chat\.$/
            : /^Error: Ollama timed out after 1000ms at http:\/\/127\.0\.0\.1:\d+\/api\/chat on the retry with a 45,056 token context\.$/,
        );
        assert.deepEqual(seen, ["partial"]);
        assert.equal(fake.chats.length, on === "first" ? 1 : 2);
        assert.equal(getEventListeners(caller.signal, "abort").length, 0);
      } finally {
        for (const res of open) res.destroy();
        await fake.close();
      }
    });
  }
});
