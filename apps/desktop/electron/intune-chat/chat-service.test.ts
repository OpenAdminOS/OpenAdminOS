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
          refreshIfStale: false,
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
          text: "```json\n{\"tool\":\"query_cache\",\n```",
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
      assert.match(result.assistantMessage.content, /malformed tool JSON twice/i);
      assert.match(result.assistantMessage.content, /Deterministic answer/);
      assert.equal(result.assistantMessage.toolTrace?.length ?? 0, 0);
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
      store.dispose?.();
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
      store.dispose?.();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
