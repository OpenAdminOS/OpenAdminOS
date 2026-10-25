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
it("waits past the reachability timeout for slow capability checks", async () => {
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "slow-writer" }] });
    await new Promise((resolve) => setTimeout(resolve, 1_800));
    return Response.json({ capabilities: ["completion"] });
  });
  const result = await checkOllama(provider);
  assert.equal(result.status, "connected");
  assert.deepEqual(result.models, ["slow-writer"]);
});
it("reuses capability results for an unchanged model digest", async () => {
  let shows = 0;
  mock.method(globalThis, "fetch", async (url: string) => {
    if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "cached-writer", digest: "sha256:abc" }] });
    shows += 1;
    return Response.json({ capabilities: ["completion"] });
  });
  assert.deepEqual((await checkOllama(provider)).models, ["cached-writer"]);
  assert.deepEqual((await checkOllama(provider)).models, ["cached-writer"]);
  assert.equal(shows, 1);
});
