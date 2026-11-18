import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";

import { AppStateStore } from "../state.js";
import { embeddingModelState, pullEmbeddingModel } from "./embedding-model.js";
import { EMBEDDING_QUERY_TIMEOUT_MS, loopbackEmbedQuery, ollamaEmbedQuery } from "./retrieval.js";

/** An embedding server on this device that redirects every request to a second one, which counts what reaches it. */
async function redirectingPair(): Promise<{ origin: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const target = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings: [[0.1]], data: [{ embedding: [0.1] }], models: [{ name: "nomic-embed-text:latest" }] }));
  });
  await listen(target);
  const targetUrl = `http://127.0.0.1:${(target.address() as { port: number }).port}`;
  const origin = createServer((request, response) => response.writeHead(308, { location: `${targetUrl}${request.url ?? "/"}` }).end());
  await listen(origin);
  return {
    origin: `http://127.0.0.1:${(origin.address() as { port: number }).port}`,
    hits: () => hits,
    close: async () => {
      await Promise.all([shut(origin), shut(target)]);
    },
  };
}
const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const shut = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

describe("local documentation retrieval never follows a redirect from this device (PR #204 review round 6)", () => {
  it("sends no question to a redirect target from either embedding request", async () => {
    const pair = await redirectingPair();
    try {
      await assert.rejects(ollamaEmbedQuery(pair.origin)("which devices are noncompliant"), /answered with a redirect to another address/);
      await assert.rejects(loopbackEmbedQuery(pair.origin)("which devices are noncompliant"), /answered with a redirect to another address/);
      assert.equal(pair.hits(), 0);
    } finally {
      await pair.close();
    }
  });

  it("reports a refused redirect in the Settings status and refuses a pull through it", async (t) => {
    const pair = await redirectingPair();
    t.after(() => pair.close());
    const previousEndpoint = process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    process.env.OPENADMINOS_EMBEDDING_ENDPOINT = pair.origin;
    t.after(() => {
      if (previousEndpoint === undefined) delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
      else process.env.OPENADMINOS_EMBEDDING_ENDPOINT = previousEndpoint;
    });
    const dir = await mkdtemp(join(tmpdir(), "openadminos-embedding-redirect-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"),
      statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
    });
    t.after(() => store.close());
    for (const status of [await store.getRetrievalStatusWithUpdates(), await store.refreshRetrievalIndex()]) {
      assert.equal(status.ollamaReachable, true);
      assert.equal(status.embeddingModelInstalled, false);
      assert.match(status.embeddingModelError ?? "", /answered with a redirect to another address/);
    }
    await assert.rejects(pullEmbeddingModel(pair.origin), /answered with a redirect to another address/);
    assert.equal(pair.hits(), 0);
  });

  it("keeps missing model and HTTP failures distinct", async (t) => {
    const endpoint = "http://127.0.0.1:11434";
    const request = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) =>
      Response.json({ error: "model 'nomic-embed-text' not found" }, { status: 404 }),
    );
    await assert.rejects(ollamaEmbedQuery(endpoint)("test"), /HTTP 404.*ollama pull nomic-embed-text/i);
    request.mock.mockImplementation(async () => new Response("", { status: 503 }));
    await assert.rejects(ollamaEmbedQuery(endpoint)("test"), (error: Error) =>
      /HTTP 503/.test(error.message) && !error.message.includes("ollama pull"));
  });

  it("bounds each query embedding to 30 seconds, body included (PR #206 review round 1)", async (t) => {
    // A local server that sends its headers, then never finishes the body.
    const stalled = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
    });
    await listen(stalled);
    t.after(() => {
      stalled.closeAllConnections();
      return new Promise<void>((resolve) => stalled.close(() => resolve()));
    });
    const endpoint = `http://127.0.0.1:${(stalled.address() as { port: number }).port}`;
    const budgets: number[] = [];
    const timers: AbortController[] = [];
    t.mock.method(AbortSignal, "timeout", (ms: number) => {
      budgets.push(ms);
      const controller = new AbortController();
      timers.push(controller);
      return controller.signal;
    });
    const expire = () => {
      // Fire the budget once the headers are in: only the body read is left.
      setTimeout(() => timers.at(-1)!.abort(new DOMException("The operation timed out.", "TimeoutError")), 50);
    };
    for (const [query, name] of [[ollamaEmbedQuery(endpoint), "Ollama"], [loopbackEmbedQuery(endpoint), "The embedding server"]] as const) {
      const pending = query("test");
      expire();
      await assert.rejects(pending, (error: Error) =>
        error.message === `${name} did not finish embedding the question within 30 seconds. Check that it is running, then ask again.`);
    }
    assert.deepEqual(budgets, [EMBEDDING_QUERY_TIMEOUT_MS, EMBEDDING_QUERY_TIMEOUT_MS]);
    assert.equal(EMBEDDING_QUERY_TIMEOUT_MS, 30_000);
  });

  it("never puts response text, which can echo the question, into an embedding error (PR #206 review round 1)", async (t) => {
    const question = "which devices does alice.private@contoso.com own";
    t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], options?: RequestInit) =>
      new Response(`not json, you asked: ${String(options?.body)}`, { status: 200, headers: { "content-type": "application/json" } }),
    );
    for (const [query, name] of [[ollamaEmbedQuery("http://127.0.0.1:11434"), "Ollama"], [loopbackEmbedQuery("http://127.0.0.1:11434"), "The embedding server"]] as const) {
      await assert.rejects(query(question), (error: Error) => {
        const everything = `${error.message} ${String(error.cause ?? "")} ${error.stack ?? ""}`;
        assert.equal(error.message, `${name} answered the embedding request with something other than JSON. Check the local server, then ask again.`);
        assert.ok(!everything.includes("alice.private"), everything);
        return true;
      });
    }
  });

  it("names a dropped connection and a body that fails mid-read, never undici's bare message (PR #206 review round 1, Muse)", async (t) => {
    const dropped = () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
    };
    const request = t.mock.method(globalThis, "fetch", async () => dropped());
    for (const [query, name] of [[ollamaEmbedQuery("http://127.0.0.1:11434"), "Ollama"], [loopbackEmbedQuery("http://127.0.0.1:11434"), "The embedding server"]] as const) {
      await assert.rejects(query("test"), (error: Error) =>
        error.message === `${name} did not complete the embedding request (UND_ERR_SOCKET). Check the local server, then ask again.`);
    }
    request.mock.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
        controller.error(new TypeError("terminated"));
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await assert.rejects(ollamaEmbedQuery("http://127.0.0.1:11434")("test"), (error: Error) =>
      /^Ollama did not complete the embedding request\b.*Check the local server, then ask again\.$/.test(error.message) && !/^terminated$/.test(error.message));
    request.mock.mockImplementation(async () => dropped());
    const state = await embeddingModelState("http://127.0.0.1:11434");
    assert.match(state.error ?? "", /^Could not read Ollama's model list \(UND_ERR_SOCKET\)\./);
  });

  it("searches the documentation at the same endpoint Settings checks, also when OLLAMA_HOST moved Ollama (PR #206 review round 1)", async (t) => {
    let hits = 0;
    const moved = createServer((request, response) => {
      hits += 1;
      assert.equal(request.url, "/api/embed");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embeddings: [[1, 0]] }));
    });
    await listen(moved);
    t.after(() => new Promise<void>((resolve) => moved.close(() => resolve())));
    const previous = { endpoint: process.env.OPENADMINOS_EMBEDDING_ENDPOINT, host: process.env.OLLAMA_HOST };
    delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    process.env.OLLAMA_HOST = `127.0.0.1:${(moved.address() as { port: number }).port}`;
    t.after(() => {
      for (const [key, value] of [["OPENADMINOS_EMBEDDING_ENDPOINT", previous.endpoint], ["OLLAMA_HOST", previous.host]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const dir = await mkdtemp(join(tmpdir(), "openadminos-embedding-endpoint-"));
    const indexDir = join(dir, "retrieval-index");
    await mkdir(indexDir);
    await writeFile(join(indexDir, "index-meta.json"), JSON.stringify({ dim: 2, embeddingModel: "nomic-embed-text-v1.5", builtAt: "2026-08-29T00:00:00.000Z", chunkCount: 1 }));
    await writeFile(join(indexDir, "chunks.jsonl"), `${JSON.stringify({ file: "a.md", text: "a" })}\n`);
    await writeFile(join(indexDir, "embeddings.f32"), Buffer.from(new Float32Array([1, 0]).buffer));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"),
      userDataPath: dir,
      statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => undefined },
    });
    // Close the store before removing its folder: it may still be writing its state file.
    t.after(async () => {
      await store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    });
    const passages = await store.retrieveDocumentation("question");
    assert.equal(passages.length, 1);
    assert.equal(hits, 1);
  });
});
