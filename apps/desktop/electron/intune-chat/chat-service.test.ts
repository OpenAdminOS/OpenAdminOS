import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AppStateStore } from "../state.js";
import type { RunGraphApi, RunLlmApi } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("Intune Chat host service", () => {
  it("refreshes Graph cache, builds an answer pack, and persists chat messages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          installedAgents: [
            {
              id: "offboarding-agent",
              slug: "offboarding-agent",
              name: "Offboarding agent",
              description: "Builds stale-device offboarding plans from Intune device evidence.",
              mode: "write",
              category: "devices",
              tier: "agent",
              requiresEntraTier: "free",
              scopes: ["DeviceManagementManagedDevices.Read.All"],
              author: { name: "OpenAdminOS" },
              version: "1.0.0",
              installedAt: now,
            },
          ],
          runs: [],
          tenants: [
            {
              id: "tenant-1",
              displayName: "Contoso",
              username: "admin@contoso.example",
              homeAccountId: "home-account-1",
              addedAt: now,
            },
          ],
          activeTenantId: "tenant-1",
        },
        null,
        2,
      ),
      "utf8",
    );

    const graphRequests: string[] = [];
    const graph: RunGraphApi = {
      async listManagedDevices() {
        return [];
      },
      async retireManagedDevice() {
        throw new Error("retireManagedDevice should not run from chat.");
      },
      async request(input) {
        const skipToken = input.query?.["$skiptoken"];
        graphRequests.push(
          `${input.method} ${input.path}${skipToken ? `?skip=${skipToken}` : ""}`,
        );
        if (input.path === "/deviceManagement/managedDevices") {
          if (skipToken === "page-2") {
            return {
              value: [
                {
                  id: "device-2",
                  deviceName: "WIN-02",
                  operatingSystem: "Windows",
                  complianceState: "compliant",
                  lastSyncDateTime: "2025-12-01T00:00:00.000Z",
                },
              ],
            };
          }
          return {
            "@odata.nextLink":
              "https://graph.microsoft.com/beta/deviceManagement/managedDevices?$skiptoken=page-2",
            value: [
              {
                id: "device-1",
                deviceName: "WIN-01",
                operatingSystem: "Windows",
                complianceState: "noncompliant",
                lastSyncDateTime: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (input.path === "/devices") {
          return {
            value: [
              {
                id: "entra-device-1",
                displayName: "WIN-01",
                operatingSystem: "Windows",
                approximateLastSignInDateTime: "2026-01-02T00:00:00.000Z",
              },
            ],
          };
        }
        return { value: [] };
      },
    };
    let answerPackPrompt = "";
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete(options) {
        answerPackPrompt = options.prompt;
        return {
          text: "WIN-01 is stale based on cached Intune and Entra device evidence.",
          model: "mock-chat",
        };
      },
      async *stream() {
        yield {
          delta: "",
          accumulated: "",
          done: true,
          model: "mock-chat",
        };
      },
    };

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: ({ scopes }) => {
        assert.deepEqual(scopes, [
          "AuditLog.Read.All",
          "Device.Read.All",
          "DeviceManagementManagedDevices.Read.All",
        ]);
        return graph;
      },
      llmFactory: () => llm,
    });

    try {
      await store.setSelfTrainingEnabled(true);
      const result = await store.sendIntuneChatMessage({
        content: "Always retire stale Windows devices that have not synced.",
      });

      assert.deepEqual(graphRequests, [
        "GET /deviceManagement/managedDevices",
        "GET /deviceManagement/managedDevices?skip=page-2",
        "GET /devices",
        "GET /auditLogs/signIns",
      ]);
      assert.match(answerPackPrompt, /WIN-01/);
      assert.match(answerPackPrompt, /WIN-02/);
      assert.doesNotMatch(answerPackPrompt, /admin@contoso\.example/);
      assert.doesNotMatch(answerPackPrompt, /tenant-1/);
      assert.match(result.assistantMessage.content, /WIN-01 is stale/);
      assert.equal(result.assistantMessage.sources?.[0]?.source, "live");
      assert.equal(result.assistantMessage.sources?.[0]?.path, "/deviceManagement/managedDevices");
      assert.ok(result.assistantMessage.sources?.[0]?.select?.includes("lastSyncDateTime"));
      assert.equal(result.assistantMessage.agentSuggestions?.[0]?.agentSlug, "offboarding-agent");
      const managedDeviceStatus = result.cacheStatus.resources.find(
        (resource) => resource.resource === "managedDevices",
      );
      assert.equal(managedDeviceStatus?.rows, 2);
      assert.equal(managedDeviceStatus?.pages, 2);
      assert.equal(managedDeviceStatus?.pageLimitReached, false);

      const messages = await store.getIntuneChatMessages(result.conversation.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[1]?.role, "assistant");

      const suggestions = await store.listSelfTrainingSuggestions("pending");
      assert.equal(suggestions.length, 1);
      assert.equal(suggestions[0]?.agentSlug, "offboarding-agent");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists an assistant failure when the LLM provider errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          installedAgents: [],
          runs: [],
          tenants: [
            {
              id: "tenant-1",
              displayName: "Contoso",
              username: "admin@contoso.example",
              homeAccountId: "home-account-1",
              addedAt: now,
            },
          ],
          activeTenantId: "tenant-1",
        },
        null,
        2,
      ),
      "utf8",
    );

    const graph: RunGraphApi = {
      async listManagedDevices() {
        return [];
      },
      async retireManagedDevice() {
        throw new Error("retireManagedDevice should not run from chat.");
      },
      async request() {
        return { value: [] };
      },
    };
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete() {
        throw new Error("provider unavailable");
      },
      async *stream() {
        yield {
          delta: "",
          accumulated: "",
          done: true,
          model: "mock-chat",
        };
      },
    };

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => graph,
      llmFactory: () => llm,
    });

    try {
      const result = await store.sendIntuneChatMessage({
        content: "Show stale devices",
      });

      assert.equal(result.assistantMessage.status, "failed");
      assert.match(result.assistantMessage.content, /provider unavailable/);
      const messages = await store.getIntuneChatMessages(result.conversation.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.status, "failed");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams assistant deltas and persists the final response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          installedAgents: [],
          runs: [],
          tenants: [
            {
              id: "tenant-1",
              displayName: "Contoso",
              username: "admin@contoso.example",
              homeAccountId: "home-account-1",
              addedAt: now,
            },
          ],
          activeTenantId: "tenant-1",
        },
        null,
        2,
      ),
      "utf8",
    );

    const graph: RunGraphApi = {
      async listManagedDevices() {
        return [];
      },
      async retireManagedDevice() {
        throw new Error("retireManagedDevice should not run from chat.");
      },
      async request() {
        return { value: [] };
      },
    };
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete() {
        throw new Error("complete should not be used by the streaming path.");
      },
      async *stream() {
        yield {
          delta: "First token",
          accumulated: "First token",
          done: false,
          model: "mock-chat",
        };
        yield {
          delta: " and final token.",
          accumulated: "First token and final token.",
          done: true,
          model: "mock-chat",
        };
      },
    };

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => graph,
      llmFactory: () => llm,
    });

    try {
      const events: string[] = [];
      const result = await store.streamIntuneChatMessage(
        { content: "Show stale devices" },
        (event) => {
          events.push(event.type);
          if (event.type === "delta") {
            events.push(event.content);
          }
        },
      );

      assert.match(result.assistantMessage.content, /First token and final token/);
      assert.ok(events.includes("started"));
      assert.ok(events.includes("First token"));
      assert.ok(events.includes("First token and final token."));
      assert.ok(events.includes("completed"));

      const messages = await store.getIntuneChatMessages(result.conversation.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.status, "completed");
      assert.match(messages[1]?.content ?? "", /final token/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cancels a streaming chat response without persisting generated tail output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          installedAgents: [],
          runs: [],
          tenants: [
            {
              id: "tenant-1",
              displayName: "Contoso",
              username: "admin@contoso.example",
              homeAccountId: "home-account-1",
              addedAt: now,
            },
          ],
          activeTenantId: "tenant-1",
        },
        null,
        2,
      ),
      "utf8",
    );

    const graph: RunGraphApi = {
      async listManagedDevices() {
        return [];
      },
      async retireManagedDevice() {
        throw new Error("retireManagedDevice should not run from chat.");
      },
      async request() {
        return { value: [] };
      },
    };
    let sawSignal = false;
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete() {
        throw new Error("complete should not be used by the streaming path.");
      },
      async *stream(options) {
        sawSignal = Boolean(options.signal);
        yield {
          delta: "Partial token",
          accumulated: "Partial token",
          done: false,
          model: "mock-chat",
        };
        await new Promise<void>((resolve) => {
          if (options.signal?.aborted) {
            resolve();
            return;
          }
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield {
          delta: " should be discarded.",
          accumulated: "Partial token should be discarded.",
          done: true,
          model: "mock-chat",
        };
      },
    };

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => graph,
      llmFactory: () => llm,
    });

    try {
      const controller = new AbortController();
      const events: string[] = [];
      const result = await store.streamIntuneChatMessage(
        { content: "Show stale devices", refreshIfStale: false },
        (event) => {
          events.push(event.type);
          if (event.type === "delta") {
            events.push(event.content);
            controller.abort();
          }
        },
        { signal: controller.signal },
      );

      assert.equal(sawSignal, true);
      assert.equal(result.assistantMessage.status, "cancelled");
      assert.match(result.assistantMessage.content, /stopped by user/i);
      assert.doesNotMatch(result.assistantMessage.content, /discarded/);
      assert.ok(events.includes("cancelled"));
      assert.ok(!events.includes("completed"));

      const messages = await store.getIntuneChatMessages(result.conversation.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[1]?.status, "cancelled");
      assert.doesNotMatch(messages[1]?.content ?? "", /discarded/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects hosted-provider chat before Graph or LLM work without consent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "anthropic",
          installedAgents: [],
          runs: [],
          tenants: [
            {
              id: "tenant-1",
              displayName: "Contoso",
              username: "admin@contoso.example",
              homeAccountId: "home-account-1",
              addedAt: now,
            },
          ],
          activeTenantId: "tenant-1",
        },
        null,
        2,
      ),
      "utf8",
    );

    let graphTouched = false;
    let llmTouched = false;
    const graph: RunGraphApi = {
      async listManagedDevices() {
        graphTouched = true;
        return [];
      },
      async retireManagedDevice() {
        throw new Error("retireManagedDevice should not run from chat.");
      },
      async request() {
        graphTouched = true;
        return { value: [] };
      },
    };
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete() {
        llmTouched = true;
        return { text: "Should not run.", model: "mock-chat" };
      },
      async *stream() {
        llmTouched = true;
        yield { delta: "", accumulated: "", done: true, model: "mock-chat" };
      },
    };

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => graph,
      llmFactory: () => llm,
    });

    try {
      await assert.rejects(
        () => store.sendIntuneChatMessage({ content: "Show stale devices" }),
        /Hosted provider confirmation is required/,
      );
      assert.equal(graphTouched, false);
      assert.equal(llmTouched, false);
      assert.equal((await store.listIntuneChatConversations()).length, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("allows hosted-provider chat with matching fresh consent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "anthropic",
          installedAgents: [],
          runs: [],
          tenants: [
            {
              id: "tenant-1",
              displayName: "Contoso",
              username: "admin@contoso.example",
              homeAccountId: "home-account-1",
              addedAt: now,
            },
          ],
          activeTenantId: "tenant-1",
        },
        null,
        2,
      ),
      "utf8",
    );

    const graph: RunGraphApi = {
      async listManagedDevices() {
        return [];
      },
      async retireManagedDevice() {
        throw new Error("retireManagedDevice should not run from chat.");
      },
      async request() {
        return { value: [] };
      },
    };
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete() {
        return { text: "Hosted answer with confirmed tenant context.", model: "mock-chat" };
      },
      async *stream() {
        yield {
          delta: "Hosted answer",
          accumulated: "Hosted answer",
          done: true,
          model: "mock-chat",
        };
      },
    };

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => graph,
      llmFactory: () => llm,
    });

    try {
      const result = await store.sendIntuneChatMessage({
        content: "Show stale devices",
        refreshIfStale: false,
        hostedProviderConsent: {
          tenantId: "tenant-1",
          providerId: "anthropic",
          acknowledgedAt: new Date().toISOString(),
          remember: true,
        },
      });
      assert.equal(result.assistantMessage.status, "completed");
      assert.match(result.assistantMessage.content, /Hosted answer/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
