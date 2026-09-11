import assert from "node:assert/strict";
import { afterEach, it, mock } from "node:test";
import { providerCatalog } from "@openadminos/agent-sdk";
import { checkOllama } from "./provider-detail.js";

afterEach(() => mock.restoreAll());
const provider = providerCatalog.find((p) => p.id === "ollama")!;
function models(capabilities: Record<string, string[] | null>) {
  mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/tags"))
      return Response.json({
        models: Object.keys(capabilities).map((name) => ({ name })),
      });
    const { model } = JSON.parse(String(init?.body)) as { model: string };
    return capabilities[model] === null
      ? new Response("unavailable", { status: 503 })
      : Response.json({ capabilities: capabilities[model] });
  });
}
it("excludes embedding-only aliases before selecting the default generation model", async () => {
  models({
    "custom-first:latest": ["embedding"],
    "writer:latest": ["completion", "vision"],
  });
  const result = await checkOllama(provider);
  assert.deepEqual(result.models, ["writer:latest"]);
  assert.equal(result.defaultModel, "writer:latest");
  assert.equal(result.status, "connected");
});
it("explains how to recover when only embedding models are installed", async () => {
  models({ "nomic-embed-text": ["embedding"] });
  const result = await checkOllama(provider);
  assert.equal(result.status, "error");
  assert.deepEqual(result.models, []);
  assert.equal(result.defaultModel, undefined);
  assert.match(result.detail ?? "", /Install a text-generation model/);
});
it("keeps working models available and reports failed capability checks", async () => {
  models({ broken: null, writer: ["completion"] });
  const result = await checkOllama(provider);
  assert.deepEqual(result.models, ["writer"]);
  assert.match(result.detail ?? "", /refresh to retry/);
});
it("does not present an unverified model as ready", async () => {
  models({ broken: null });
  const result = await checkOllama(provider);
  assert.equal(result.status, "error");
  assert.match(result.detail ?? "", /capabilities could not be verified/);
});
