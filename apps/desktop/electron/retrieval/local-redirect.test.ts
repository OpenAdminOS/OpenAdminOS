import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";

import { AppStateStore } from "../state.js";
import { pullEmbeddingModel } from "./embedding-model.js";
import { loopbackEmbedQuery, ollamaEmbedQuery } from "./retrieval.js";

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

  it("keeps missing model and HTTP failures distinct and bounds both query requests", async (t) => {
    const endpoint = "http://127.0.0.1:11434";
    const request = t.mock.method(globalThis, "fetch", async (_url: Parameters<typeof fetch>[0], _options?: RequestInit) =>
      Response.json({ error: "model 'nomic-embed-text' not found" }, { status: 404 }),
    );
    await assert.rejects(ollamaEmbedQuery(endpoint)("test"), /HTTP 404.*ollama pull nomic-embed-text/i);
    request.mock.mockImplementation(async () => new Response("", { status: 503 }));
    await assert.rejects(ollamaEmbedQuery(endpoint)("test"), (error: Error) =>
      /HTTP 503/.test(error.message) && !error.message.includes("ollama pull"));
    request.mock.mockImplementation(async (_url, options) => {
      assert.ok(options?.signal instanceof AbortSignal);
      throw new DOMException("Timed out", "TimeoutError");
    });
    await assert.rejects(ollamaEmbedQuery(endpoint)("test"), /Ollama.*timed out/i);
    await assert.rejects(loopbackEmbedQuery(endpoint)("test"), /embedding server.*timed out/i);
  });
});
