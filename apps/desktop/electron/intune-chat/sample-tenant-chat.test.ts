import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { IntuneChatStreamEvent, ProviderSummary, RunLlmApi } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { PILOT_COPY, PILOT_PROMPTS } from "../../src/shared/pilot-mode.js";
import {
  SAMPLE_TENANT_HOME_ACCOUNT_ID,
  SAMPLE_TENANT_ID,
  SAMPLE_TENANT_NAME,
  SAMPLE_TENANT_USERNAME,
} from "../sample-tenant/dataset.js";
import { createSampleGraph } from "../sample-tenant/graph.js";
import { buildPilotPreparedAnswer } from "../sample-tenant/pilot-answers.js";
import { AppStateStore } from "../state.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");

// A connected provider: if pilot Chat ever fell through to the normal path,
// it would build and call this LLM.
const connectedProvider: ProviderSummary = {
  id: "ollama",
  name: "Ollama",
  description: "Local provider",
  isLocal: true,
  status: "connected",
  models: ["llama3.1:8b"],
  defaultModel: "llama3.1:8b",
};

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("pilot Chat", () => {
  it("answers every starter and follow-up with the prepared answer and never builds an LLM", async () => {
    const fixture = await makeChatFixture(true);
    try {
      for (const prompt of PILOT_PROMPTS) {
        const result = await fixture.store.sendIntuneChatMessage({ content: prompt });
        const expected = await buildPilotPreparedAnswer(createSampleGraph({ now: NOW }), prompt, NOW);
        assert.equal(result.assistantMessage.status, "completed", prompt);
        assert.equal(result.assistantMessage.content, expected?.markdown, prompt);
        assert.equal(result.assistantMessage.providerId, undefined);
        assert.equal(result.assistantMessage.model, undefined);
        assert.ok(result.assistantMessage.content.endsWith(PILOT_COPY.answerFooter));
      }
      assert.equal(fixture.llmBuilds, 0);
      assert.equal(fixture.providerLists, 0);
    } finally {
      await fixture.close();
    }
  });

  it("streams the same prepared answer, including for Nova", async () => {
    const fixture = await makeChatFixture(true);
    try {
      const events: IntuneChatStreamEvent["type"][] = [];
      const prompt = "Which Windows devices are not encrypted?";
      const result = await fixture.store.streamIntuneChatMessage(
        { content: prompt },
        (event) => events.push(event.type),
        { voice: true },
      );
      const expected = await buildPilotPreparedAnswer(createSampleGraph({ now: NOW }), prompt, NOW);
      assert.equal(result.assistantMessage.content, expected?.markdown);
      assert.match(result.assistantMessage.content, /^5 of 71 managed Windows devices/);
      assert.deepEqual(events, ["started", "status", "delta", "completed"]);
      assert.equal(fixture.llmBuilds, 0);
    } finally {
      await fixture.close();
    }
  });

  it("rejects a prompt that is not prepared, without writing a conversation", async () => {
    const fixture = await makeChatFixture(true);
    try {
      await assert.rejects(
        () => fixture.store.sendIntuneChatMessage({ content: "Draft a limerick about coffee." }),
        { message: PILOT_COPY.promptRejected },
      );
      await assert.rejects(
        () =>
          fixture.store.streamIntuneChatMessage(
            { content: "Which policies changed recently?" },
            () => undefined,
          ),
        { message: PILOT_COPY.promptRejected },
      );
      assert.equal((await fixture.store.listIntuneChatConversations()).length, 0);
      assert.equal(fixture.llmBuilds, 0);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the existing provider path for a real tenant", async () => {
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
      assert.ok(fixture.llmBuilds > 0);
    } finally {
      await fixture.close();
    }
  });
});

async function makeChatFixture(sample: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-pilot-chat-"));
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
  let llmBuilds = 0;
  let providerLists = 0;
  const unavailableLlm: RunLlmApi = {
    available: false,
    async complete() {
      throw new Error("The LLM must not be called.");
    },
    async *stream() {
      throw new Error("The LLM must not be called.");
    },
  };
  const graph = createSampleGraph({ now: NOW });
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
    clock: () => new Date(NOW.getTime()),
    graphFactory: () => graph,
    providerListFactory: () => {
      providerLists += 1;
      return [sample ? connectedProvider : { ...connectedProvider, status: "error", models: [] }];
    },
    llmFactory: () => {
      llmBuilds += 1;
      return unavailableLlm;
    },
  });
  return {
    store,
    get llmBuilds() {
      return llmBuilds;
    },
    get providerLists() {
      return providerLists;
    },
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
