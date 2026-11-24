import assert from "node:assert/strict";
import { it } from "node:test";
import { readModelFitContextWindow } from "./model-fit-context.js";

it("reads a pinned or maximum Ollama window via /api/show without sending any prompt", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.redirect, "manual");
    if (String(input) === "http://127.0.0.1:11434/api/tags") {
      return Response.json({ models: [
        { name: "pinned" },
        { name: "unpinned" },
        { name: "remote-alias", remote_host: "https://ollama.com" },
      ] });
    }
    assert.equal(String(input), "http://127.0.0.1:11434/api/show");
    assert.equal(init?.method, "POST");
    const { model } = JSON.parse(String(init.body)) as { model: string };
    return Response.json({
      model_info: { "general.architecture": "qwen", "qwen.context_length": 65536 },
      parameters: model === "pinned" ? "num_ctx 16384" : "",
    });
  });
  const endpoint = "http://127.0.0.1:11434";
  assert.equal(await readModelFitContextWindow("ollama", "pinned", endpoint), 16384);
  assert.equal(await readModelFitContextWindow("ollama", "unpinned", endpoint), 65536);
  assert.equal(await readModelFitContextWindow("ollama", "remote", "https://example.test"), undefined);
  assert.equal(await readModelFitContextWindow("ollama", "remote-alias", endpoint), undefined);
  assert.equal(await readModelFitContextWindow("ollama", "remote:cloud", endpoint), undefined);
  assert.equal(await readModelFitContextWindow("ollama", "unlisted", endpoint), undefined);
  assert.equal(fetch.mock.calls.filter(({ arguments: [url] }) => String(url).endsWith("/api/show")).length, 2);
  assert.equal(fetch.mock.callCount(), 6);
});

it("reads the loaded LM Studio window and listed Lemonade context without loading a model", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.method ?? "GET", "GET");
    if (String(input) === "http://127.0.0.1:1234/api/v1/models") {
      return Response.json({ models: [{ key: "local", max_context_length: 65536, loaded_instances: [{ id: "local", config: { context_length: 49152 } }] }] });
    }
    assert.equal(String(input), "http://127.0.0.1:13305/v1/models");
    return Response.json({ data: [
      { id: "local", labels: ["chat"], recipe: "llamacpp", context_length: 8192 },
      { id: "cloud", labels: ["chat"], recipe: "cloud", context_length: 131072 },
    ] });
  });
  assert.equal(await readModelFitContextWindow("lm-studio", "local", "http://127.0.0.1:1234/v1"), 49152);
  assert.equal(await readModelFitContextWindow("lemonade", "local", "http://127.0.0.1:13305/v1"), 8192);
  assert.equal(await readModelFitContextWindow("lemonade", "cloud", "http://127.0.0.1:13305/v1"), undefined);
});
