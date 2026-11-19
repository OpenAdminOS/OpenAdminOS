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
    onShow?: () => void;
    showRedirect?: boolean;
    requested?: (prompt: string) => number;
    stallOverflowBody?: (res: ServerResponse) => void;
    delayRetryMs?: (prompt: string) => number;
  }) {
    const chats: Array<{ num_ctx?: number }> = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (part) => (raw += part));
      req.on("end", () => {
        const body = JSON.parse(raw) as { options?: { num_ctx?: number }; messages?: Array<{ content: string }> };
        if (req.url === "/api/show") {
          if (options.showRedirect) {
            res.writeHead(307, { location: "http://example.com/api/show" });
            res.end();
            return;
          }
          if (options.onShow) {
            options.onShow();
            return;
          }
          res.end(JSON.stringify({ model_info: options.modelMax ? { "qwen3.context_length": options.modelMax } : {} }));
          return;
        }
        const numCtx = body.options?.num_ctx;
        const prompt = body.messages?.at(-1)?.content ?? "";
        const requested = options.requested?.(prompt) ?? 40652;
        chats.push(numCtx === undefined ? {} : { num_ctx: numCtx });
        if (requested > options.limit(numCtx)) {
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
    return { endpoint, chats, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
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
});
