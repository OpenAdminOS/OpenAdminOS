import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  providerCatalog,
  type ProviderId,
  type ProviderSummary,
} from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { SAMPLE_TENANT_ID } from "./sample-tenant/dataset.js";
import { AppStateStore } from "./state.js";

type Readiness = Partial<Record<ProviderId, Partial<ProviderSummary>>>;

/** Every provider not listed is not installed. */
function providersWith(ready: Readiness): ProviderSummary[] {
  return providerCatalog.map((provider) => ({
    ...provider,
    status: "not-installed" as const,
    models: [],
    ...ready[provider.id],
  }));
}

const READY_LM_STUDIO: Partial<ProviderSummary> = {
  status: "connected",
  models: ["qwen2.5-7b-instruct"],
  defaultModel: "qwen2.5-7b-instruct",
};
const READY_OLLAMA: Partial<ProviderSummary> = {
  status: "connected",
  models: ["llama3.1:8b"],
  defaultModel: "llama3.1:8b",
};
const READY_APPLE: Partial<ProviderSummary> = {
  status: "connected",
  models: ["apple-foundation-default"],
  defaultModel: "apple-foundation-default",
};
const READY_HOSTED_CLI: Partial<ProviderSummary> = {
  status: "connected",
  models: ["default"],
  defaultModel: "default",
};

