import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { ProviderSummary } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

const providers: ProviderSummary[] = [
  {
    id: "ollama",
    name: "Ollama",
    description: "Upgrade compatibility fixture.",
    isLocal: true,
    status: "connected",
    models: ["fixture-model"],
    defaultModel: "fixture-model",
  },
];

describe("upgrade compatibility", () => {
  it("preserves v0.3 JSON state and older SQLite rows while applying additive migrations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-v030-upgrade-"));
    const statePath = join(dir, "state.json");
    const dbPath = join(dir, "openadminos.db");
    await writeFile(statePath, `${JSON.stringify(v030State, null, 2)}\n`, "utf8");
    seedLegacyDatabase(dbPath);

    const store = new AppStateStore({
      filePath: statePath,
      userDataPath: dir,
      tokenStore,
      statsApiUrl: "",
      appVersion: "0.4.0",
      providerListFactory: () => providers,
    });

    try {
      const state = await store.getAppState();
      assert.equal(state.activeTenantId, "tenant-v030");
      assert.equal(state.tenants[0]?.displayName, "Legacy tenant");
      assert.equal(state.installedAgents[0]?.slug, "legacy-agent");
      assert.equal(state.runs[0]?.id, "run-v030");
      assert.equal(state.activeModelByProviderId?.ollama, "legacy-model");

      const azure = await store.getAzureOpenAIConfig();
      assert.equal(azure.endpoint, "https://legacy-resource.openai.azure.com");
      assert.equal(azure.deployment, "legacy-deployment");
      assert.equal(azure.apiVersion, "2024-10-21");

      // Force a current-version write and verify that fields not exposed by
      // getAppState still survive the read/sanitize/write upgrade path.
      await store.setRegistryInstallCountsEnabled(false);
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as typeof v030State;
      assert.equal(persisted.tenants[0]?.id, "tenant-v030");
      assert.equal(persisted.runs[0]?.id, "run-v030");
      assert.equal(persisted.installedAgents[0]?.settings?.staleDays, 90);
      assert.equal(persisted.connectors?.teams?.config?.teamId, "legacy-team");
      assert.equal(persisted.runHistoryRetention?.keepLastRuns, 250);
      assert.equal(persisted.registryInstallCountsEnabled, false);
    } finally {
      store.close();
    }

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const conversation = db
        .prepare("SELECT title FROM chat_conversations WHERE id = ?")
        .get("conversation-v030") as { title: string } | undefined;
      const cache = db
        .prepare(
          "SELECT row_count FROM graph_cache_status WHERE tenant_id = ? AND resource = ?",
        )
        .get("tenant-v030", "managedDevices") as { row_count: number } | undefined;
      assert.equal(conversation?.title, "Legacy investigation");
      assert.equal(cache?.row_count, 12);

      assertColumns(db, "chat_conversations", [
        "pinned_at",
        "scope_kind",
        "scope_json",
        "multi_tenant_job_id",
      ]);
      assertColumns(db, "graph_cache_status", ["page_count", "page_limit_reached"]);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function seedLegacyDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE chat_conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        tenant_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE graph_cache_status (
        tenant_id TEXT NOT NULL,
        resource TEXT NOT NULL,
        label TEXT NOT NULL,
        row_count INTEGER NOT NULL,
        refreshed_at TEXT,
        scope_set_json TEXT NOT NULL,
        last_error TEXT,
        PRIMARY KEY (tenant_id, resource)
      );
      INSERT INTO chat_conversations (
        id, title, tenant_id, created_at, updated_at
      ) VALUES (
        'conversation-v030', 'Legacy investigation', 'tenant-v030',
        '2026-07-05T00:00:00.000Z', '2026-07-05T00:05:00.000Z'
      );
      INSERT INTO graph_cache_status (
        tenant_id, resource, label, row_count, refreshed_at, scope_set_json, last_error
      ) VALUES (
        'tenant-v030', 'managedDevices', 'Managed devices', 12,
        '2026-07-05T00:04:00.000Z', '[]', NULL
      );
    `);
  } finally {
    db.close();
  }
}

function assertColumns(db: DatabaseSync, table: string, expected: string[]): void {
  const columns = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  for (const name of expected) {
    assert.equal(columns.has(name), true, `${table}.${name} was not migrated`);
  }
}

const v030State = {
  activeProviderId: "ollama",
  activeModelByProviderId: { ollama: "legacy-model" },
  installedAgents: [
    {
      id: "legacy-agent",
      slug: "legacy-agent",
      name: "Legacy agent",
      description: "Installed before the v0.4 upgrade.",
      mode: "read",
      category: "devices",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
      author: { name: "OpenAdminOS", verified: true },
      version: "1.0.0",
      installedAt: "2026-07-05T00:00:00.000Z",
      settings: { staleDays: 90 },
    },
  ],
  runs: [
    {
      id: "run-v030",
      agentSlug: "legacy-agent",
      status: "completed",
      queuedAt: "2026-07-05T00:00:00.000Z",
      startedAt: "2026-07-05T00:00:01.000Z",
      finishedAt: "2026-07-05T00:00:02.000Z",
      providerId: "ollama",
      model: "legacy-model",
      tenantId: "tenant-v030",
      summary: "Legacy result",
      steps: [],
      logs: [],
    },
  ],
  tenants: [
    {
      id: "tenant-v030",
      displayName: "Legacy tenant",
      username: "admin@legacy.example",
      homeAccountId: "home-v030",
      addedAt: "2026-07-05T00:00:00.000Z",
      lastUsedAt: "2026-07-05T00:00:00.000Z",
      entraTier: "p1",
    },
  ],
  activeTenantId: "tenant-v030",
  registryInstallCountsEnabled: true,
  connectors: {
    teams: {
      config: { teamId: "legacy-team", channelId: "legacy-channel" },
      status: "connected",
    },
  },
  providerConfigs: {
    azureOpenAI: {
      endpoint: "https://legacy-resource.openai.azure.com",
      deployment: "legacy-deployment",
      apiVersion: "2024-10-21",
    },
  },
  runHistoryRetention: {
    neverPrune: false,
    keepLastRuns: 250,
    keepDays: 180,
  },
};
