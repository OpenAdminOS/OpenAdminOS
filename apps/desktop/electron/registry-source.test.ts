import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("registry source trust gate", () => {
  it("requires explicit confirmation before persisting a custom registry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-registry-source-"));
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        activeProviderId: "ollama",
        installedAgents: [],
        runs: [],
        tenants: [],
      }),
      "utf8",
    );

    const originalFetch = globalThis.fetch;
    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      userAgentsDir: join(dir, "agents"),
      statsApiUrl: "",
    });

    try {
      await assert.rejects(
        () => store.setRegistrySource("https://example.com/openadminos/agents"),
        /requires trust review confirmation/,
      );

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            agents: [],
          }),
          { status: 200 },
        );

      await store.setRegistrySource("https://example.com/openadminos/agents/", {
        confirmExternalSource: true,
      });
      const state = await store.getAppState();
      assert.equal(state.registrySource, "https://example.com/openadminos/agents");
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