describe("provider detection", () => {
  it("selects a ready LM Studio for a fresh install and shows the notice once", async () => {
    const fixture = await makeFixture({ providers: { "lm-studio": READY_LM_STUDIO } });
    try {
      const state = await fixture.store.getAppState();
      assert.equal(state.activeProviderId, "lm-studio");
      assert.deepEqual(state.providerAutoSelectNotice, {
        providerId: "lm-studio",
        providerName: "LM Studio",
      });
      const persisted = await fixture.persisted();
      assert.equal(persisted.activeProviderId, "lm-studio");
      assert.equal(persisted.providerChosenByUser, false);

      // Still shown until dismissed.
      assert.ok((await fixture.store.getAppState()).providerAutoSelectNotice);
      const dismissed = await fixture.store.dismissProviderAutoSelectNotice();
      assert.equal(dismissed.providerAutoSelectNotice, undefined);
      assert.equal(dismissed.activeProviderId, "lm-studio");
      assert.equal((await fixture.store.getAppState()).providerAutoSelectNotice, undefined);

      // Not shown again after a restart either.
      const restarted = fixture.reopen();
      assert.equal((await restarted.getAppState()).providerAutoSelectNotice, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("skips a running Ollama without a text-generation model", async () => {
    const fixture = await makeFixture({
      providers: {
        ollama: {
          status: "error",
          detail: "Ollama has no text-generation models available.",
          models: [],
        },
        "lm-studio": READY_LM_STUDIO,
      },
    });
    try {
      assert.equal((await fixture.store.getAppState()).activeProviderId, "lm-studio");
    } finally {
      await fixture.close();
    }

    // Even if a check reported "connected" with no model, it does not count.
    const connectedWithoutModel = await makeFixture({
      providers: {
        ollama: { status: "connected", models: [] },
        "apple-foundation": READY_APPLE,
      },
    });
    try {
      assert.equal(
        (await connectedWithoutModel.store.getAppState()).activeProviderId,
        "apple-foundation",
      );
    } finally {
      await connectedWithoutModel.close();
    }
  });

  it("prefers Ollama, then LM Studio, then Apple Foundation", async () => {
    const fixture = await makeFixture({
      providers: { "lm-studio": READY_LM_STUDIO, "apple-foundation": READY_APPLE },
    });
    try {
      assert.equal((await fixture.store.getAppState()).activeProviderId, "lm-studio");
    } finally {
      await fixture.close();
    }

    const ollamaReady = await makeFixture({
      providers: { ollama: READY_OLLAMA, "lm-studio": READY_LM_STUDIO },
    });
    try {
      const state = await ollamaReady.store.getAppState();
      assert.equal(state.activeProviderId, "ollama");
      // Ollama was already active, so nothing was selected on the user's behalf.
      assert.equal(state.providerAutoSelectNotice, undefined);
    } finally {
      await ollamaReady.close();
    }
  });

  it("selects a local runtime that starts after launch", async () => {
    const fixture = await makeFixture({ providers: {} });
    try {
      assert.equal((await fixture.store.getAppState()).activeProviderId, "ollama");
      fixture.setProviders({ "lm-studio": READY_LM_STUDIO });
      assert.equal((await fixture.store.getAppState()).activeProviderId, "lm-studio");
    } finally {
      await fixture.close();
    }
  });

  it("never selects a local endpoint that is not on this device", async () => {
    const fixture = await makeFixture({
      providers: { "lm-studio": { ...READY_LM_STUDIO, isLocal: false } },
    });
    try {
      const state = await fixture.store.getAppState();
      assert.equal(state.activeProviderId, "ollama");
      assert.equal(state.providerAutoSelectNotice, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("never overrides an explicit choice", async () => {
    const fixture = await makeFixture({ providers: {} });
    try {
      await fixture.store.setActiveProvider("anthropic");
      fixture.setProviders({ ollama: READY_OLLAMA, "lm-studio": READY_LM_STUDIO });
      const state = await fixture.store.getAppState();
      assert.equal(state.activeProviderId, "anthropic");
      assert.equal(state.providerAutoSelectNotice, undefined);
      assert.equal((await fixture.persisted()).providerChosenByUser, true);
    } finally {
      await fixture.close();
    }
  });

  it("an explicit choice after an automatic one clears the notice and ends detection", async () => {
    const fixture = await makeFixture({ providers: { "lm-studio": READY_LM_STUDIO } });
    try {
      assert.equal((await fixture.store.getAppState()).activeProviderId, "lm-studio");
      const chosen = await fixture.store.setActiveProvider("ollama");
      assert.equal(chosen.activeProviderId, "ollama");
      assert.equal(chosen.providerAutoSelectNotice, undefined);
      // Ollama is not ready, LM Studio is, but the user chose.
      assert.equal((await fixture.store.getAppState()).activeProviderId, "ollama");
      assert.equal((await fixture.persisted()).providerAutoSelection, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("does not switch existing state files written before detection", async () => {
    for (const activeProviderId of ["ollama", "anthropic"] as const) {
      const fixture = await makeFixture({
        providers: { "lm-studio": READY_LM_STUDIO },
        existingState: { activeProviderId, installedAgents: [], runs: [], tenants: [] },
      });
      try {
        const state = await fixture.store.getAppState();
        assert.equal(state.activeProviderId, activeProviderId);
        assert.equal(state.providerAutoSelectNotice, undefined);
        assert.equal((await fixture.persisted()).activeProviderId, activeProviderId);
      } finally {
        await fixture.close();
      }
    }
  });

  it("never selects a hosted provider, even when it is the only ready one", async () => {
    const fixture = await makeFixture({
      providers: {
        anthropic: READY_HOSTED_CLI,
        openai: READY_HOSTED_CLI,
        copilot: READY_HOSTED_CLI,
        gemini: READY_HOSTED_CLI,
        "azure-openai": { status: "available", models: ["gpt-4o"], defaultModel: "gpt-4o" },
      },
    });
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const state = await fixture.store.getAppState();
        assert.equal(state.activeProviderId, "ollama");
        assert.equal(state.providerAutoSelectNotice, undefined);
      }
      const persisted = await fixture.persisted();
      assert.equal(persisted.activeProviderId, "ollama");
      assert.equal(persisted.providerChosenByUser, false);
      assert.equal(persisted.providerAutoSelection, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("does nothing in pilot mode", async () => {
    const fixture = await makeFixture({ providers: {} });
    try {
      await fixture.store.addSampleTenant();
      fixture.setProviders({ "lm-studio": READY_LM_STUDIO });
      const state = await fixture.store.getAppState();
      assert.equal(state.activeTenantId, SAMPLE_TENANT_ID);
      assert.equal(state.activeProviderId, "ollama");
      assert.equal(state.providerAutoSelectNotice, undefined);
      assert.equal((await fixture.persisted()).providerAutoSelection, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("hides an earlier notice while pilot mode is active", async () => {
    const fixture = await makeFixture({ providers: { "lm-studio": READY_LM_STUDIO } });
    try {
      assert.ok((await fixture.store.getAppState()).providerAutoSelectNotice);
      const pilot = await fixture.store.addSampleTenant();
      assert.equal(pilot.activeTenantId, SAMPLE_TENANT_ID);
      assert.equal((await fixture.store.getAppState()).providerAutoSelectNotice, undefined);
    } finally {
      await fixture.close();
    }
  });
});

interface PersistedSnapshot {
  activeProviderId: ProviderId;
  providerChosenByUser?: boolean;
  providerAutoSelection?: { providerId: ProviderId; noticeDismissed: boolean };
}

async function makeFixture(options: {
  providers: Readiness;
  existingState?: Record<string, unknown>;
}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-provider-detection-"));
  const statePath = join(dir, "state.json");
  if (options.existingState) {
    await writeFile(statePath, JSON.stringify(options.existingState), "utf8");
  }
  let readiness = options.providers;
  const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };
  const stores: AppStateStore[] = [];
  const open = () => {
    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      tokenStoreFor: () => tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      appVersion: "0.7.2",
      providerListFactory: () => providersWith(readiness),
      llmFactory: () => {
        throw new Error("Provider detection must not build an LLM.");
      },
    });
    stores.push(store);
    return store;
  };
  const store = open();
  return {
    store,
    setProviders(next: Readiness) {
      readiness = next;
    },
    reopen: open,
    async persisted(): Promise<PersistedSnapshot> {
      return JSON.parse(await readFile(statePath, "utf8")) as PersistedSnapshot;
    },
    async close() {
      await store.cancelGraphCachePreload(SAMPLE_TENANT_ID).catch(() => undefined);
      for (const entry of stores) entry.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
