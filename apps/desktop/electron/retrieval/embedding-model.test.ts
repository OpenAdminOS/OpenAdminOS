import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { embeddingModelState, pullEmbeddingModel } from "./embedding-model.js";

function fetchStub(handler: (url: string, init?: RequestInit) => Response | Error): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const out = handler(url, init);
    if (out instanceof Error) throw out;
    return out;
  }) as typeof fetch;
}

describe("embedding model presence and pull", () => {
  it("reports installed when Ollama lists the model under any tag form", async () => {
    const state = await embeddingModelState(
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      fetchStub(() =>
        new Response(JSON.stringify({ models: [{ name: "nomic-embed-text:latest" }] })),
      ),
    );
    assert.deepEqual(state, { ollamaReachable: true, installed: true });
  });

  it("reports missing without failing when the model is absent", async () => {
    const state = await embeddingModelState(
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      fetchStub(() => new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }))),
    );
    assert.deepEqual(state, { ollamaReachable: true, installed: false });
  });

  it("treats an unreachable Ollama as a quiet no, never an exception", async () => {
    const state = await embeddingModelState(
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      fetchStub(() => new TypeError("fetch failed")),
    );
    assert.deepEqual(state, { ollamaReachable: false, installed: false });
  });

  it("refuses non-loopback endpoints so a question can never leave the device", async () => {
    await assert.rejects(
      () => embeddingModelState("http://embeddings.example.com:11434"),
      /loopback/i,
    );
    await assert.rejects(
      () => pullEmbeddingModel("http://embeddings.example.com:11434"),
      /loopback/i,
    );
  });

  it("pulls through Ollama and surfaces a pull error", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    await pullEmbeddingModel(
      "http://127.0.0.1:11434",
      "nomic-embed-text",
      fetchStub((url, init) => {
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ status: "success" }));
      }),
    );
    assert.match(calls[0]?.url ?? "", /\/api\/pull$/);
    assert.match(calls[0]?.body ?? "", /nomic-embed-text/);

    await assert.rejects(
      () =>
        pullEmbeddingModel(
          "http://127.0.0.1:11434",
          "nomic-embed-text",
          fetchStub(() => new Response(JSON.stringify({ error: "no space left" }))),
        ),
      /no space left/,
    );
  });
});

describe("index auto-install is gated on the local runtime", () => {
  it("downloads nothing when Ollama is unreachable, and does not burn the daily attempt", async () => {
    const { mkdtemp, rm, readFile, writeFile } = await import("node:fs/promises");
    const { existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { AppStateStore } = await import("../state.js");

    const previousEndpoint = process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
    // A loopback port nothing listens on.
    process.env.OPENADMINOS_EMBEDDING_ENDPOINT = "http://127.0.0.1:59999";
    const dir = await mkdtemp(join(tmpdir(), "openadminos-gate-"));
    try {
      const statePath = join(dir, "state.json");
      await writeFile(statePath, JSON.stringify({ tenants: [], runs: [] }), "utf8");
      const store = new AppStateStore({
        filePath: statePath,
        tokenStore: { read: async () => "", write: async () => undefined },
        userDataPath: dir,
        statsApiUrl: "",
      });

      await store.autoInstallRetrievalIndex();

      assert.equal(
        existsSync(join(dir, "retrieval-index")),
        false,
        "no index may be fetched for a machine that cannot embed queries",
      );
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        retrievalAutoInstallAttemptedAt?: string;
      };
      assert.equal(
        persisted.retrievalAutoInstallAttemptedAt,
        undefined,
        "an unreachable runtime is not an attempt; the next launch must retry immediately",
      );
    } finally {
      if (previousEndpoint === undefined) {
        delete process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
      } else {
        process.env.OPENADMINOS_EMBEDDING_ENDPOINT = previousEndpoint;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
