import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { getEventListeners } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { ContextTooSmallError } from "@openadminos/agent-sdk";
import { beginOllamaModelRead, classifyOllamaEndpoint, createInlineThinkFilter, createOllamaLlm, isReasoningWithoutAnswerError, ollamaEndpointOverride, ollamaHostEndpoint, ollamaThinkSetting, ollamaModelName, parseContextOverflow, recordOllamaModelFamily, recordOllamaModelList, refreshOllamaModelFamily } from "./llm-ollama.js";

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

  interface HeldFailure {
    failCtx: { numCtx: number; error: string; captured: () => void; released: Promise<void> };
    /** Resolves once the fake server holds the request. */
    wasCaptured: Promise<void>;
    release: () => void;
  }
  function heldFailure(numCtx: number, error: string): HeldFailure {
    let captured!: () => void;
    let release!: () => void;
    const wasCaptured = new Promise<void>((resolve) => (captured = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    return { failCtx: { numCtx, error, captured, released }, wasCaptured, release };
  }

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
    /** The first request with this num_ctx is held until released, then gets this memory error. */
    failCtx?: HeldFailure["failCtx"];
    /** Send one chunk on the first request or the retry, then keep the stream open. */
    stallStream?: { on: "first" | "retry"; open: ServerResponse[] };
  }) {
    const chats: Array<{ num_ctx?: number }> = [];
    const shows: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") { res.statusCode = 404; res.end(); return; }
        if (req.url === "/api/ps") {
          // Nothing loaded: the model loads at the size the request asks for.
          res.end(JSON.stringify({ models: [] }));
          return;
        }
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
          // Fails one request only.
          const { error, captured, released } = options.failCtx;
          options.failCtx = undefined;
          captured();
          void released.then(() => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error }));
          });
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
      // The first request already asks for room for the 10,000 token answer;
      // the model lookup then runs once more for the overflow retry.
      assert.deepEqual(fake.chats[0], { num_ctx: 16384 });
      assert.equal(fake.shows.length, 2);
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
      // One lookup for the retry, one check of the model before the kept size is reused.
      assert.equal(fake.shows.length, 2);
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
    let stoppedAt = 0;
    const fake = await fakeOllama({
      modelMax: 131072,
      limit: (numCtx) => numCtx ?? 16384,
      delayRetryMs: () => 2000,
      onRetry: () => {
        stoppedAt = Date.now();
        stop.abort();
      },
    });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "stop-retry", timeoutMs: 5000 });
      await assert.rejects(llm.complete({ prompt: "big", signal: stop.signal }), /^Error: Ollama request stopped by user\.$/);
      // Ended well before the retry's 2s answer or its 5s timeout.
      assert.ok(Date.now() - stoppedAt < 1000);
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
          /^Error: Ollama could not load kept-memory-\w+ with the 45,056 token context size kept from an earlier request, usually because free memory ran out\. Ollama said: /,
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
        /^Error: Ollama context size too small: This request did not fit in the 45,056 token context kept from an earlier request\. Ollama said: /,
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
      // Only the retry's size failed; the kept 45,056 still worked and stays.
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 45056 });
    } finally {
      await fake.close();
    }
  });

  it("drops a size a concurrent request kept when this request's retry with it runs out of memory", async () => {
    let lookups = 0;
    let releaseSecondLookup!: () => void;
    const secondLookup = new Promise<void>((resolve) => (releaseSecondLookup = resolve));
    const answerShow = (res: ServerResponse) => res.end(JSON.stringify({ model_info: { "qwen3.context_length": 131072 } }));
    const fake = await fakeOllama({
      limit: (numCtx) => numCtx ?? 16384,
      onShow: (res) => {
        lookups += 1;
        // The second lookup waits until the first request has kept 45,056.
        if (lookups === 1) answerShow(res);
        else void secondLookup.then(() => answerShow(res));
      },
    });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "concurrent-memory" });
      // Both start with nothing kept; whichever lookup arrives first is answered first.
      const runs = [llm.complete({ prompt: "big" }), llm.complete({ prompt: "big" })];
      const settled = Promise.allSettled(runs);
      await Promise.any(runs);
      // The other request's retry with 45,056 then runs out of memory.
      fake.options.retryMemoryError = ["http", "model requires more system memory (24.1 GiB) than is available (12.0 GiB)"];
      releaseSecondLookup();
      const results = await settled;
      assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
      const failed = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
      assert.match(String(failed.reason), /could not load concurrent-memory with 45,056/);
      fake.options.retryMemoryError = undefined;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      releaseSecondLookup();
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
    const held = heldFailure(45056, "model requires more system memory (24.1 GiB) than is available (12.0 GiB)");
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "restored" });
      await llm.complete({ prompt: "huge" });
      // The older request finds 84,992 no longer fits, forgets it and retries at 45,056, which fails late.
      olderPhase = true;
      fake.options.failCtx = held.failCtx;
      const olderRun = llm.complete({ prompt: "big" });
      const older = assert.rejects(olderRun, /could not load restored with 45,056/);
      // Observed at once, so an early end reports only the assertion below.
      older.catch(() => {});
      // Fails, instead of hanging, if the older request ends before the server holds it.
      const first = await Promise.race([held.wasCaptured.then(() => "held"), olderRun.then(() => "settled", () => "settled")]);
      assert.equal(first, "held");
      // Meanwhile a newer request raises 84,992 again and keeps it.
      await llm.complete({ prompt: "huge" });
      held.release();
      await older;
      const before = fake.chats.length;
      await llm.complete({ prompt: "huge" });
      // One request with the restored size, no overflow and retry.
      assert.deepEqual(fake.chats.slice(before), [{ num_ctx: 84992 }]);
    } finally {
      held.release();
      await fake.close();
    }
  });

  it("forgets the retry's size when it fails after a concurrent request kept that same size", async () => {
    const fake = await fakeOllama({
      modelMax: 131072,
      // The older request's first attempt (the third request) gets only 16,384 for the kept 45,056.
      limit: (numCtx) => (numCtx === 45056 && fake.chats.length === 3 ? 16384 : numCtx ?? 16384),
    });
    const held = heldFailure(45056, "model requires more system memory (24.1 GiB) than is available (12.0 GiB)");
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "same-size" });
      await llm.complete({ prompt: "big" });
      // The older request forgets 45,056, then retries with 45,056, which fails late.
      fake.options.failCtx = held.failCtx;
      const olderRun = llm.complete({ prompt: "big" });
      const older = assert.rejects(olderRun, /could not load same-size with 45,056/);
      // Observed at once, so an early end reports only the assertion below.
      older.catch(() => {});
      // Fails, instead of hanging, if the older request ends before the server holds it.
      const first = await Promise.race([held.wasCaptured.then(() => "held"), olderRun.then(() => "settled", () => "settled")]);
      assert.equal(first, "held");
      // Meanwhile a newer request raises 45,056 again and keeps it.
      await llm.complete({ prompt: "big" });
      held.release();
      await older;
      fake.options.limit = () => 65536;
      await llm.complete({ prompt: "small" });
      assert.deepEqual(fake.chats.at(-1), {});
    } finally {
      held.release();
      await fake.close();
    }
  });

  it("keeps a size Ollama gave in full when a prompt exactly fills it on both attempts", async () => {
    const fake = await fakeOllama({ modelMax: 40960, requested: () => 40960, limit: (numCtx) => numCtx ?? 16384 });
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "exact-kept" });
      await llm.complete({ prompt: "big" });
      assert.deepEqual(fake.chats.at(-1), { num_ctx: 40960 });
      // Ollama now rejects a prompt that exactly fills the context, on both attempts.
      fake.options.rejectAtLimit = true;
      await assert.rejects(llm.complete({ prompt: "big" }), /needs 40,960 tokens of context, but exact-kept supports at most 40,960/);
      fake.options.rejectAtLimit = false;
      fake.options.requested = () => 39000;
      const before = fake.chats.length;
      await llm.complete({ prompt: "smaller" });
      assert.deepEqual(fake.chats.slice(before), [{ num_ctx: 40960 }]);
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
      await assert.rejects(llm.complete({ prompt: "big" }), /^Error: Ollama context size too small: This request needs 50,000 tokens of context and did not fit in the 45,056 Ollama loaded for kept-outgrown\.$/);
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

