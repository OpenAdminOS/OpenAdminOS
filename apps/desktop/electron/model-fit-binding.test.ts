import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunLlmApi } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };
const llm: RunLlmApi = {
  available: true,
  complete: async () => ({ text: "ok", model: "m" }),
  async *stream() { yield { delta: "ok", accumulated: "ok", done: true, model: "m" }; },
};

async function store(extra: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-model-fit-binding-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [], ...extra }), "utf8");
  // No provider is contacted: models come from the factory, and only the endpoint is read.
  const state = new AppStateStore({ filePath, tokenStore, tokenStoreFor: () => tokenStore, userDataPath: dir, statsApiUrl: "", appVersion: "0.8.0", llmFactory: async () => llm });
  return { state, dir };
}

describe("Model fit endpoint binding", () => {
  it("refuses an Azure OpenAI request for a deployment other than the one configured now", async () => {
    const { state, dir } = await store({ providerConfigs: { azureOpenAI: { endpoint: "https://contoso.openai.azure.com", deployment: "dep-b", apiVersion: "2024-10-21" } } });
    try {
      const reviewed = await state.providerTarget("azure-openai");
      const build = (state as unknown as { buildLlm(id: string, model: string | undefined, binding: unknown): Promise<RunLlmApi> }).buildLlm.bind(state);
      // The review listed deployment A, but B is configured: the adapter would send to B.
      await assert.rejects(build("azure-openai", "dep-a", { endpoint: reviewed.endpoint, scope: "model-fit" }), (error: Error) => error.name === "ProviderEndpointChangedError");
      await build("azure-openai", "dep-b", { endpoint: reviewed.endpoint, scope: "model-fit" });
    } finally {
      state.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("binds Lemonade to its address, so a relaunch on another server refuses the build", async () => {
    const saved = process.env.OPENADMINOS_LEMONADE_URL;
    const { state, dir } = await store();
    try {
      process.env.OPENADMINOS_LEMONADE_URL = "http://lemonade-a.example:13305/v1";
      const reviewed = await state.providerTarget("lemonade");
      assert.equal(reviewed.endpoint, "http://lemonade-a.example:13305/v1");
      const build = (state as unknown as { buildLlm(id: string, model: string | undefined, binding: unknown): Promise<RunLlmApi> }).buildLlm.bind(state);
      await build("lemonade", "m", { endpoint: reviewed.endpoint, scope: "model-fit" });
      process.env.OPENADMINOS_LEMONADE_URL = "http://lemonade-b.example:13305/v1";
      assert.notEqual((await state.providerTarget("lemonade")).destination, reviewed.destination);
      await assert.rejects(build("lemonade", "m", { endpoint: reviewed.endpoint, scope: "model-fit" }), (error: Error) => error.name === "ProviderEndpointChangedError");
    } finally {
      if (saved === undefined) delete process.env.OPENADMINOS_LEMONADE_URL;
      else process.env.OPENADMINOS_LEMONADE_URL = saved;
      state.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
