import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunLlmApi, TenantRecord } from "@openadminos/agent-sdk";

import { runAgenticChat } from "./agentic-loop.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";
import type { IntuneChatToolContext } from "./tools.js";

const tenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-account-1",
  addedAt: "2026-06-01T10:00:00.000Z",
};

describe("Intune Chat agentic loop", () => {
  it("runs two tool calls and returns a final answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-agentic-loop-"));
    const store = seededStore(dir);
    try {
      const llm = scriptedLlm([
        '```json\n{"tool":"list_cached_resources","params":{}}\n```',
        '```json\n{"tool":"query_cache","params":{"resource":"managedDevices","limit":5}}\n```',
        '```json\n{"final":true,"answer":"WIN-01 is the relevant device."}\n```',
      ]);
      const starts: string[] = [];
      const finishes: string[] = [];
      const result = await runAgenticChat({
        question: "Which Windows devices are relevant?",
        tenant,
        providerId: "ollama",
        providerIsLocal: true,
        model: "llama3.1:8b",
        llm,
        tools: toolContext(store),
        plannedResources: ["managedDevices"],
        agentSuggestions: [],
        generatedAt: "2026-06-01T10:00:00.000Z",
        maxTokens: 900,
        onToolStart: (event) => starts.push(event.tool),
        onToolFinish: (event) => finishes.push(event.traceEntry.tool),
      });
      assert.equal(result.ok, true);
      assert.equal(result.answer, "WIN-01 is the relevant device.");
      assert.deepEqual(starts, ["list_cached_resources", "query_cache"]);
      assert.deepEqual(finishes, ["list_cached_resources", "query_cache"]);
      assert.equal(result.toolTrace.length, 2);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("repairs one malformed tool JSON response", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-agentic-loop-"));
    const store = seededStore(dir);
    try {
      const llm = scriptedLlm([
        "```json\n{\"tool\":\"query_cache\",\n```",
        '```json\n{"final":true,"answer":"Repaired response."}\n```',
      ]);
      const result = await runAgenticChat(baseInput(store, llm));
      assert.equal(result.ok, true);
      assert.equal(result.answer, "Repaired response.");
      assert.equal(result.iterations, 2);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back after two malformed tool JSON responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-agentic-loop-"));
    const store = seededStore(dir);
    try {
      const llm = scriptedLlm([
        "```json\n{\"tool\":\"query_cache\",\n```",
        "```json\n{\"tool\":\"query_cache\",\n```",
      ]);
      const result = await runAgenticChat(baseInput(store, llm));
      assert.equal(result.ok, false);
      assert.equal(result.reason, "malformed-output");
      assert.match(result.fallbackNotice, /malformed tool JSON twice/i);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns a fallback signal when the iteration cap is hit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-agentic-loop-"));
    const store = seededStore(dir);
    try {
      const llm = scriptedLlm(
        Array.from(
          { length: 6 },
          () => '```json\n{"tool":"list_cached_resources","params":{}}\n```',
        ),
      );
      const result = await runAgenticChat(baseInput(store, llm));
      assert.equal(result.ok, false);
      assert.equal(result.reason, "iteration-cap");
      assert.equal(result.toolTrace.length, 6);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extracts prose-wrapped JSON tool calls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-agentic-loop-"));
    const store = seededStore(dir);
    try {
      const llm = scriptedLlm([
        'I will inspect the cache.\n```json\n{"tool":"query_cache","params":{"resource":"managedDevices","limit":1}}\n```',
        "Plain final answer with no tool JSON.",
      ]);
      const result = await runAgenticChat(baseInput(store, llm));
      assert.equal(result.ok, true);
      assert.equal(result.answer, "Plain final answer with no tool JSON.");
      assert.equal(result.toolTrace[0]?.tool, "query_cache");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("respects cancellation between tool iterations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-agentic-loop-"));
    const store = seededStore(dir);
    try {
      const controller = new AbortController();
      const llm = scriptedLlm([
        '```json\n{"tool":"list_cached_resources","params":{}}\n```',
        '```json\n{"final":true,"answer":"Should not be reached."}\n```',
      ]);
      await assert.rejects(
        runAgenticChat({
          ...baseInput(store, llm),
          signal: controller.signal,
          onToolFinish: () => controller.abort(),
        }),
        /Agentic chat stopped by user/,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function baseInput(store: IntelligenceSqliteStore, llm: RunLlmApi) {
  return {
    question: "Inspect managed devices.",
    tenant,
    providerId: "ollama" as const,
    providerIsLocal: true,
    model: "llama3.1:8b",
    llm,
    tools: toolContext(store),
    plannedResources: ["managedDevices" as const],
    agentSuggestions: [],
    generatedAt: "2026-06-01T10:00:00.000Z",
    maxTokens: 900,
  };
}

function scriptedLlm(responses: string[]): RunLlmApi {
  let index = 0;
  return {
    available: true,
    defaultModel: "mock-model",
    async complete() {
      const text = responses[index] ?? responses.at(-1) ?? "";
      index += 1;
      return { text, model: "mock-model" };
    },
    async *stream() {
      yield {
        delta: "",
        accumulated: "",
        done: true,
        model: "mock-model",
      };
    },
  };
}

function seededStore(dir: string): IntelligenceSqliteStore {
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  store.replaceGraphResources({
    tenantId: "tenant-1",
    resource: "managedDevices",
    label: "Intune managed devices",
    scopeSet: ["DeviceManagementManagedDevices.Read.All"],
    refreshedAt: "2026-06-01T10:00:00.000Z",
    rows: [
      {
        id: "device-1",
        deviceName: "WIN-01",
        displayName: "WIN-01",
        operatingSystem: "Windows",
        complianceState: "compliant",
      },
    ],
  });
  return store;
}

function toolContext(store: IntelligenceSqliteStore): IntuneChatToolContext {
  return {
    tenantId: "tenant-1",
    store,
    graphForScopes: async () => ({
      async listManagedDevices() {
        return [];
      },
      async retireManagedDevice() {
        throw new Error("write should not run");
      },
      async request() {
        return { value: [] };
      },
    }),
    refreshResource: async (resource) => ({
      resource,
      label: resource,
      rows: 1,
      refreshedAt: "2026-06-01T10:01:00.000Z",
      ok: true,
    }),
  };
}
