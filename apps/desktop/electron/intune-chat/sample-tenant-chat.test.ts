import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderSummary, RunLlmApi } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import {
  SAMPLE_TENANT_HOME_ACCOUNT_ID,
  SAMPLE_TENANT_ID,
  SAMPLE_TENANT_NAME,
  SAMPLE_TENANT_USERNAME,
} from "../sample-tenant/dataset.js";
import { createSampleGraph } from "../sample-tenant/graph.js";
import { AppStateStore } from "../state.js";

const unavailableProvider: ProviderSummary = {
  id: "ollama",
  name: "Ollama",
  description: "Local provider",
  isLocal: true,
  status: "error",
  detail: "Ollama is not running.",
  models: [],
};

const unavailableLlm: RunLlmApi = {
  available: false,
  async complete() {
    throw new Error("The unavailable LLM must not be called.");
  },
  async *stream() {
    throw new Error("The unavailable LLM must not be called.");
  },
};

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("sample tenant chat without a provider", () => {
  it("returns the computed suggested-prompt answer as deterministic markdown", async () => {
    const fixture = await makeChatFixture(true);
    try {
      const result = await fixture.store.sendIntuneChatMessage({
        content: "Which managed devices have not synced in the last 7 days?",
      });
      assert.equal(result.assistantMessage.status, "completed");
      assert.match(result.assistantMessage.content, /17 managed devices/);
      assert.match(result.assistantMessage.content, /\| Device \| OS \| Last sync \| Compliance \| Primary user \|/);
      assert.match(
        result.assistantMessage.content,
        /Shown without an LLM summary\. Pick a provider in Settings to get explained answers\./,
      );
      assert.equal(result.assistantMessage.model, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("keeps a deterministic direct device answer ahead of provider guidance", async () => {
    const fixture = await makeChatFixture(true);
    try {
      const result = await fixture.store.sendIntuneChatMessage({
        content: "List devices that are not encrypted",
      });
      assert.equal(result.assistantMessage.status, "completed");
      assert.doesNotMatch(result.assistantMessage.content, /Answering your own questions needs an LLM provider/);
      assert.match(result.assistantMessage.content, /5 devices report not encrypted/);
    } finally {
      await fixture.close();
    }
  });

  it("uses the same computed answer in the streaming Nova path", async () => {
    const fixture = await makeChatFixture(true);
    try {
      const result = await fixture.store.streamIntuneChatMessage(
        { content: "Which Windows devices are not encrypted?" },
        () => undefined,
        { voice: true },
      );
      assert.equal(result.assistantMessage.status, "completed");
      assert.match(result.assistantMessage.content, /5 managed Windows devices/);
      assert.match(result.assistantMessage.content, /Shown without an LLM summary/);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the existing failure for a real tenant", async () => {
    const fixture = await makeChatFixture(false);
    try {
      const result = await fixture.store.sendIntuneChatMessage({
        content: "Which devices have not synced in the last 7 days?",
      });
      assert.equal(result.assistantMessage.status, "failed");
      assert.equal(
        result.assistantMessage.content,
        "No LLM provider is connected. Start Ollama or choose another provider in Settings, then try again.",
      );
    } finally {
      await fixture.close();
    }
  });

  it("asks for a provider when the planner cannot identify tenant evidence", async () => {
    const fixture = await makeChatFixture(true);
    try {
      const result = await fixture.store.sendIntuneChatMessage({
        content: "Draft a limerick about coffee.",
      });
      assert.equal(result.assistantMessage.status, "completed");
      assert.match(
        result.assistantMessage.content,
        /Answering your own questions needs an LLM provider\. Pick one in Settings, or try one of these:/,
      );
      assert.match(result.assistantMessage.content, /- Which managed devices have not synced in the last 7 days\?/);
    } finally {
      await fixture.close();
    }
  });
});

async function makeChatFixture(sample: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-sample-chat-"));
  const statePath = join(dir, "state.json");
  const tenant = sample
    ? {
        id: SAMPLE_TENANT_ID,
        kind: "sample" as const,
        displayName: SAMPLE_TENANT_NAME,
        username: SAMPLE_TENANT_USERNAME,
        homeAccountId: SAMPLE_TENANT_HOME_ACCOUNT_ID,
        addedAt: "2026-10-26T12:00:00.000Z",
      }
    : {
        id: "real-tenant",
        displayName: "Contoso",
        username: "admin@contoso.example",
        homeAccountId: "real-account",
        addedAt: "2026-10-26T12:00:00.000Z",
      };
  await writeFile(
    statePath,
    JSON.stringify({
      activeProviderId: "ollama",
      installedAgents: [],
      runs: [],
      tenants: [tenant],
      activeTenantId: tenant.id,
    }),
    "utf8",
  );
  const graph = createSampleGraph({ now: new Date("2026-10-26T12:00:00.000Z") });
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
    graphFactory: () => graph,
    providerListFactory: () => [unavailableProvider],
    llmFactory: () => unavailableLlm,
  });
  return {
    store,
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
