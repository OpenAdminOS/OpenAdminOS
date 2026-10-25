import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { AppStateStore } from "../state.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";
import type { RunGraphApi, RunLlmApi } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

let originalOllamaUrl: string | undefined;

before(() => {
  originalOllamaUrl = process.env.OPENAGENTS_OLLAMA_URL;
  process.env.OPENAGENTS_OLLAMA_URL = "http://127.0.0.1:9";
});

after(() => {
  if (originalOllamaUrl === undefined) {
    delete process.env.OPENAGENTS_OLLAMA_URL;
    return;
  }
  process.env.OPENAGENTS_OLLAMA_URL = originalOllamaUrl;
});

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
          activeModelByProviderId: { ollama: "mock-chat" },
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
        content: "Which stale Windows devices have not synced recently?",
      });

      // Resources refresh concurrently, so the order they interleave in
      // is not meaningful. What must hold is that each planned resource
      // was fetched, and that paging within a resource stayed ordered.
      assert.deepEqual(
        [...graphRequests].sort(),
        [
          "GET /deviceManagement/managedDevices",
          "GET /deviceManagement/managedDevices?skip=page-2",
          "GET /devices",
        ].sort(),
      );
      assert.ok(
        graphRequests.indexOf("GET /deviceManagement/managedDevices") <
          graphRequests.indexOf("GET /deviceManagement/managedDevices?skip=page-2"),
        "pages within a resource must still be fetched in order",
      );
      assert.match(answerPackPrompt, /WIN-01/);
      assert.match(answerPackPrompt, /WIN-02/);
      assert.doesNotMatch(answerPackPrompt, /admin@contoso\.example/);
      assert.doesNotMatch(answerPackPrompt, /tenant-1/);
      assert.match(result.assistantMessage.content, /WIN-01 is stale/);
      assert.equal(result.assistantMessage.sources?.[0]?.source, "live");
      assert.equal(result.assistantMessage.sources?.[0]?.path, "/deviceManagement/managedDevices");
      assert.ok(result.assistantMessage.sources?.[0]?.select?.includes("lastSyncDateTime"));
      assert.equal(result.assistantMessage.agentSuggestions?.length ?? 0, 0);
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
      assert.equal(suggestions.length, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks write prompts before any Graph refresh or model call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          activeModelByProviderId: { ollama: "mock-chat" },
          installedAgents: [
            {
              id: "offboarding-agent",
              slug: "offboarding-agent",
              name: "Offboarding agent",
              description: "Builds a stale-device offboarding plan from Intune sync and Entra sign-in signals, then retires devices after typed confirmation.",
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
    let modelCalls = 0;
    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => ({
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("retireManagedDevice should not run from chat."); },
        async request(input) {
          graphRequests.push(`${input.method} ${input.path}`);
          return { value: [] };
        },
      }),
      llmFactory: () => ({
        available: true,
        defaultModel: "mock-chat",
        async complete() {
          modelCalls += 1;
          return { text: "must not be called", model: "mock-chat" };
        },
        async *stream() {
          modelCalls += 1;
          yield { delta: "", accumulated: "", done: true, model: "mock-chat" };
        },
      }),
    });

    try {
      const result = await store.sendIntuneChatMessage({
        content: "Retire stale devices that have not synced",
      });
      assert.match(result.assistantMessage.content, /cannot perform tenant changes directly from chat/);
      assert.match(result.assistantMessage.content, /Offboarding agent/);
      assert.equal(result.assistantMessage.status, "completed");
      assert.deepEqual(graphRequests, [], "write block must fire before cache refresh");
      assert.equal(modelCalls, 0, "write block must fire before any model call");
      assert.deepEqual(result.assistantMessage.sources, []);
      assert.equal(result.assistantMessage.agentSuggestions?.[0]?.agentSlug, "offboarding-agent");

      const grant = await store.sendIntuneChatMessage({
        content: "Grant the finance group access to the VPN app",
      });
      assert.match(grant.assistantMessage.content, /cannot perform tenant changes directly from chat/);
      assert.deepEqual(graphRequests, [], "grant prompt must also block before refresh");
      assert.equal(modelCalls, 0, "grant prompt must also block before any model call");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives follow-up questions the bounded prior turns as context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          activeModelByProviderId: { ollama: "mock-chat" },
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

    const prompts: string[] = [];
    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => ({
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("retireManagedDevice should not run from chat."); },
        async request() { return { value: [] }; },
      }),
      llmFactory: () => ({
        available: true,
        defaultModel: "mock-chat",
        async complete(options) {
          prompts.push(options.prompt);
          return { text: "WIN-01 and MAC-01 have not synced recently.", model: "mock-chat" };
        },
        async *stream() {
          yield { delta: "", accumulated: "", done: true, model: "mock-chat" };
        },
      }),
    });

    try {
      const first = await store.sendIntuneChatMessage({
        content: "Which stale devices have not synced recently?",
        refreshIfStale: false,
      });
      const second = await store.sendIntuneChatMessage({
        content: "Show only the Windows ones",
        conversationId: first.conversation.id,
        refreshIfStale: false,
      });
      assert.equal(second.conversation.id, first.conversation.id);
      assert.ok(prompts.length >= 2);
      const followUpPrompt = prompts.at(-1)!;
      assert.match(followUpPrompt, /Conversation so far/);
      assert.match(followUpPrompt, /User: Which stale devices have not synced recently\?/);
      assert.match(followUpPrompt, /Assistant: WIN-01 and MAC-01 have not synced recently\./);
      assert.match(followUpPrompt, /Current question: Show only the Windows ones/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("streams agentic single-tenant chat and persists the tool trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          activeModelByProviderId: { ollama: "llama3.1:8b" },
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
    let completeCalls = 0;
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "llama3.1:8b",
      async complete() {
        completeCalls += 1;
        if (completeCalls === 1) {
          return {
            text: '```json\n{"tool":"query_cache","params":{"resource":"managedDevices","limit":5}}\n```',
            model: "llama3.1:8b",
          };
        }
        return {
          text: '```json\n{"final":true,"answer":"The cache query completed."}\n```',
          model: "llama3.1:8b",
        };
      },
      async *stream() {
        throw new Error("deterministic fallback should not run.");
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
    let closed = false;

    try {
      await store.setChatInvestigationMode("always-agentic");
      const eventTypes: string[] = [];
      const result = await store.streamIntuneChatMessage(
        {
          content: "Which managed devices should I inspect?",
        },
        (event) => eventTypes.push(event.type),
      );

      assert.equal(result.assistantMessage.status, "completed");
      assert.equal(result.assistantMessage.content, "The cache query completed.");
      assert.equal(result.assistantMessage.toolTrace?.[0]?.tool, "query_cache");
      assert.ok(eventTypes.includes("tool-step-start"));
      assert.ok(eventTypes.includes("tool-step-finish"));

      const messages = await store.getIntuneChatMessages(result.conversation.id);
      assert.equal(messages[1]?.toolTrace?.[0]?.tool, "query_cache");
      store.close();
      closed = true;

      const sqlite = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
      try {
        const toolCalls = sqlite.listToolCalls(result.conversation.id);
        assert.equal(toolCalls.some((call) => call.type === "query_cache"), true);
      } finally {
        sqlite.close();
      }
    } finally {
      if (!closed) store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to deterministic streaming when agentic protocol repair fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          activeModelByProviderId: { ollama: "llama3.1:8b" },
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
      defaultModel: "llama3.1:8b",
      async complete() {
        return {
          // Unrepairable: the tool name is cut off mid-token, so no
          // amount of brace balancing recovers a call from it.
          text: "```json\n{\"tool\": \"query_ca\n```",
          model: "llama3.1:8b",
        };
      },
      async *stream() {
        yield {
          delta: "Deterministic answer.",
          accumulated: "Deterministic answer.",
          done: true,
          model: "llama3.1:8b",
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
      await store.setChatInvestigationMode("always-agentic");
      const result = await store.streamIntuneChatMessage(
        {
          content: "Which managed devices should I inspect?",
          refreshIfStale: false,
        },
        () => undefined,
      );

      assert.equal(result.assistantMessage.status, "completed");
      assert.equal(result.assistantMessage.content, "Deterministic answer.");
      assert.match(result.assistantMessage.engineNotice ?? "", /malformed tool JSON/i);
      assert.equal(result.assistantMessage.toolTrace?.length ?? 0, 0);
      const saved = await store.getIntuneChatMessages(result.conversation.id);
      assert.equal(saved[1]?.content, "Deterministic answer.");
      assert.match(saved[1]?.engineNotice ?? "", /malformed tool JSON/i);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs a read-only multi-tenant compliance query with contained tenant failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          activeModelByProviderId: { ollama: "mock-chat" },
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
            {
              id: "tenant-2",
              displayName: "Fabrikam",
              username: "admin@fabrikam.example",
              homeAccountId: "home-account-2",
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

    const requestedTenantIds: string[] = [];
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete() {
        return {
          text: "One tenant completed and one tenant failed. Use the comparison table for source counts.",
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
      graphFactory: ({ tenantId }) => {
        requestedTenantIds.push(tenantId);
        const graph: RunGraphApi = {
          async listManagedDevices() {
            return [];
          },
          async retireManagedDevice() {
            throw new Error("retireManagedDevice should not run from multi-tenant chat.");
          },
          async request(input) {
            if (input.path !== "/deviceManagement/managedDevices") {
              return { value: [] };
            }
            if (tenantId === "tenant-2") {
              throw new Error("Graph request failed: 429 too many requests");
            }
            return {
              value: [
                {
                  id: "device-1",
                  deviceName: "WIN-COMPLIANT",
                  operatingSystem: "Windows",
                  complianceState: "compliant",
                  osVersion: "11.0.1",
                  userPrincipalName: "owner@contoso.example",
                  lastSyncDateTime: now,
                },
                {
                  id: "device-2",
                  deviceName: "WIN-NONCOMPLIANT",
                  operatingSystem: "Windows",
                  complianceState: "noncompliant",
                  osVersion: "10.0.1",
                  lastSyncDateTime: now,
                },
                {
                  id: "device-3",
                  deviceName: "MAC-01",
                  operatingSystem: "macOS",
                  complianceState: "compliant",
                  lastSyncDateTime: now,
                },
              ],
            };
          },
        };
        return graph;
      },
      llmFactory: () => llm,
    });

    try {
      const events: string[] = [];
      const result = await store.streamMultiTenantIntuneChat(
        {
          prompt:
            "List all compliant and all non-compliant Windows devices from every connected tenant.",
          tenantScope: { kind: "all" },
        },
        (event) => {
          events.push(event.type);
          if (event.type === "progress") {
            events.push(event.job.status);
          }
        },
      );

      assert.deepEqual(new Set(requestedTenantIds), new Set(["tenant-1", "tenant-2"]));
      assert.ok(events.includes("started"));
      assert.ok(events.includes("progress"));
      assert.ok(events.includes("completed"));
      assert.equal(result.job.status, "partial");
      assert.equal(result.job.summary.tenantsScanned, 2);
      assert.equal(result.job.summary.failedTenants, 1);
      assert.equal(result.job.summary.windowsDevices, 2);
      assert.equal(result.job.summary.compliant, 1);
      assert.equal(result.job.summary.nonCompliant, 1);
      assert.equal(result.job.deviceRows.length, 2);
      assert.equal(
        result.job.progress.find((entry) => entry.tenantId === "tenant-2")?.status,
        "failed",
      );
      assert.equal(result.conversation.scopeKind, "multi-tenant");
      assert.equal(result.conversation.multiTenantJobId, result.job.id);
      assert.match(result.assistantMessage.content, /one tenant failed/i);

      const jobs = await store.listMultiTenantChatJobs();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0]?.id, result.job.id);
      const messages = await store.getIntuneChatMessages(result.conversation.id);
      assert.equal(messages.length, 2);
      assert.equal(messages[0]?.role, "user");
      assert.equal(messages[1]?.role, "assistant");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks a multi-tenant write prompt before any tenant refresh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          activeModelByProviderId: { ollama: "mock-chat" },
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
            {
              id: "tenant-2",
              displayName: "Fabrikam",
              username: "admin@fabrikam.example",
              homeAccountId: "home-account-2",
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
    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => ({
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("retireManagedDevice should not run from chat."); },
        async request(input) {
          graphRequests.push(input.path);
          return { value: [] };
        },
      }),
      llmFactory: () => ({
        available: true,
        defaultModel: "mock-chat",
        async complete() {
          return { text: "must not be called", model: "mock-chat" };
        },
        async *stream() {
          yield { delta: "", accumulated: "", done: true, model: "mock-chat" };
        },
      }),
    });

    try {
      await assert.rejects(
        store.streamMultiTenantIntuneChat(
          { prompt: "Retire noncompliant devices in every tenant", tenantScope: { kind: "all" } },
          () => undefined,
        ),
        /cannot perform tenant changes directly from chat/,
      );
      assert.deepEqual(graphRequests, [], "write block must fire before any tenant refresh");
      assert.equal((await store.listMultiTenantChatJobs()).length, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attaches explicit workspace evidence, notes, and instructions to a chat prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify(
        {
          activeProviderId: "ollama",
          activeModelByProviderId: { ollama: "mock-chat" },
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
    let answerPackPrompt = "";
    const llm: RunLlmApi = {
      available: true,
      defaultModel: "mock-chat",
      async complete(options) {
        answerPackPrompt = options.prompt;
        return {
          text: "The workspace context points to WIN-42.",
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
      graphFactory: () => graph,
      llmFactory: () => llm,
    });

    try {
      const workspace = await store.createWorkspace({
        title: "Contoso pilot review",
        instructions: "Use pinned workspace material before broad cache results.",
      });
      const note = await store.addWorkspaceNote(
        workspace.id,
        "Scope the answer to pilot devices only.",
      );
      const evidence = await store.pinWorkspaceEvidence({
        workspaceId: workspace.id,
        tenantId: "tenant-1",
        title: "Pilot device",
        sourceType: "manual",
        content: { deviceName: "WIN-42", complianceState: "noncompliant" },
      });

      const result = await store.sendIntuneChatMessage({
        content: "Summarize the attached workspace context.",
        refreshIfStale: false,
        workspaceContext: {
          workspaceId: workspace.id,
          evidenceIds: [evidence.id],
          noteIds: [note.id],
          includeInstructions: true,
        },
      });

      assert.match(answerPackPrompt, /Workspace context attached by the admin/);
      assert.match(answerPackPrompt, /WIN-42/);
      assert.match(answerPackPrompt, /pilot devices only/);
      assert.match(answerPackPrompt, /Use pinned workspace material/);
      assert.equal(result.userMessage.content, "Summarize the attached workspace context.");
      assert.doesNotMatch(result.userMessage.content, /Workspace context attached/);
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
          activeModelByProviderId: { ollama: "mock-chat" },
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
          activeModelByProviderId: { ollama: "mock-chat" },
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
      assert.ok(events.some((event) => event.includes("First token")));
      assert.ok(events.some((event) => event.includes("First token and final token.")));
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
          activeModelByProviderId: { ollama: "mock-chat" },
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

  it("scopes conversation list, read, and mutations to the active tenant", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-host-"));
    const now = "2026-06-01T10:00:00.000Z";
    const statePath = join(dir, "state.json");
    await writeFile(statePath, JSON.stringify({
      activeProviderId: "ollama",
      installedAgents: [],
      runs: [],
      tenants: [
        { id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-account-1", addedAt: now },
        { id: "tenant-2", displayName: "Fabrikam", username: "admin@fabrikam.example", homeAccountId: "home-account-2", addedAt: now },
      ],
      activeTenantId: "tenant-1",
    }, null, 2), "utf8");
    const seed = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
    seed.createConversation({ id: "chat_a", title: "Contoso devices", tenantId: "tenant-1", now });
    seed.createConversation({ id: "chat_b", title: "Fabrikam devices", tenantId: "tenant-2", now });
    seed.insertMessage({ id: "msg_b", conversationId: "chat_b", role: "user", content: "Fabrikam secret question", status: "completed", createdAt: now });
    seed.close();

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => { throw new Error("graph must not run"); },
      llmFactory: () => { throw new Error("llm must not run"); },
    });
    try {
      assert.deepEqual((await store.listIntuneChatConversations()).map((entry) => entry.id), ["chat_a"]);
      assert.deepEqual((await store.searchIntuneChatConversations("Fabrikam")).map((entry) => entry.id), []);
      await assert.rejects(() => store.getIntuneChatMessages("chat_b"), /different tenant/);
      await assert.rejects(() => store.renameIntuneChatConversation("chat_b", "Renamed"), /different tenant/);
      await assert.rejects(() => store.setIntuneChatConversationPinned("chat_b", true), /different tenant/);
      await assert.rejects(() => store.deleteIntuneChatConversation("chat_b"), /different tenant/);
      const renamed = await store.renameIntuneChatConversation("chat_a", "Contoso renamed");
      assert.equal(renamed.title, "Contoso renamed");
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

describe("Graph cache refresh concurrency and cancellation", () => {
  const now = "2026-06-01T10:00:00.000Z";

  async function makeStore(
    dir: string,
    graph: RunGraphApi,
    llm: RunLlmApi,
  ): Promise<AppStateStore> {
    const statePath = join(dir, "state.json");
    await writeFile(
      statePath,
      JSON.stringify({
        activeProviderId: "ollama",
        activeModelByProviderId: { ollama: "mock-chat" },
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
      }),
      "utf8",
    );
    return new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
      graphFactory: () => graph,
      llmFactory: () => llm,
    });
  }

  const quietLlm: RunLlmApi = {
    available: true,
    defaultModel: "mock-chat",
    async complete() {
      return { text: "ok", model: "mock-chat" };
    },
    async *stream() {
      yield { delta: "ok", accumulated: "ok", done: true, model: "mock-chat" };
    },
  };

  it("refreshes several resources at once instead of strictly serially", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-conc-"));
    let inFlight = 0;
    let peak = 0;
    const graph: RunGraphApi = {
      listManagedDevices: async () => [],
      retireManagedDevice: async () => undefined,
      async request() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return { value: [] };
      },
    };
    const store = await makeStore(dir, graph, quietLlm);
    try {
      // A question that plans several resources.
      await store.sendIntuneChatMessage({
        content: "Which compliance policies target user groups?",
      });
      assert.ok(peak > 1, `expected concurrent refreshes, peak was ${peak}`);
      assert.ok(peak <= 4, `expected at most 4 concurrent refreshes, peak was ${peak}`);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops fetching the remaining resources when the caller aborts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-abort-"));
    const controller = new AbortController();
    let requests = 0;
    const graph: RunGraphApi = {
      listManagedDevices: async () => [],
      retireManagedDevice: async () => undefined,
      async request() {
        requests += 1;
        // Abort while the first wave is still in flight.
        if (requests === 1) controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { value: [] };
      },
    };
    const store = await makeStore(dir, graph, quietLlm);
    try {
      await store
        .streamIntuneChatMessage(
          { content: "Which compliance policies target user groups?" },
          () => undefined,
          { signal: controller.signal },
        )
        .catch(() => undefined);
      // Without the signal reaching the refresh loop every planned
      // resource would have been fetched before the cancellation was
      // noticed.
      assert.ok(
        requests < 6,
        `aborting must stop the refresh early; ${requests} requests were made`,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('renders device lists and app counts from SQLite and recognizes an installed audit name without model guesses', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openadminos-nova-reports-'));
  const filePath = join(dir, 'state.json');
  await writeFile(filePath, JSON.stringify({activeProviderId:'ollama', activeModelByProviderId:{ollama:'qwen3:8b'}, activeTenantId:'tenant-test',
    tenants:[{id:'tenant-test',displayName:'Test tenant',username:'admin@example.test',homeAccountId:'test',addedAt:new Date().toISOString()}], runs:[],
    installedAgents:[{id:'tenant-change-audit',slug:'tenant-change-audit',name:'Tenant change audit',description:'Review directory audit logs',mode:'read',category:'policies',tier:'agent',requiresEntraTier:'free',scopes:['AuditLog.Read.All'],author:{name:'Test'},version:'1.0.0',installedAt:new Date().toISOString()}]}));
  const requests: string[] = [];
  const graph: RunGraphApi = {listManagedDevices:async () => [], retireManagedDevice:async () => {throw new Error('Unexpected write');}, request:async ({path}) => {
    requests.push(path);
    if (path === '/deviceManagement/managedDevices') return {value:[{id:'a',deviceName:'Device A',complianceState:'noncompliant'},{id:'b',deviceName:'Device B',complianceState:'noncompliant'},{id:'c',deviceName:'Compliant device',complianceState:'compliant'}]};
    if (path === '/deviceAppManagement/mobileApps') return {value:[{id:'app-a',displayName:'Managed app'}]};
    if (path === '/deviceManagement/detectedApps') return {value:[{id:'detected-a',displayName:'Detected app A'},{id:'detected-b',displayName:'Detected app B'}]};
    return {value:[]};
  }};
  const store = new AppStateStore({filePath,tokenStore,userDataPath:dir,statsApiUrl:'',graphFactory:()=>graph,llmFactory:()=>{throw new Error('These requests must not invoke the reasoning model');}});
  try {
    const report = await store.streamIntuneChatMessage({content:'Show all the non-compliant devices as a list'}, ()=>{});
    assert.match(report.assistantMessage.content, /- Device A/);
    assert.match(report.assistantMessage.content, /- Device B/);
    assert.doesNotMatch(report.assistantMessage.content, /Compliant device/);
    assert.deepEqual(requests, ['/deviceManagement/managedDevices']);
    const apps = await store.streamIntuneChatMessage({content:'How many apps do I have'}, ()=>{});
    assert.match(apps.assistantMessage.content, /1 Intune app catalog entries/);
    assert.match(apps.assistantMessage.content, /2 detected app inventory entries/);
    assert.deepEqual(requests.slice(1).sort(), ['/deviceAppManagement/mobileApps','/deviceManagement/detectedApps'].sort());
    const agent = await store.streamIntuneChatMessage({content:'Tenant change audit',refreshIfStale:false}, ()=>{});
    assert.match(agent.assistantMessage.content, /installed read-only agent/);
    assert.doesNotMatch(agent.assistantMessage.content, /cannot perform tenant changes/);
  } finally {store.close();await rm(dir,{recursive:true,force:true});}
});
