import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { createLmStudioLlm } from "./llm-lm-studio.js";
import { createOllamaLlm } from "./llm-ollama.js";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** A model server that answers every request with a 307 to another server, which counts what reaches it. */
async function redirectingServers() {
  let replayed = 0;
  const elsewhere = createServer((request, response) => {
    replayed += 1;
    request.resume();
    response.end("{}");
  });
  const elsewhereUrl = await listen(elsewhere);
  const local = createServer((request, response) => {
    request.resume();
    response.writeHead(307, { location: `${elsewhereUrl}${request.url ?? "/"}` });
    response.end();
  });
  const localUrl = await listen(local);
  return {
    localUrl,
    replayed: () => replayed,
    async close() {
      await close(local);
      await close(elsewhere);
    },
  };
}

describe("model clients and redirects", () => {
  it("Ollama does not follow a 307 from /api/chat, so the prompt goes nowhere else", async () => {
    const servers = await redirectingServers();
    try {
      const llm = createOllamaLlm({ endpoint: servers.localUrl, defaultModel: "llama3.1:8b", timeoutMs: 5_000 });
      await assert.rejects(llm.complete({ prompt: "tenant data" }));
      assert.equal(servers.replayed(), 0);
    } finally {
      await servers.close();
    }
  });

  it("LM Studio does not follow a 307 either, streaming or not", async () => {
    const servers = await redirectingServers();
    try {
      const llm = createLmStudioLlm({ endpoint: `${servers.localUrl}/v1`, defaultModel: "local", timeoutMs: 5_000 });
      await assert.rejects(llm.complete({ prompt: "tenant data" }));
      assert.equal(servers.replayed(), 0);
    } finally {
      await servers.close();
    }
  });

  it("sends through the given transport", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      urls.push(String(input));
      assert.equal(init?.redirect, "error");
      throw new Error("refused by transport");
    }) as typeof fetch;
    const llm = createOllamaLlm({ endpoint: "http://127.0.0.1:11434", defaultModel: "m", fetchImpl });
    await assert.rejects(llm.complete({ prompt: "x" }), /refused by transport/);
    assert.deepEqual(urls, ["http://127.0.0.1:11434/api/chat"]);
  });
});
