import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";

import { embeddingModelState, pullEmbeddingModel } from "./embedding-model.js";
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

  it("reads a redirecting Ollama as unreachable and refuses a pull through it", async () => {
    const pair = await redirectingPair();
    try {
      assert.deepEqual(await embeddingModelState(pair.origin), { ollamaReachable: false, installed: false });
      await assert.rejects(pullEmbeddingModel(pair.origin), /answered with a redirect to another address/);
      assert.equal(pair.hits(), 0);
    } finally {
      await pair.close();
    }
  });
});
