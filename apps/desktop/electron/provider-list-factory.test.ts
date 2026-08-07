import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderSummary } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("provider list fixture", () => {
  it("uses the injected provider list without probing the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-provider-list-"));
    const fixture: ProviderSummary[] = [
      {
        id: "ollama",
        name: "Ollama",
        description: "Smoke provider fixture.",
        isLocal: true,
        status: "connected",
        models: ["smoke-local-model"],
        defaultModel: "smoke-local-model",
      },
    ];
    let calls = 0;
    const store = new AppStateStore({
      filePath: join(dir, "state.json"),
      userDataPath: dir,
      tokenStore,
      statsApiUrl: "",
      providerListFactory: () => {
        calls += 1;
        return fixture;
      },
    });

    try {
      assert.deepEqual(await store.listProviders(), fixture);
      assert.equal(calls, 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