describe("Ollama reasoning models", () => {
  async function fakeChat(lines: object[], options: { finalNewline?: boolean } = {}) {
    const bodies: Array<{ think?: unknown }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") { res.statusCode = 404; res.end(); return; }
        if (req.url === "/api/chat") bodies.push(JSON.parse(raw) as { think?: unknown });
        const body = lines.map((line) => JSON.stringify(line)).join("\n");
        res.end(options.finalNewline === false ? body : `${body}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { endpoint, bodies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  const thinking = (text: string) => ({ model: "gpt-oss:20b", message: { content: "", thinking: text }, done: false });

  it("asks gpt-oss for low reasoning and every other model for none", () => {
    for (const model of ["gpt-oss:20b", "gpt-oss", "gpt-oss-safeguard:20b", "hf.co/openai/gpt-oss:120b"]) {
      assert.equal(ollamaThinkSetting(model), "low", model);
    }
    for (const model of ["qwen3:8b", "my-gpt-oss-finetune:latest"]) {
      assert.equal(ollamaThinkSetting(model), false, model);
    }
    assert.equal(ollamaThinkSetting("office-report", "gptoss"), "low");
    assert.equal(ollamaThinkSetting("gpt-oss:20b", "qwen3"), false);
  });

  it("sends the think setting and returns only the answer, not the reasoning", async () => {
    const fake = await fakeChat([
      thinking("We need to produce a report."),
      { model: "gpt-oss:20b", message: { content: "# Report" }, done: true, eval_count: 5 },
    ]);
    try {
      const result = await createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss:20b" }).complete({ prompt: "p" });
      assert.equal(result.text, "# Report");
      assert.equal(fake.bodies[0]?.think, "low");
    } finally {
      await fake.close();
    }
  });

  it("fails, without yielding the reasoning, when the token limit ends the reply mid-reasoning", async () => {
    const fake = await fakeChat([
      thinking("We need to produce a concise report. Must not invent policies."),
      { model: "gpt-oss:20b", message: { content: "" }, done: true, done_reason: "length", eval_count: 1100 },
    ]);
    try {
      const seen: string[] = [];
      await assert.rejects(
        (async () => {
          for await (const chunk of createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss:20b" }).stream({ prompt: "p" })) {
            seen.push(chunk.accumulated);
          }
        })(),
        /stopped "gpt-oss:20b" at the token limit while it was still reasoning, so there is no answer/,
      );
      assert.deepEqual(seen, []);
    } finally {
      await fake.close();
    }
  });

  it("fails, without yielding it, on reasoning written inline in the content with a tag split across chunks", async () => {
    const fake = await fakeChat([
      { model: "qwen3:8b", message: { content: "<thi" }, done: false },
      { model: "qwen3:8b", message: { content: "nk>We need to produce a report." }, done: false },
      { model: "qwen3:8b", message: { content: " Must not invent policies." }, done: true, done_reason: "length", eval_count: 1100 },
    ]);
    try {
      const seen: string[] = [];
      await assert.rejects(
        (async () => {
          for await (const chunk of createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "qwen3:8b" }).stream({ prompt: "p" })) {
            seen.push(chunk.accumulated);
          }
        })(),
        (error) => isReasoningWithoutAnswerError(error) && /at the token limit while it was still reasoning/.test((error as Error).message),
      );
      assert.deepEqual(seen, []);
    } finally {
      await fake.close();
    }
  });

  it("returns only the answer after an inline reasoning block", async () => {
    const fake = await fakeChat([
      { model: "qwen3:8b", message: { content: "<think>Plan the report.</th" }, done: false },
      { model: "qwen3:8b", message: { content: "ink>\n\n# Report" }, done: false },
      { model: "qwen3:8b", message: { content: " body <" }, done: true, eval_count: 9 },
    ]);
    try {
      const result = await createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "qwen3:8b" }).complete({ prompt: "p" });
      assert.equal(result.text, "\n\n# Report body <");
    } finally {
      await fake.close();
    }
  });

  it("holds back only a possible think tag and keeps other text", () => {
    const filter = createInlineThinkFilter();
    assert.equal(filter.push("a <b> <"), "a <b> ");
    assert.equal(filter.push("T"), "");
    assert.equal(filter.push("HINK>hidden</THINK>shown <thin"), "shown ");
    assert.equal(filter.flush(), "<thin");
    assert.equal(filter.reasoned, true);
    const unclosed = createInlineThinkFilter();
    assert.equal(unclosed.push("<think>never closed </thi"), "");
    assert.equal(unclosed.flush(), "");
  });

  it("fails when a reply that stopped normally has reasoning and no answer", async () => {
    const fake = await fakeChat([
      thinking("Thinking about it."),
      { model: "gpt-oss:20b", message: { content: "\n" }, done: true, done_reason: "stop", eval_count: 4 },
    ]);
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss:20b" }).complete({ prompt: "p" }),
        (error) => isReasoningWithoutAnswerError(error) && /returned only reasoning from "gpt-oss:20b" and no answer/.test((error as Error).message),
      );
    } finally {
      await fake.close();
    }
  });

  it("gives a caller that stops at the last chunk no completed blank answer", async () => {
    const fake = await fakeChat([
      thinking("Thinking about it."),
      { model: "gpt-oss:20b", message: { content: "\n" }, done: true, done_reason: "length", eval_count: 1100 },
    ]);
    try {
      const done: string[] = [];
      await assert.rejects(
        (async () => {
          for await (const chunk of createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss:20b" }).stream({ prompt: "p" })) {
            if (chunk.done) {
              done.push(chunk.accumulated);
              break;
            }
          }
        })(),
        /at the token limit while it was still reasoning/,
      );
      assert.deepEqual(done, []);
    } finally {
      await fake.close();
    }
  });

  it("reads a last record without a newline", async () => {
    const fake = await fakeChat([
      thinking("Thinking about it."),
      { model: "gpt-oss:20b", message: { content: "" }, done: true, done_reason: "length", eval_count: 1100 },
    ], { finalNewline: false });
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss:20b" }).complete({ prompt: "p" }),
        /at the token limit while it was still reasoning/,
      );
    } finally {
      await fake.close();
    }
  });

  it("fails when the body ends after reasoning without a final record", async () => {
    const fake = await fakeChat([thinking("Thinking about it.")]);
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss:20b" }).complete({ prompt: "p" }),
        /returned only reasoning from "gpt-oss:20b" and no answer/,
      );
    } finally {
      await fake.close();
    }
  });


  /** A fake /api/chat that answers by the think value each request sent. */
  async function fakeByThink(answer: (think: unknown) => { status?: number; body: string }) {
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") { res.statusCode = 404; res.end(); return; }
        const think = (JSON.parse(raw) as { think?: unknown }).think;
        thinks.push(think);
        const reply = answer(think);
        res.statusCode = reply.status ?? 200;
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { endpoint, thinks, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }
  const stream = (...lines: object[]) => `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
  const rejected = { status: 400, body: JSON.stringify({ error: 'think value "low" is not supported for this model' }) };
  const answered = stream({ model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 });

  it("asks again without a level when a model named like gpt-oss rejects it, and remembers that", async () => {
    const fake = await fakeByThink((think) => (think === false ? { body: answered } : rejected));
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss-office" });
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      assert.deepEqual(fake.thinks, ["low", false, false]);
    } finally {
      await fake.close();
    }
  });

  it("asks a model that reasons although asked not to for the lowest level next time", async () => {
    const fake = await fakeByThink(() => ({
      body: stream(
        { model: "m", message: { content: "", thinking: "Thinking." }, done: false },
        { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
      ),
    }));
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "office-report" });
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      assert.deepEqual(fake.thinks, [false, "low"]);
    } finally {
      await fake.close();
    }
  });

  it("answers every request for a model that rejects a level and reasons anyway, with at most one retry each", async () => {
    const fake = await fakeByThink((think) => (think === false
      ? { body: stream(
        { model: "m", message: { content: "", thinking: "Thinking." }, done: false },
        { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
      ) }
      : rejected));
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss-qwen-copy" });
      for (let i = 0; i < 3; i += 1) assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      assert.ok(fake.thinks.length <= 6, JSON.stringify(fake.thinks));
      assert.equal(fake.thinks.filter((think) => think === false).length, 3);
    } finally {
      await fake.close();
    }
  });

  it("keeps the family Ollama reported over what a reply suggests", async () => {
    const fake = await fakeByThink(() => ({
      body: stream(
        { model: "m", message: { content: "", thinking: "Thinking." }, done: false },
        { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
      ),
    }));
    try {
      recordOllamaModelFamily(fake.endpoint, "team-model", { digest: "sha256:qwen", details: { family: "qwen3" } });
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "team-model" });
      await llm.complete({ prompt: "p" });
      await llm.complete({ prompt: "p" });
      assert.deepEqual(fake.thinks, [false, false]);
    } finally {
      await fake.close();
    }
  });

  it("ignores a reply from a model version that was replaced while it answered", async () => {
    const thinks: unknown[] = [];
    let endpoint = "";
    let replaceDuringReply = true;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") { res.statusCode = 404; res.end(); return; }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        // A provider check records another version under the name before the old reply ends.
        if (replaceDuringReply) recordOllamaModelFamily(endpoint, "swapped-model", { digest: "sha256:new" });
        replaceDuringReply = false;
        res.end(stream(
          { model: "m", message: { content: "", thinking: "Thinking." }, done: false },
          { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
        ));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      recordOllamaModelFamily(endpoint, "swapped-model", { digest: "sha256:old" });
      const llm = createOllamaLlm({ endpoint, defaultModel: "swapped-model" });
      await llm.complete({ prompt: "p" });
      await llm.complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses the family the provider check read, before the first request, for copies under any name", async () => {
    const fake = await fakeByThink(() => ({ body: answered }));
    try {
      recordOllamaModelFamily(`${fake.endpoint}/`, "office-report", { details: { family: "gptoss" } });
      recordOllamaModelFamily(fake.endpoint, "gpt-oss-office", { model_info: { "general.architecture": "qwen3" } });
      recordOllamaModelFamily(fake.endpoint, "renamed-oss", { details: { family: "gpt-oss" } });
      await createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "office-report" }).complete({ prompt: "p" });
      await createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss-office" }).complete({ prompt: "p" });
      await createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "renamed-oss" }).complete({ prompt: "p" });
      assert.deepEqual(fake.thinks, ["low", false, "low"]);
    } finally {
      await fake.close();
    }
  });

  it("asks again without a level when Ollama says the model does not support thinking", async () => {
    const unsupported = { status: 400, body: JSON.stringify({ error: '"gpt-oss-plain" does not support thinking' }) };
    const fake = await fakeByThink((think) => (think === false ? { body: answered } : unsupported));
    try {
      const llm = createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss-plain" });
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      assert.deepEqual(fake.thinks, ["low", false, false]);
    } finally {
      await fake.close();
    }
  });


  it("reads the model's current family and version before a send, so a replacement that accepts a level is not sent one", async () => {
    let installed = { digest: "sha256:qwen", family: "qwen3" };
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "team-model:latest", digest: installed.digest, details: { family: installed.family } }] }));
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // The provider check saw gpt-oss under this name, and an answer confirmed it.
      recordOllamaModelFamily(endpoint, "team-model", { digest: "sha256:oss", details: { family: "gptoss" } });
      // Since then the name was replaced with a Qwen model that accepts a level.
      await refreshOllamaModelFamily(endpoint, "team-model");
      await createOllamaLlm({ endpoint, defaultModel: "team-model" }).complete({ prompt: "p" });
      installed = { digest: "sha256:oss-2", family: "gpt-oss" };
      await refreshOllamaModelFamily(endpoint, "team-model");
      await createOllamaLlm({ endpoint, defaultModel: "team-model" }).complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, "low"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lets the send go ahead when the model list cannot be read", async () => {
    await assert.doesNotReject(refreshOllamaModelFamily("http://127.0.0.1:9", "unreachable-model", 200));
  });


  it("reads the model's family before each request, so one adapter follows a model replaced between requests", async () => {
    let installed = { digest: "sha256:oss", family: "gptoss" };
    const trace: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          trace.push("tags");
          res.end(JSON.stringify({ models: [{ name: "team-model:latest", digest: installed.digest, details: { family: installed.family } }] }));
          return;
        }
        trace.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "team-model", refreshModelFamily: true });
      await llm.complete({ prompt: "p" });
      installed = { digest: "sha256:qwen", family: "qwen3" };
      await llm.complete({ prompt: "p" });
      assert.deepEqual(trace, ["tags", "low", "tags", false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("fails a reply whose only reasoning is whitespace, without a completed chunk", async () => {
    const fake = await fakeChat([
      { model: "gpt-oss:20b", message: { content: "", thinking: "\n" }, done: false },
      { model: "gpt-oss:20b", message: { content: "" }, done: true, done_reason: "length", eval_count: 1100 },
    ]);
    try {
      const done: string[] = [];
      await assert.rejects(
        (async () => {
          for await (const chunk of createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "gpt-oss:20b" }).stream({ prompt: "p" })) {
            if (chunk.done) done.push(chunk.accumulated);
          }
        })(),
        /at the token limit while it was still reasoning/,
      );
      assert.deepEqual(done, []);
    } finally {
      await fake.close();
    }
  });

  it("keeps the newest model list read when an older one ends after it", async () => {
    const thinks: unknown[] = [];
    let tagsCalls = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          tagsCalls += 1;
          // The first read saw gpt-oss and answers late; the second sees the Qwen that replaced it.
          const [delay, family, digest] = tagsCalls === 1 ? [150, "gptoss", "sha256:oss"] : [0, "qwen3", "sha256:qwen"];
          setTimeout(() => res.end(JSON.stringify({ models: [{ name: "raced-model:latest", digest, details: { family } }] })), delay);
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const older = refreshOllamaModelFamily(endpoint, "raced-model");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await refreshOllamaModelFamily(endpoint, "raced-model");
      await older;
      await createOllamaLlm({ endpoint, defaultModel: "raced-model" }).complete({ prompt: "p" });
      assert.deepEqual(thinks, [false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("matches a model under its full name, its short name and its default tag", async () => {
    assert.equal(ollamaModelName("registry.ollama.ai/library/Team-Model:latest"), "team-model:latest");
    assert.equal(ollamaModelName("team-model"), "team-model:latest");
    assert.equal(ollamaModelName("hf.co/org/model:Q4"), "hf.co/org/model:q4");
    assert.equal(ollamaModelName("https://registry.ollama.ai/library/office-report:latest"), "office-report:latest");
    assert.equal(ollamaModelName("registry.ollama.ai/team/office-report"), "team/office-report:latest");
    assert.equal(ollamaModelName("office-report:latest:local"), "office-report:latest");
    assert.equal(ollamaModelName("office-report:LOCAL"), "office-report:local");
    assert.equal(ollamaModelName("office-report:cloud"), "office-report:cloud");
    const fake = await fakeByThink(() => ({ body: answered }));
    try {
      recordOllamaModelFamily(fake.endpoint, "full-name-model:latest", { details: { family: "gptoss" } });
      await createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "registry.ollama.ai/library/full-name-model:latest" }).complete({ prompt: "p" });
      await createOllamaLlm({ endpoint: fake.endpoint, defaultModel: "full-name-model" }).complete({ prompt: "p" });
      assert.deepEqual(fake.thinks, ["low", "low"]);
    } finally {
      await fake.close();
    }
  });


  it("ignores a provider check's model list read that started before the adapter's", async () => {
    const family = "qwen3";
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "office-report:latest", digest: `sha256:${family}`, details: { family } }] }));
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // The provider check starts while the name is gpt-oss; Qwen replaces it before the adapter reads.
      const checkRead = beginOllamaModelRead();
      await createOllamaLlm({ endpoint, defaultModel: "office-report" }).complete({ prompt: "p" });
      // The provider check's older snapshot ends last.
      recordOllamaModelFamily(endpoint, "office-report:latest", { digest: "sha256:gptoss", details: { family: "gptoss" } }, checkRead);
      await createOllamaLlm({ endpoint, defaultModel: "office-report", refreshModelFamily: false }).complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reads the model list by default, so an adapter built without options follows a renamed gpt-oss", async () => {
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "renamed-default:latest", digest: "sha256:a", details: { family: "gptoss" } }] }));
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await createOllamaLlm({ endpoint, defaultModel: "https://registry.ollama.ai/library/renamed-default:latest" }).complete({ prompt: "p" });
      assert.deepEqual(thinks, ["low"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("sends the retry after a context overflow with the think value of the model installed now", async () => {
    let family = "gptoss";
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "retried-model:latest", digest: `sha256:${family}`, details: { family } }] }));
          return;
        }
        if (req.url === "/api/show") {
          // Qwen replaces the name while the context limit is looked up.
          family = "qwen3";
          res.end(JSON.stringify({ model_info: { "qwen3.context_length": 131072 } }));
          return;
        }
        const body = JSON.parse(raw) as { think?: unknown; options?: { num_ctx?: number } };
        thinks.push(body.think);
        if (body.options?.num_ctx === undefined) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "request (40652 tokens) exceeds the available context size (16384 tokens), try increasing it" }));
          return;
        }
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await createOllamaLlm({ endpoint, defaultModel: "retried-model" }).complete({ prompt: "big" })).text, "ok");
      assert.deepEqual(thinks, ["low", false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("falls back to no level on the context retry when the model installed now rejects one", async () => {
    let replaced = false;
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          // Before the replacement Ollama reports gpt-oss; the replacement has no family.
          res.end(JSON.stringify({ models: [{ name: "gpt-oss-team:latest", digest: replaced ? "sha256:new" : "sha256:oss", ...(replaced ? {} : { details: { family: "gptoss" } }) }] }));
          return;
        }
        if (req.url === "/api/show") {
          replaced = true;
          res.end(JSON.stringify({ model_info: { "x.context_length": 131072 } }));
          return;
        }
        const body = JSON.parse(raw) as { think?: unknown; options?: { num_ctx?: number } };
        thinks.push(body.think);
        if (body.options?.num_ctx === undefined) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: "request (40652 tokens) exceeds the available context size (16384 tokens), try increasing it" }));
          return;
        }
        if (body.think !== false) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '"gpt-oss-team" does not support thinking' }));
          return;
        }
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await createOllamaLlm({ endpoint, defaultModel: "gpt-oss-team" }).complete({ prompt: "big" })).text, "ok");
      assert.deepEqual(thinks, ["low", "low", false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not pass what was learned before any version was known to the first version seen", async () => {
    let listed = false;
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          if (!listed) { res.statusCode = 503; res.end("busy"); return; }
          res.end(JSON.stringify({ models: [{ name: "unlisted-model:latest", digest: "sha256:replacement" }] }));
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(stream(
          { model: "m", message: { content: "", thinking: thinks.length === 1 ? "Thinking." : "" }, done: false },
          { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
        ));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "unlisted-model" });
      await llm.complete({ prompt: "p" });
      listed = true;
      await llm.complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("drops what was learned for a version when the model is listed again without one", async () => {
    let listing: Record<string, unknown> = { name: "versioned-model:latest", digest: "sha256:first" };
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [listing] }));
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(stream(
          { model: "m", message: { content: "", thinking: thinks.length === 1 ? "Thinking." : "" }, done: false },
          { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
        ));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "versioned-model" });
      await llm.complete({ prompt: "p" });
      // A replacement listed without a family or a version.
      listing = { name: "versioned-model:latest" };
      await llm.complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("forgets what was learned about a model the model list shows was removed", async () => {
    let listed = true;
    let calls = 0;
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: listed ? [{ name: "plain-alias:latest" }] : [] }));
          return;
        }
        calls += 1;
        if (!listed) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "model 'plain-alias' not found" }));
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(stream(
          { model: "m", message: { content: "", thinking: calls === 1 ? "Thinking." : "" }, done: false },
          { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
        ));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "plain-alias" });
      await llm.complete({ prompt: "p" });
      // Removed: the model list no longer has it, and the request fails.
      listed = false;
      await assert.rejects(llm.complete({ prompt: "p" }), /is not pulled/);
      // Another model is installed under the name, again without metadata.
      listed = true;
      await llm.complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("does not learn from a reply of a model that was removed while it answered", async () => {
    let listed = true;
    let calls = 0;
    const thinks: unknown[] = [];
    let endpoint = "";
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", async () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: listed ? [{ name: "inflight-alias:latest" }] : [] }));
          return;
        }
        calls += 1;
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        if (calls === 1) {
          // Another request's read sees the alias removed before this reply streams.
          listed = false;
          await refreshOllamaModelFamily(endpoint, "inflight-alias");
          listed = true;
        }
        res.end(stream(
          { model: "m", message: { content: "", thinking: calls === 1 ? "Thinking." : "" }, done: false },
          { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
        ));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "inflight-alias" });
      await llm.complete({ prompt: "p" });
      // A replacement under the name, again without metadata.
      await llm.complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("does not learn from a reply of a model the provider check saw removed while it answered", async () => {
    let calls = 0;
    const thinks: unknown[] = [];
    let endpoint = "";
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "scanned-alias:latest" }] }));
          return;
        }
        calls += 1;
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        // A Settings check reads a model list without the alias before this reply streams.
        if (calls === 1) recordOllamaModelList(endpoint, [{ name: "other-model:latest" }], beginOllamaModelRead());
        res.end(stream(
          { model: "m", message: { content: "", thinking: calls === 1 ? "Thinking." : "" }, done: false },
          { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
        ));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "scanned-alias" });
      await llm.complete({ prompt: "p" });
      await llm.complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends the level fallback to the model installed now when it was replaced by gpt-oss", async () => {
    let family: string | undefined;
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "gpt-oss-swap:latest", digest: `sha256:${family ?? "none"}`, ...(family ? { details: { family } } : {}) }] }));
          return;
        }
        const think = (JSON.parse(raw) as { think?: unknown }).think;
        thinks.push(think);
        if (thinks.length === 1) {
          // A family-less model rejects the level, and gpt-oss replaces it before the fallback.
          family = "gptoss";
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '"gpt-oss-swap" does not support thinking' }));
          return;
        }
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await createOllamaLlm({ endpoint, defaultModel: "gpt-oss-swap" }).complete({ prompt: "p" })).text, "ok");
      assert.deepEqual(thinks, ["low", "low"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("ignores a whole model list read older than one already applied for the endpoint", async () => {
    const thinks: unknown[] = [];
    let endpoint = "";
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          // The adapter's read sees the old gpt-oss copy and answers late.
          setTimeout(() => res.end(JSON.stringify({ models: [{ name: "team-alias:latest", digest: "sha256:oss", details: { family: "gptoss" } }] })), 150);
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const pending = createOllamaLlm({ endpoint, defaultModel: "team-alias" }).complete({ prompt: "p" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      // A newer Settings check finds the alias removed; a non-gpt-oss model replaces it.
      recordOllamaModelList(endpoint, [], beginOllamaModelRead());
      await pending;
      assert.deepEqual(thinks, [false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("sends the level retry with the family Ollama reports for the model now", async () => {
    let family: string | undefined;
    const thinks: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "gpt-oss-plain:latest", ...(family ? { details: { family } } : {}) }] }));
          return;
        }
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        if (thinks.length === 1) {
          // The level is rejected; the list then reports gpt-oss, still without a version.
          family = "gptoss";
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '"gpt-oss-plain" does not support thinking' }));
          return;
        }
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await createOllamaLlm({ endpoint, defaultModel: "gpt-oss-plain" }).complete({ prompt: "p" })).text, "ok");
      assert.deepEqual(thinks, ["low", "low"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("reads the family of a model asked for with Ollama's :local suffix, and sends the name as given", async () => {
    const sent: Array<{ model?: unknown; think?: unknown }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [
            { name: "office-report:latest", digest: "sha256:oss", details: { family: "gptoss" } },
            { name: "gpt-oss-office:latest", digest: "sha256:qwen", details: { family: "qwen3" } },
          ] }));
          return;
        }
        sent.push(JSON.parse(raw) as { model?: unknown; think?: unknown });
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await createOllamaLlm({ endpoint, defaultModel: "office-report:latest:local" }).complete({ prompt: "p" });
      await createOllamaLlm({ endpoint, defaultModel: "gpt-oss-office:latest:local" }).complete({ prompt: "p" });
      assert.deepEqual(sent.map((body) => [body.model, body.think]), [["office-report:latest:local", "low"], ["gpt-oss-office:latest:local", false]]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("reads a lone :local as the endpoint's Ollama does: a tag before 0.18, the default tag from 0.18", async () => {
    const serve = async (version: string) => {
      const sent: Array<[unknown, unknown]> = [];
      const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let raw = "";
        req.on("data", (part) => (raw += part));
        req.on("end", () => {
          if (req.url === "/api/version") { res.end(JSON.stringify({ version })); return; }
          if (req.url === "/api/tags") {
            // A gpt-oss copy tagged local and a Qwen under the default tag.
            res.end(JSON.stringify({ models: [
              { name: "tagged-report:local", digest: "sha256:oss", details: { family: "gptoss" } },
              { name: "tagged-report:latest", digest: "sha256:qwen", details: { family: "qwen3" } },
            ] }));
            return;
          }
          const body = JSON.parse(raw) as { model?: unknown; think?: unknown };
          sent.push([body.model, body.think]);
          res.end(answered);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      try {
        await createOllamaLlm({ endpoint, defaultModel: "tagged-report:latest" }).complete({ prompt: "p" });
        await createOllamaLlm({ endpoint, defaultModel: "tagged-report:local" }).complete({ prompt: "p" });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      return sent;
    };
    // Ollama 0.12 runs the model tagged local.
    assert.deepEqual(await serve("0.12.11"), [["tagged-report:latest", false], ["tagged-report:local", "low"]]);
    // Ollama 0.40 drops ":local" and runs the default tag, the Qwen.
    assert.deepEqual(await serve("0.40.16"), [["tagged-report:latest", false], ["tagged-report:local", false]]);
  });

  it("keeps what was learned for a lone :local under the installed model, across a provider check", async () => {
    let calls = 0;
    const thinks: unknown[] = [];
    let endpoint = "";
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/version") { res.end(JSON.stringify({ version: "0.40.16" })); return; }
        if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [{ name: "stable-report:latest", digest: "sha256:same" }] })); return; }
        calls += 1;
        thinks.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(stream(
          { model: "m", message: { content: "", thinking: calls === 1 ? "Thinking." : "" }, done: false },
          { model: "m", message: { content: "ok" }, done: true, done_reason: "stop", eval_count: 1 },
        ));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "stable-report:local" });
      await llm.complete({ prompt: "p" });
      // A provider check reads the same, unchanged list.
      recordOllamaModelList(endpoint, [{ name: "stable-report:latest", digest: "sha256:same" }], beginOllamaModelRead());
      await llm.complete({ prompt: "p" });
      assert.deepEqual(thinks, [false, "low"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("follows a server upgraded across 0.18 while the app runs, also on the level fallback", async () => {
    let version = "0.17.7";
    const sent: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/version") { res.end(JSON.stringify({ version })); return; }
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [
            { name: "upgraded-report:local", digest: "sha256:oss", details: { family: "gptoss" } },
            { name: "upgraded-report:latest", digest: "sha256:qwen", details: { family: "qwen3" } },
          ] }));
          return;
        }
        const think = (JSON.parse(raw) as { think?: unknown }).think;
        sent.push(think);
        if (sent.length === 2) {
          // The server is upgraded as this request arrives: ":local" now runs the Qwen, which rejects a level.
          version = "0.18.0";
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '"upgraded-report:local" does not support thinking' }));
          return;
        }
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "upgraded-report:local" });
      await llm.complete({ prompt: "p" });
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      // Every later request reads the version again.
      await llm.complete({ prompt: "p" });
      assert.deepEqual(sent, ["low", "low", false, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });


  it("sends the think value known right before the send, after a list read that applied while it was sized", async () => {
    let installed = { digest: "sha256:llama", family: "llama" };
    let shows = 0;
    const sent: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [{ name: "swap-report:latest", digest: installed.digest, details: { family: installed.family } }] }));
          return;
        }
        if (req.url === "/api/ps") { res.end(JSON.stringify({ models: [] })); return; }
        if (req.url === "/api/show") {
          shows += 1;
          const answer = JSON.stringify({ model_info: { "general.architecture": "llama", "llama.context_length": 131072 } });
          // The first request's sizing lookup is slow.
          if (shows === 1) setTimeout(() => res.end(answer), 150);
          else res.end(answer);
          return;
        }
        sent.push((JSON.parse(raw) as { think?: unknown }).think);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "swap-report:latest" });
      // Long enough that the request is sized before it is sent.
      const first = llm.complete({ prompt: "word ".repeat(18000) });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The name now holds a gpt-oss copy, which a second request reads.
      installed = { digest: "sha256:oss", family: "gptoss" };
      await llm.complete({ prompt: "p" });
      await first;
      assert.deepEqual(sent, ["low", "low"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends no level on the last resend when the model list never lists the model", async () => {
    const sent: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        // An alias the list omits: each read finds it missing.
        if (req.url === "/api/tags") { res.end(JSON.stringify({ models: [] })); return; }
        const think = (JSON.parse(raw) as { think?: unknown }).think;
        sent.push(think);
        if (think !== false) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '"gpt-oss-ghost:latest" does not support thinking' }));
          return;
        }
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      assert.equal((await createOllamaLlm({ endpoint, defaultModel: "gpt-oss-ghost:latest" }).complete({ prompt: "p" })).text, "ok");
      assert.deepEqual(sent, ["low", "low", false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lets a newer version read decide over an older one that finishes later", async () => {
    let versionReads = 0;
    const sent: Array<[unknown, unknown]> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/version") {
          versionReads += 1;
          // The first read was answered before the upgrade but arrives last.
          if (versionReads === 1) setTimeout(() => res.end(JSON.stringify({ version: "0.17.7" })), 150);
          else res.end(JSON.stringify({ version: "0.18.0" }));
          return;
        }
        if (req.url === "/api/tags") {
          res.end(JSON.stringify({ models: [
            { name: "race-report:local", digest: "sha256:llama", details: { family: "llama" } },
            { name: "race-report:latest", digest: "sha256:oss", details: { family: "gptoss" } },
          ] }));
          return;
        }
        const body = JSON.parse(raw) as { model?: unknown; think?: unknown };
        sent.push([body.model, body.think]);
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "race-report:local" });
      const older = llm.complete({ prompt: "p" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await llm.complete({ prompt: "p" });
      await older;
      // Both run the gpt-oss model under the default tag, as Ollama 0.18 does.
      assert.deepEqual(sent, [["race-report:local", "low"], ["race-report:local", "low"]]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps a rejection for the model that gave it when an upgrade switches models mid-request, and rolls back cleanly", async () => {
    let version = "0.17.7";
    let chats = 0;
    const sent: unknown[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        if (req.url === "/api/version") { res.end(JSON.stringify({ version })); return; }
        if (req.url === "/api/tags") {
          // gpt-oss tagged local; a Qwen under the default tag that reports no family.
          res.end(JSON.stringify({ models: [
            { name: "gpt-oss-team:local", digest: "sha256:oss", details: { family: "gptoss" } },
            { name: "gpt-oss-team:latest", digest: "sha256:qwen" },
          ] }));
          return;
        }
        chats += 1;
        if (chats === 2) version = "0.18.0";
        const think = (JSON.parse(raw) as { think?: unknown }).think;
        sent.push(think);
        // From 0.18 ":local" runs the Qwen, which rejects any level.
        if (version === "0.18.0" && think !== false) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: '"gpt-oss-team:local" does not support thinking' }));
          return;
        }
        res.end(answered);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const llm = createOllamaLlm({ endpoint, defaultModel: "gpt-oss-team:local" });
      await llm.complete({ prompt: "p" });
      // Upgraded as this request arrives: the Qwen gets the name's guess, then no level.
      assert.equal((await llm.complete({ prompt: "p" })).text, "ok");
      // Rolled back: the gpt-oss copy runs again and still gets the lowest level.
      version = "0.17.7";
      await llm.complete({ prompt: "p" });
      assert.deepEqual(sent, ["low", "low", "low", false, "low"]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

});

