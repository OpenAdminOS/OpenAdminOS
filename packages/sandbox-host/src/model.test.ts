import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkLocalModel, isCloudModelName } from "./model.js";
import { SandboxRefusal } from "./refusal.js";
import { ollamaFetch } from "./test-support.js";

const local = { provider: "ollama" as const, endpoint: "http://127.0.0.1:11434", model: "llama3.1:8b" };

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof SandboxRefusal, String(error));
    return error.reason;
  }
  return "accepted";
}

describe("checkLocalModel", () => {
  it("returns the model and its digest", async () => {
    assert.deepEqual(await checkLocalModel(local, ollamaFetch()), { model: "llama3.1:8b", digest: "sha256:abc" });
  });

  it("refuses an endpoint that is not on this machine before any request", async () => {
    let requests = 0;
    const counting = (async () => {
      requests += 1;
      return new Response("{}");
    }) as typeof fetch;
    assert.equal(await reasonOf(checkLocalModel({ ...local, endpoint: "http://10.0.0.5:11434" }, counting)), "model-endpoint-not-local");
    assert.equal(await reasonOf(checkLocalModel({ provider: "lm-studio", endpoint: "http://gpu.example:1234/v1", model: "x" }, counting)), "model-endpoint-not-local");
    assert.equal(requests, 0);
  });

  it("refuses a model that is not pulled or a server that is not reachable", async () => {
    assert.equal(await reasonOf(checkLocalModel({ ...local, model: "qwen3:8b" }, ollamaFetch())), "model-not-pulled");
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    assert.equal(await reasonOf(checkLocalModel(local, refused)), "model-unreachable");
  });

  it("refuses Ollama cloud models by name and by what Ollama reports", async () => {
    assert.equal(isCloudModelName("gpt-oss:120b-cloud"), true);
    assert.equal(isCloudModelName("deepseek:cloud"), true);
    assert.equal(isCloudModelName("llama3.1:8b"), false);
    assert.equal(await reasonOf(checkLocalModel({ ...local, model: "gpt-oss:120b-cloud" }, ollamaFetch())), "model-cloud");
    assert.equal(await reasonOf(checkLocalModel(local, ollamaFetch({ show: { remote_host: "https://ollama.com" } }))), "model-cloud");
    assert.equal(await reasonOf(checkLocalModel(local, ollamaFetch({ models: [{ name: "llama3.1:8b", remote_model: "x" }] }))), "model-cloud");
  });
});
