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