describe("Ollama context for an unpinned model", () => {
  const show = (pinned: boolean) => JSON.stringify({
    ...(pinned ? { parameters: "num_ctx                        16384" } : {}),
    model_info: { "general.architecture": "llama", "llama.context_length": 131072 },
  });
  function mocked(pinned: boolean, loaded: number | undefined, model = "local") {
    const chats: Array<{ num_ctx?: number }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/show") return new Response(show(pinned), { status: 200 });
      if (path === "/api/ps") return new Response(JSON.stringify({ models: loaded ? [{ name: `${model}:latest`, context_length: loaded }] : [] }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } };
      chats.push(body.options?.num_ctx === undefined ? {} : { num_ctx: body.options.num_ctx });
      return new Response(`${JSON.stringify({ model: "local", message: { content: "ok" }, done: true })}\n`, { status: 200 });
    }) as typeof fetch;
    return { chats, fetchImpl };
  }
  const longPrompt = "policy record ".repeat(8000);

  it("asks for room for a long prompt on the first request when the model is loaded smaller", async () => {
    const { chats, fetchImpl } = mocked(false, 4096);
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "local" }).complete({ prompt: longPrompt, maxTokens: 1100 });
      assert.equal(chats.length, 1, "no overflow round trip");
      assert.ok((chats[0]!.num_ctx ?? 0) > 4096, "the first request asks for more than the loaded size");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends no num_ctx for a pinned model or a short prompt, and the loaded size when it is large enough", async () => {
    const original = globalThis.fetch;
    try {
      for (const [pinned, loaded, prompt, expected] of [[true, undefined, longPrompt, {}], [false, undefined, "short", {}], [false, 262144, longPrompt, { num_ctx: 131072 }]] as const) {
        const model = `local-${String(pinned)}-${String(loaded)}`;
        const { chats, fetchImpl } = mocked(pinned, loaded, model);
        globalThis.fetch = fetchImpl;
        await createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: model }).complete({ prompt, maxTokens: 1100 });
        // A loaded size is sent explicitly (capped at the model maximum), so an
        // eviction before the request cannot reload the model smaller.
        assert.deepEqual(chats, [expected], `pinned ${String(pinned)}, loaded ${String(loaded)}`);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("names the up-front size when Ollama cannot load the model with it, in the stream or the HTTP answer", async () => {
    const original = globalThis.fetch;
    try {
      for (const mode of ["stream", "http"] as const) {
        const { fetchImpl } = mocked(false, undefined);
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
          if (new URL(String(input)).pathname !== "/api/chat") return fetchImpl(input, init);
          const error = JSON.stringify({ error: "model requires more system memory (9.1 GiB) than is available (6.2 GiB)" });
          return mode === "stream" ? new Response(`${error}\n`, { status: 200 }) : new Response(error, { status: 500 });
        }) as typeof fetch;
        await assert.rejects(
          createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: `local-memory-${mode}` }).complete({ prompt: longPrompt, maxTokens: 1100 }),
          (error: unknown) => {
            assert.match(String((error as Error).message), /tokens of context, but Ollama could not load .* with 65,536/);
            assert.match(String((error as Error).message), /free memory/);
            return true;
          },
          mode,
        );
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  // A scripted Ollama: /api/show and /api/ps answer from the given values,
  // and each /api/chat call is answered by the next handler in order.
  function scripted(options: { showBody: unknown; loaded?: () => number | undefined; model?: string }) {
    const chats: Array<number | undefined> = [];
    const handlers: Array<(numCtx: number | undefined) => Promise<Response> | Response> = [];
    const ok = () => new Response(`${JSON.stringify({ model: "m", message: { content: "ok" }, done: true })}\n`, { status: 200 });
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/show") return new Response(JSON.stringify(options.showBody), { status: 200 });
      if (path === "/api/ps") {
        const loaded = options.loaded?.();
        return new Response(JSON.stringify({ models: loaded ? [{ name: `${options.model ?? ""}:latest`, context_length: loaded }] : [] }), { status: 200 });
      }
      const numCtx = (JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } }).options?.num_ctx;
      chats.push(numCtx);
      const handler = handlers.shift();
      return handler ? handler(numCtx) : ok();
    }) as typeof fetch;
    return { chats, handlers, fetchImpl, ok };
  }
  const words = (count: number) => "word ".repeat(count);
  const unpinned = { modelfile: "FROM llama\n", model_info: { "general.architecture": "llama", "llama.context_length": 131072 } };

  it("forgets the size a refused first send asked for, so a concurrent request that sent it is not kept", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({ showBody: unpinned });
    globalThis.fetch = ollama.fetchImpl;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "concurrent" });
      // Keep 4,096 from an earlier request.
      await llm.complete({ prompt: words(2000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 4096);
      // B asks for 16,384 and its answer is held; A asks for 16,384 and is refused at 8,192.
      let releaseB!: () => void;
      const heldB = new Promise<void>((resolve) => { releaseB = resolve; });
      ollama.handlers.push(async () => { await heldB; return ollama.ok(); });
      ollama.handlers.push(() => new Response(JSON.stringify({ error: "request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it" }), { status: 400 }));
      const b = llm.complete({ prompt: words(8000), maxTokens: 1000 });
      await new Promise((resolve) => setImmediate(resolve));
      const a = llm.complete({ prompt: words(8000), maxTokens: 1000 });
      await a;
      releaseB();
      await b;
      assert.deepEqual(ollama.chats.slice(1), [16384, 16384, 10240]);
      // The next request reuses A's 10,240, not B's refused 16,384.
      await llm.complete({ prompt: words(8000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 10240);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("never reloads a model smaller than it is loaded when reusing a kept size", async () => {
    const original = globalThis.fetch;
    let loaded: number | undefined;
    const ollama = scripted({ showBody: unpinned, loaded: () => loaded, model: "loaded-larger" });
    globalThis.fetch = ollama.fetchImpl;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "loaded-larger" });
      await llm.complete({ prompt: words(2000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 4096);
      // Another client loads the model at 32,768.
      loaded = 32768;
      await llm.complete({ prompt: words(2500), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 32768);
      // A short request with the kept size keeps the larger loaded one too.
      await llm.complete({ prompt: "short", maxTokens: 100 });
      assert.equal(ollama.chats.at(-1), 32768);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reads the retry limit from the architecture key even when a rope key comes first", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({
      showBody: { model_info: { "mistral3.rope.scaling.original_context_length": 16384, "general.architecture": "mistral3", "mistral3.context_length": 262144 } },
    });
    ollama.handlers.push(() => new Response(JSON.stringify({ error: "request (20000 tokens) exceeds the available context size (4096 tokens), try increasing it" }), { status: 400 }));
    globalThis.fetch = ollama.fetchImpl;
    try {
      await createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "rope-first" }).complete({ prompt: "big", maxTokens: 1000 });
      assert.deepEqual(ollama.chats, [undefined, 21504]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("stops sending a kept size below a pin the model gained when it was created again", async () => {
    const original = globalThis.fetch;
    let pinned = false;
    const ollama = scripted({ showBody: unpinned });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show" && pinned) {
        return new Response(JSON.stringify({ parameters: "num_ctx                        16384", model_info: unpinned.model_info }), { status: 200 });
      }
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "recreated" });
      await llm.complete({ prompt: words(2000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 4096);
      // `ollama create recreated` with PARAMETER num_ctx 16384.
      pinned = true;
      await llm.complete({ prompt: words(8000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), undefined, "the request leaves the pin in charge");
      await llm.complete({ prompt: "short", maxTokens: 100 });
      assert.equal(ollama.chats.at(-1), undefined, "the dropped size is not used again");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses with the typed reason when an agent run's request exceeds a pin the adapter finds, and sends it for Chat", async () => {
    const original = globalThis.fetch;
    const pinnedShow = { parameters: "num_ctx                        16384", model_info: unpinned.model_info };
    try {
      for (const enforce of [true, false]) {
        const ollama = scripted({ showBody: pinnedShow });
        globalThis.fetch = ollama.fetchImpl;
        const request = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: `pinned-${String(enforce)}` })
          .complete({ prompt: words(18000), maxTokens: 1000, ...(enforce ? { enforceContextWindow: true } : {}) });
        if (enforce) {
          await assert.rejects(request, (error: unknown) => {
            assert.ok(error instanceof ContextTooSmallError);
            assert.equal(error.failure.limitTokens, 16384);
            return true;
          });
          assert.equal(ollama.chats.length, 0, "nothing reaches /api/chat");
        } else {
          await request;
          assert.deepEqual(ollama.chats, [undefined]);
        }
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("drops a kept size when the model is created again, even a size above its new pin", async () => {
    const original = globalThis.fetch;
    let show: unknown = { ...unpinned, modified_at: "2026-11-01T00:00:00Z" };
    const ollama = scripted({ showBody: undefined });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") return new Response(JSON.stringify(show), { status: 200 });
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "revised" });
      await llm.complete({ prompt: words(40000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 65536);
      await llm.complete({ prompt: "short", maxTokens: 100 });
      assert.equal(ollama.chats.at(-1), 65536, "the kept size is reused for the same model");
      // `ollama create revised` with PARAMETER num_ctx 16384 to save memory.
      show = { parameters: "num_ctx                        16384", model_info: unpinned.model_info, modified_at: "2026-11-20T00:00:00Z" };
      await llm.complete({ prompt: "short", maxTokens: 100 });
      assert.equal(ollama.chats.at(-1), undefined, "the new model's pin applies");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("drops a size kept by the first request when the model is created again right after it", async () => {
    const original = globalThis.fetch;
    let show: unknown = { ...unpinned, modified_at: "2026-11-01T00:00:00Z" };
    const ollama = scripted({ showBody: undefined });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") return new Response(JSON.stringify(show), { status: 200 });
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "recreated-at-once" });
      await llm.complete({ prompt: words(40000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 65536);
      show = { parameters: "num_ctx                        16384", model_info: unpinned.model_info, modified_at: "2026-11-20T00:00:00Z" };
      await llm.complete({ prompt: "short", maxTokens: 100 });
      assert.equal(ollama.chats.at(-1), undefined, "the new model's pin applies");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses an agent run's request when the model was created again with a smaller pin, before any kept size is used", async () => {
    const original = globalThis.fetch;
    let show: unknown = { ...unpinned, modified_at: "2026-11-01T00:00:00Z" };
    const ollama = scripted({ showBody: undefined });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") return new Response(JSON.stringify(show), { status: 200 });
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "recreated-smaller" });
      await llm.complete({ prompt: words(18000), maxTokens: 1000, enforceContextWindow: true });
      assert.equal(ollama.chats.length, 1);
      show = { parameters: "num_ctx                        16384", model_info: unpinned.model_info, modified_at: "2026-11-20T00:00:00Z" };
      await assert.rejects(
        llm.complete({ prompt: words(18000), maxTokens: 1000, enforceContextWindow: true }),
        (error: unknown) => error instanceof ContextTooSmallError && error.failure.limitTokens === 16384,
      );
      assert.equal(ollama.chats.length, 1, "nothing more reaches /api/chat");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("binds a size kept by a late response to the revision it was sized for, not a newer one", async () => {
    const original = globalThis.fetch;
    const revisionA = { ...unpinned, modified_at: "2026-11-01T00:00:00Z" };
    const revisionB = { parameters: "num_ctx                        16384", model_info: unpinned.model_info, modified_at: "2026-11-20T00:00:00Z" };
    let show: unknown = revisionA;
    const ollama = scripted({ showBody: undefined });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") return new Response(JSON.stringify(show), { status: 200 });
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "late-answer" });
      let releaseA!: () => void;
      const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
      ollama.handlers.push(async () => { await heldA; return ollama.ok(); });
      const a = llm.complete({ prompt: words(40000), maxTokens: 1000 });
      while (ollama.chats.length === 0) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(ollama.chats[0], 65536);
      // The model is created again with a 16,384 pin and another request reads it.
      show = revisionB;
      await llm.complete({ prompt: words(8000), maxTokens: 1000 });
      releaseA();
      await a;
      // A's 65,536 belongs to revision A, so revision B's pin applies.
      await llm.complete({ prompt: "short", maxTokens: 100 });
      assert.equal(ollama.chats.at(-1), undefined);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses an agent run's retry past a pin when Ollama counts more than the estimate, saying the model refused it", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({ showBody: { parameters: "num_ctx                        16384", model_info: unpinned.model_info } });
    ollama.handlers.push(() => new Response(JSON.stringify({ error: "request (16600 tokens) exceeds the available context size (16384 tokens), try increasing it" }), { status: 400 }));
    globalThis.fetch = ollama.fetchImpl;
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "undercounted" }).complete({ prompt: words(14000), maxTokens: 1000, enforceContextWindow: true }),
        (error: unknown) => {
          assert.ok(error instanceof ContextTooSmallError);
          assert.equal(error.failure.limitTokens, 16384);
          assert.equal(error.failure.sentToProvider, true);
          assert.match(error.message, /refused it or stopped before finishing the answer/);
          assert.doesNotMatch(error.message, /Nothing was sent/);
          return true;
        },
      );
      assert.deepEqual(ollama.chats, [undefined], "no retry past the pin");
    } finally {
      globalThis.fetch = original;
    }
  });

  for (const order of ["A then B", "B then A"] as const) {
    it(`keeps the newer revision's size when responses for two revisions finish ${order}`, async () => {
      const original = globalThis.fetch;
      const revisionA = { ...unpinned, modified_at: "2026-11-01T00:00:00Z" };
      const revisionB = { ...unpinned, modified_at: "2026-11-20T00:00:00Z" };
      let show: unknown = revisionA;
      const ollama = scripted({ showBody: undefined });
      globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname === "/api/show") return new Response(JSON.stringify(show), { status: 200 });
        return ollama.fetchImpl(input, init);
      }) as typeof fetch;
      try {
        const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: `two-revisions-${order}` });
        let releaseA!: () => void;
        let releaseB!: () => void;
        const heldA = new Promise<void>((resolve) => { releaseA = resolve; });
        const heldB = new Promise<void>((resolve) => { releaseB = resolve; });
        ollama.handlers.push(async () => { await heldA; return ollama.ok(); });
        ollama.handlers.push(async () => { await heldB; return ollama.ok(); });
        const a = llm.complete({ prompt: words(40000), maxTokens: 1000 });
        while (ollama.chats.length < 1) await new Promise((resolve) => setImmediate(resolve));
        show = revisionB;
        const b = llm.complete({ prompt: words(10000), maxTokens: 1000 });
        while (ollama.chats.length < 2) await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(ollama.chats, [65536, 16384]);
        if (order === "A then B") { releaseA(); await a; releaseB(); await b; }
        else { releaseB(); await b; releaseA(); await a; }
        await llm.complete({ prompt: words(10000), maxTokens: 1000 });
        assert.equal(ollama.chats.at(-1), 16384, "revision B keeps its own size, not A's 65,536");
      } finally {
        globalThis.fetch = original;
      }
    });
  }

  it("does not send an agent run a size Chat kept above the pin, and leaves it for Chat", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({ showBody: { parameters: "num_ctx                        16384", model_info: unpinned.model_info } });
    ollama.handlers.push(() => new Response(JSON.stringify({ error: "request (21000 tokens) exceeds the available context size (16384 tokens), try increasing it" }), { status: 400 }));
    globalThis.fetch = ollama.fetchImpl;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "chat-raised" });
      // Chat raises past the pin on an overflow.
      await llm.complete({ prompt: words(20000), maxTokens: 1000 });
      assert.deepEqual(ollama.chats, [undefined, 22528]);
      // An agent run that fits the pin sends no num_ctx.
      await llm.complete({ prompt: words(8000), maxTokens: 1000, enforceContextWindow: true });
      assert.equal(ollama.chats.at(-1), undefined);
      // Chat still uses the size it kept.
      await llm.complete({ prompt: "short", maxTokens: 100 });
      assert.equal(ollama.chats.at(-1), 22528);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not reuse a kept size another request replaced while this request's lookup was held", async () => {
    const original = globalThis.fetch;
    const revisionA = { ...unpinned, modified_at: "2026-11-01T00:00:00Z" };
    // Replaced by a smaller unpinned model with a 16,384 maximum.
    const revisionB = { model_info: { "general.architecture": "llama", "llama.context_length": 16384 }, modified_at: "2026-11-20T00:00:00Z" };
    let show: unknown = revisionA;
    let holdNextShow = false;
    let releaseShow!: () => void;
    const heldShow = new Promise<void>((resolve) => { releaseShow = resolve; });
    let showsAfterSwitch = 0;
    const ollama = scripted({ showBody: undefined });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") {
        if (holdNextShow) {
          showsAfterSwitch += 1;
          if (showsAfterSwitch === 2) await heldShow;
        }
        return new Response(JSON.stringify(show), { status: 200 });
      }
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "replaced-concurrently" });
      await llm.complete({ prompt: words(40000), maxTokens: 1000 });
      assert.equal(ollama.chats.at(-1), 65536);
      show = revisionB;
      holdNextShow = true;
      // Both requests start with the kept 65,536 for revision A.
      const first = llm.complete({ prompt: words(5000), maxTokens: 1000 });
      const second = llm.complete({ prompt: words(5000), maxTokens: 1000 });
      await first;
      assert.equal(ollama.chats.at(-1), 8192, "the first request sizes revision B");
      releaseShow();
      await second;
      assert.equal(ollama.chats.at(-1), 8192, "the second request does not send revision A's 65,536");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the pin its first lookup saw when the retry lookup omits it, on an agent run", async () => {
    const original = globalThis.fetch;
    let shows = 0;
    const ollama = scripted({ showBody: undefined });
    ollama.handlers.push(() => new Response(JSON.stringify({ error: "request (17000 tokens) exceeds the available context size (16384 tokens), try increasing it" }), { status: 400 }));
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") {
        shows += 1;
        // The first lookup reports the pin; a later one comes back without parameters.
        return new Response(JSON.stringify(shows === 1 ? { parameters: "num_ctx                        16384", model_info: unpinned.model_info } : { model_info: unpinned.model_info }), { status: 200 });
      }
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "pin-then-none" }).complete({ prompt: words(14000), maxTokens: 1000, enforceContextWindow: true }),
        (error: unknown) => error instanceof ContextTooSmallError && error.failure.limitTokens === 16384 && error.failure.sentToProvider === true,
      );
      assert.deepEqual(ollama.chats, [undefined], "no retry past the pin");
      assert.equal(shows, 1, "the refusal does not wait for a retry lookup");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the pin the size check saw when the adapter's own lookup fails", async () => {
    const original = globalThis.fetch;
    let shows = 0;
    const ollama = scripted({ showBody: undefined, loaded: () => 65536, model: "check-then-503" });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") {
        shows += 1;
        // The run's size check sees the pin; the adapter's own lookup gets a 503.
        return shows === 1
          ? new Response(JSON.stringify({ parameters: "num_ctx                        16384", model_info: unpinned.model_info }), { status: 200 })
          : new Response("busy", { status: 503 });
      }
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "check-then-503" });
      assert.equal(await llm.contextWindow?.(), 16384);
      await llm.complete({ prompt: words(12000), maxTokens: 1000, enforceContextWindow: true });
      assert.deepEqual(ollama.chats, [undefined], "the pin applies, not the 65,536 another client loaded");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses an agent run's retry at an unpinned model's maximum when the answer would not fit", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({ showBody: { model_info: { "general.architecture": "llama", "llama.context_length": 16384 } } });
    ollama.handlers.push(() => new Response(JSON.stringify({ error: "request (15800 tokens) exceeds the available context size (8192 tokens), try increasing it" }), { status: 400 }));
    globalThis.fetch = ollama.fetchImpl;
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "small-max" }).complete({ prompt: words(14000), maxTokens: 1100, enforceContextWindow: true }),
        (error: unknown) => error instanceof ContextTooSmallError && error.failure.limitTokens === 16384 && error.failure.neededTokens === 16900 && error.failure.sentToProvider === true,
      );
      assert.equal(ollama.chats.length, 1, "no retry that leaves no room for the answer");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the size check's pin when the adapter's lookup answers without parameters for the same model", async () => {
    const original = globalThis.fetch;
    let shows = 0;
    const ollama = scripted({ showBody: undefined, loaded: () => 65536, model: "partial-show" });
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (new URL(String(input)).pathname === "/api/show") {
        shows += 1;
        const revision = { modified_at: "2026-11-01T00:00:00Z" };
        return new Response(JSON.stringify(shows === 1
          ? { parameters: "num_ctx                        16384", model_info: unpinned.model_info, ...revision }
          : { model_info: unpinned.model_info, ...revision }), { status: 200 });
      }
      return ollama.fetchImpl(input, init);
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "partial-show" });
      assert.equal(await llm.contextWindow?.(), 16384);
      await llm.complete({ prompt: words(12000), maxTokens: 1000, enforceContextWindow: true });
      assert.deepEqual(ollama.chats, [undefined]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("checks a short agent run request against a pin below 2,048 tokens", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({ showBody: { parameters: "num_ctx                        1024", model_info: unpinned.model_info } });
    globalThis.fetch = ollama.fetchImpl;
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "tiny-pin" }).complete({ prompt: words(1000), maxTokens: 500, enforceContextWindow: true }),
        (error: unknown) => error instanceof ContextTooSmallError && error.failure.limitTokens === 1024,
      );
      assert.equal(ollama.chats.length, 0);
      // Chat keeps the shortcut and sends the request.
      await createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "tiny-pin-chat" }).complete({ prompt: words(1000), maxTokens: 500 });
      assert.equal(ollama.chats.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives an agent run the typed reason for an overflow Ollama reports mid-stream", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({ showBody: unpinned });
    ollama.handlers.push(() => new Response(`${JSON.stringify({ error: "request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it" })}\n`, { status: 200 }));
    globalThis.fetch = ollama.fetchImpl;
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "mid-stream" }).complete({ prompt: words(5000), maxTokens: 1000, enforceContextWindow: true }),
        (error: unknown) => error instanceof ContextTooSmallError && error.failure.sentToProvider === true && error.failure.limitTokens === 8192,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("gives an agent run the typed reason for Ollama's overflow wording without counts, on the retry and mid-stream", async () => {
    const original = globalThis.fetch;
    const tooLong = JSON.stringify({ error: "the prompt is longer than the context length currently available" });
    try {
      for (const mode of ["retry", "stream"] as const) {
        const ollama = scripted({ showBody: unpinned });
        if (mode === "retry") {
          ollama.handlers.push(() => new Response(JSON.stringify({ error: "request (9000 tokens) exceeds the available context size (8192 tokens), try increasing it" }), { status: 400 }));
          ollama.handlers.push(() => new Response(tooLong, { status: 400 }));
        } else {
          ollama.handlers.push(() => new Response(`${JSON.stringify({ model: "m", message: { content: "Partial" }, done: false })}\n${tooLong}\n`, { status: 200 }));
        }
        globalThis.fetch = ollama.fetchImpl;
        await assert.rejects(
          createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: `uncounted-${mode}` }).complete({ prompt: words(5000), maxTokens: 1000, enforceContextWindow: true }),
          (error: unknown) => {
            assert.ok(error instanceof ContextTooSmallError, mode);
            assert.equal(error.failure.sentToProvider, true);
            assert.ok(error.failure.neededTokens > error.failure.limitTokens);
            return true;
          },
        );
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("holds an agent run to Ollama's own size when no lookup says whether the model is pinned", async () => {
    const original = globalThis.fetch;
    try {
      for (const retryLookup of ["unavailable", "partial"] as const) {
        const chats: Array<number | undefined> = [];
        let shows = 0;
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/ps") return new Response("unavailable", { status: 503 });
          if (path === "/api/show") {
            shows += 1;
            // The first lookup fails; the retry lookup fails
            // too, or answers without parameters or model_info.
            if (shows === 1 || retryLookup === "unavailable") return new Response("unavailable", { status: 503 });
            return new Response(JSON.stringify({ modified_at: "2026-11-01T00:00:00Z" }), { status: 200 });
          }
          chats.push((JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } }).options?.num_ctx);
          return new Response(JSON.stringify({ error: "request (18000 tokens) exceeds the available context size (16384 tokens), try increasing it" }), { status: 400 });
        }) as typeof fetch;
        await assert.rejects(
          createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: `no-metadata-${retryLookup}` }).complete({ prompt: words(14000), maxTokens: 1000, enforceContextWindow: true }),
          (error: unknown) => {
            // Either way Ollama's own count is the typed reason.
            assert.ok(error instanceof ContextTooSmallError, retryLookup);
            assert.equal(error.failure.limitTokens, 16384);
            assert.equal(error.failure.neededTokens, 19000);
            assert.equal(error.failure.sentToProvider, true);
            return true;
          },
        );
        // One send, with no num_ctx that could override a pin.
        assert.deepEqual(chats, [undefined], retryLookup);
      }
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps the first lookup's maximum when the retry lookup for the same revision omits it", async () => {
    const original = globalThis.fetch;
    const chats: Array<number | undefined> = [];
    let shows = 0;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/show") {
        shows += 1;
        const body = shows === 1
          ? { modified_at: "2026-11-01T00:00:00Z", modelfile: "FROM llama\n", model_info: { "general.architecture": "llama", "llama.context_length": 16384 } }
          : { modified_at: "2026-11-01T00:00:00Z" };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (path === "/api/ps") return new Response(JSON.stringify({ models: [] }), { status: 200 });
      chats.push((JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } }).options?.num_ctx);
      if (chats.length === 1) return new Response(JSON.stringify({ error: "request (15000 tokens) exceeds the available context size (8192 tokens), try increasing it" }), { status: 400 });
      return new Response(`${JSON.stringify({ model: "m", message: { content: "ok" }, done: true })}\n`, { status: 200 });
    }) as typeof fetch;
    try {
      await createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "partial-retry" }).complete({ prompt: words(5000), enforceContextWindow: true });
      // The retry asks for room up to the 16,384 maximum the first lookup saw, never past it.
      assert.equal(chats.length, 2);
      assert.equal(chats[1], 16384);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("holds an agent run to a pin no lookup confirmed when Ollama reports only the maximum", async () => {
    const original = globalThis.fetch;
    const chats: Array<number | undefined> = [];
    let shows = 0;
    // A model pinned to 16,384: the first lookup fails, the retry lookup
    // answers with model_info alone, and Ollama runs the request at its pin.
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/ps") return new Response("unavailable", { status: 503 });
      if (path === "/api/show") {
        shows += 1;
        if (shows === 1) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ model_info: { "general.architecture": "llama", "llama.context_length": 131072 } }), { status: 200 });
      }
      chats.push((JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } }).options?.num_ctx);
      return new Response(JSON.stringify({ error: "request (18000 tokens) exceeds the available context size (16384 tokens), try increasing it" }), { status: 400 });
    }) as typeof fetch;
    try {
      await assert.rejects(
        createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "maximum-only" }).complete({ prompt: words(14000), maxTokens: 1000, enforceContextWindow: true }),
        (error: unknown) => {
          assert.ok(error instanceof ContextTooSmallError);
          assert.equal(error.failure.limitTokens, 16384);
          return true;
        },
      );
      assert.deepEqual(chats, [undefined]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sends no num_ctx on an agent run's first try when the lookup reports only the maximum", async () => {
    const original = globalThis.fetch;
    const ollama = scripted({ showBody: { model_info: { "general.architecture": "llama", "llama.context_length": 131072 } } });
    globalThis.fetch = ollama.fetchImpl;
    try {
      await createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "maximum-only-first" }).complete({ prompt: words(14000), maxTokens: 1000, enforceContextWindow: true });
      assert.deepEqual(ollama.chats, [undefined]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("keeps Chat's working size when Ollama briefly does not answer its lookups", async () => {
    const original = globalThis.fetch;
    const chats: Array<number | undefined> = [];
    let down = false;
    let overflowed = false;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/show") {
        if (down) return new Response("unavailable", { status: 503 });
        return new Response(JSON.stringify({ modified_at: "2026-11-01T00:00:00Z", modelfile: "FROM llama\nPARAMETER num_ctx 16384\n", model_info: { "general.architecture": "llama", "llama.context_length": 131072 } }), { status: 200 });
      }
      if (path === "/api/ps") return down ? new Response("unavailable", { status: 503 }) : new Response(JSON.stringify({ models: [] }), { status: 200 });
      const numCtx = (JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } }).options?.num_ctx;
      chats.push(numCtx);
      if (!overflowed) {
        overflowed = true;
        return new Response(JSON.stringify({ error: "request (18000 tokens) exceeds the available context size (16384 tokens), try increasing it" }), { status: 400 });
      }
      return new Response(`${JSON.stringify({ model: "m", message: { content: "ok" }, done: true })}\n`, { status: 200 });
    }) as typeof fetch;
    try {
      const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "chat-outage" });
      await llm.complete({ prompt: words(14000), maxTokens: 1000 });
      const kept = chats.at(-1);
      assert.ok(kept !== undefined && kept > 16384, String(chats));
      down = true;
      await llm.complete({ prompt: words(14000), maxTokens: 1000 });
      assert.equal(chats.at(-1), kept);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not carry an earlier unpinned reading over to a lookup that names no revision", async () => {
    const original = globalThis.fetch;
    const fullUnpinned = { modified_at: "2026-11-01T00:00:00Z", modelfile: "FROM llama\n", model_info: { "general.architecture": "llama", "llama.context_length": 131072 } };
    const partial = { model_info: { "general.architecture": "llama", "llama.context_length": 131072 } };
    const overflow = () => new Response(JSON.stringify({ error: "request (18000 tokens) exceeds the available context size (16384 tokens), try increasing it" }), { status: 400 });
    try {
      // First send: the size check saw the model unpinned, then it was created
      // again with a pin and the request's lookup answers only in part, or fails.
      for (const lookup of ["partial", "unavailable"] as const) {
        const chats: Array<number | undefined> = [];
        let shows = 0;
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/ps") return new Response(JSON.stringify({ models: [] }), { status: 200 });
          if (path === "/api/show") {
            shows += 1;
            if (shows === 1) return new Response(JSON.stringify(fullUnpinned), { status: 200 });
            return lookup === "partial" ? new Response(JSON.stringify(partial), { status: 200 }) : new Response("unavailable", { status: 503 });
          }
          chats.push((JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } }).options?.num_ctx);
          return overflow();
        }) as typeof fetch;
        const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: `recreated-first-${lookup}` });
        assert.equal(await llm.contextWindow?.(`recreated-first-${lookup}`), 131072);
        await assert.rejects(llm.complete({ prompt: words(14000), maxTokens: 1000, enforceContextWindow: true }), ContextTooSmallError);
        assert.deepEqual(chats, [undefined], lookup);
      }
      // Retry: the request's lookup saw the model unpinned and sized it; the
      // retry lookup answers only in part, so the retry does not raise.
      {
        const chats: Array<number | undefined> = [];
        let shows = 0;
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
          const path = new URL(String(input)).pathname;
          if (path === "/api/ps") return new Response(JSON.stringify({ models: [] }), { status: 200 });
          if (path === "/api/show") {
            shows += 1;
            return new Response(JSON.stringify(shows === 1 ? fullUnpinned : partial), { status: 200 });
          }
          chats.push((JSON.parse(String(init?.body)) as { options?: { num_ctx?: number } }).options?.num_ctx);
          return overflow();
        }) as typeof fetch;
        await assert.rejects(
          createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "recreated-retry" }).complete({ prompt: words(14000), maxTokens: 1000, enforceContextWindow: true }),
          (error: unknown) => {
            assert.ok(error instanceof ContextTooSmallError);
            assert.equal(error.failure.limitTokens, 16384);
            return true;
          },
        );
        assert.equal(chats.length, 1);
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});
