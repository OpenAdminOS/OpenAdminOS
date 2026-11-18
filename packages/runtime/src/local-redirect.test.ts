import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { createLmStudioLlm, probeLmStudioLlm } from "./llm-lm-studio.js";
import { createOllamaLlm } from "./llm-ollama.js";
import { modelServerRedirect } from "./llm-openai-compatible.js";

/**
 * A model server on this device that answers every request with a redirect
 * to a second server, which counts what reaches it. Both listen on loopback
 * so the test contacts nothing else; the rule is about the redirect, not
 * the target.
 */
async function redirectingPair(status = 307): Promise<{ origin: string; hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const target = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m" }] }));
  });
  await listen(target);
  const targetUrl = `http://127.0.0.1:${port(target)}`;
  const origin = createServer((request, response) => {
    response.writeHead(status, { location: `${targetUrl}${request.url ?? "/"}` }).end();
  });
  await listen(origin);
  return {
    origin: `http://127.0.0.1:${port(origin)}`,
    hits: () => hits,
    close: async () => {
      await Promise.all([close(origin), close(target)]);
    },
  };
}

const listen = (server: Server) => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const port = (server: Server) => (server.address() as { port: number }).port;

describe("a model server on this device never redirects a request elsewhere (PR #204 review round 5)", () => {
  it("does not follow redirects for loopback endpoints and keeps following them for others", () => {
    assert.equal(modelServerRedirect("http://127.0.0.1:1234/v1/models"), "manual");
    assert.equal(modelServerRedirect("http://localhost:11434/api/chat"), "manual");
    assert.equal(modelServerRedirect("http://[::1]:13305/v1/models"), "manual");
    assert.equal(modelServerRedirect("https://models.example.com/v1/models"), "follow");
  });

  it("reports a redirecting model list as a failed check, not as models on this device", async () => {
    const pair = await redirectingPair();
    try {
      const probe = await probeLmStudioLlm({ endpoint: `${pair.origin}/v1` });
      assert.equal(probe.ready, false);
      assert.equal(probe.status, "error");
      assert.deepEqual(probe.models, []);
      assert.match(probe.detail ?? "", /answered with a redirect to another address\. OpenAdminOS does not follow redirects/);
      assert.equal(pair.hits(), 0);
    } finally {
      await pair.close();
    }
  });

  it("sends no prompt to a redirect target, for LM Studio answers and streams and for Ollama", async () => {
    const pair = await redirectingPair(308);
    try {
      const lm = createLmStudioLlm({ endpoint: `${pair.origin}/v1`, defaultModel: "m" });
      await assert.rejects(lm.complete({ prompt: "tenant question" }), /answered with a redirect to another address/);
      await assert.rejects(
        (async () => {
          for await (const _chunk of lm.stream!({ prompt: "tenant question" })) {
            // Nothing arrives.
          }
        })(),
        /answered with a redirect to another address/,
      );
      const ollama = createOllamaLlm({ endpoint: pair.origin, defaultModel: "m" });
      await assert.rejects(ollama.complete({ prompt: "tenant question" }), /Ollama at .* answered with a redirect to another address/);
      assert.equal(pair.hits(), 0);
    } finally {
      await pair.close();
    }
  });
});
