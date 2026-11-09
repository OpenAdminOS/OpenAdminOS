import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";

import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("tenant disconnect", () => {
  it("purges tenant-scoped state, SQLite data, and multi-tenant artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-disconnect-"));
    const statePath = join(dir, "state.json");
    const dbPath = join(dir, "openadminos.db");
    await writeFile(
      statePath,
      `${JSON.stringify({
        activeProviderId: "ollama",
        installedAgents: [],
        tenants: [
          {
            id: "tenant-1",
            displayName: "Contoso",
            username: "admin@contoso.example",
            homeAccountId: "home-1",
            connectedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
        activeTenantId: "tenant-1",
        runs: [
          {
            id: "run-1",
            agentSlug: "fixture",
            tenantId: "tenant-1",
            status: "completed",
            queuedAt: "2026-08-01T00:00:00.000Z",
            providerId: "ollama",
            steps: [],
            logs: [],
          },
        ],
        runDeliveryQueue: [
          {
            id: "delivery-1",
            runId: "run-1",
            connectorId: "teams",
            attempts: 0,
            createdAt: "2026-08-01T00:00:00.000Z",
            nextAttemptAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }, null, 2)}\n`,
      "utf8",
    );

    const schemaStore = new IntelligenceSqliteStore(dbPath);
    schemaStore.close();
    const db = new DatabaseSync(dbPath);
    seedTenantRows(db);
    db.close();

    const store = new AppStateStore({
      filePath: statePath,
      tokenStore,
      userDataPath: dir,
      statsApiUrl: "",
    });
    try {
      const state = await store.disconnectTenant("tenant-1");
      assert.equal(state.tenants.length, 0);
      assert.equal(state.runs.length, 0);
      assert.equal(state.activeTenantId, undefined);
      store.close();

      const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
        runDeliveryQueue?: unknown[];
      };
      assert.equal(persisted.runDeliveryQueue, undefined);

      const inspected = new DatabaseSync(dbPath, { readOnly: true });
      for (const table of [
        "graph_resources",
        "graph_cache_status",
        "drift_snapshots",
        "drift_object_versions",
        "learning_events",
        "audit_events",
        "self_training_suggestions",
        "workspaces",
        "workspace_evidence",
        "workspace_notes",
        "workspace_links",
      ]) {
        const row = inspected
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`)
          .get("tenant-1") as { count: number };
        assert.equal(row.count, 0, `${table} still contains tenant data`);
      }
      assert.equal(
        (inspected.prepare(`SELECT COUNT(*) AS count FROM chat_conversations`).get() as { count: number }).count,
        0,
      );
      assert.equal(
        (inspected.prepare(`SELECT COUNT(*) AS count FROM chat_messages`).get() as { count: number }).count,
        0,
      );
      assert.equal(
        (inspected.prepare(`SELECT COUNT(*) AS count FROM chat_tool_calls`).get() as { count: number }).count,
        0,
      );
      assert.equal(
        (inspected.prepare(`SELECT COUNT(*) AS count FROM multi_tenant_jobs`).get() as { count: number }).count,
        0,
      );
      assert.equal(
        (inspected.prepare(`SELECT COUNT(*) AS count FROM multi_tenant_agent_batches`).get() as { count: number }).count,
        0,
      );
      assert.equal(
        (inspected.prepare(`SELECT COUNT(*) AS count FROM tenant_groups`).get() as { count: number }).count,
        0,
      );
      assert.equal(
        (inspected.prepare(`SELECT COUNT(*) AS count FROM app_settings WHERE key LIKE 'graphCacheRefreshSchedule:%'`).get() as { count: number }).count,
        0,
      );
      inspected.close();
    } finally {
      try { store.close(); } catch { /* already closed */ }
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function seedTenantRows(db: DatabaseSync): void {
  const tenantId = "tenant-1";
  db.exec("BEGIN");
  db.prepare(`INSERT INTO chat_conversations (id, title, tenant_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run("chat-1", "Tenant chat", tenantId, "2026-08-01", "2026-08-01");
  db.prepare(`INSERT INTO chat_messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("message-1", "chat-1", "assistant", "Tenant answer", "completed", "2026-08-01");
  db.prepare(`INSERT INTO chat_tool_calls (id, conversation_id, message_id, type, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("tool-1", "chat-1", "message-1", "graph", "completed", "2026-08-01");
  db.prepare(`INSERT INTO graph_resources (tenant_id, resource, graph_id, snapshot_id, raw_json, search_text, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(tenantId, "users", "user-1", "snapshot-1", "{}", "user", "2026-08-01");
  db.prepare(`INSERT INTO graph_cache_status (tenant_id, resource, label, row_count, scope_set_json) VALUES (?, ?, ?, ?, ?)`)
    .run(tenantId, "users", "Users", 1, "[]");
  db.prepare(`INSERT INTO drift_snapshots (id, tenant_id, resource, captured_at, row_count, changes_added, changes_removed, changes_modified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("snapshot-1", tenantId, "users", "2026-08-01", 1, 0, 0, 0);
  db.prepare(`INSERT INTO drift_object_versions (tenant_id, resource, graph_id, version, content_hash, raw_json, first_seen_snapshot_id, first_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(tenantId, "users", "user-1", 1, "hash", "{}", "snapshot-1", "2026-08-01");
  db.prepare(`INSERT INTO learning_events (id, tenant_id, event_type, source, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("learning-1", tenantId, "fixture", "test", "{}", "2026-08-01");
  db.prepare(`INSERT INTO audit_events (id, type, tenant_id, source, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("audit-1", "fixture", tenantId, "test", "{}", "2026-08-01");
  db.prepare(`INSERT INTO self_training_suggestions (id, tenant_id, agent_slug, status, text, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("suggestion-1", tenantId, "fixture", "pending", "text", "reason", "test", "2026-08-01");
  db.prepare(`INSERT INTO tenant_groups (id, name, tenant_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run("group-1", "Group", JSON.stringify([tenantId]), "2026-08-01", "2026-08-01");
  db.prepare(`INSERT INTO multi_tenant_jobs (id, conversation_id, prompt, tenant_scope_json, resolved_tenant_ids_json, provider_id, provider_name, provider_is_local, status, preflight_json, progress_json, summary_json, comparisons_json, device_rows_json, assistant_text, export_dossier_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("job-1", "chat-1", "prompt", "{}", JSON.stringify([tenantId]), "ollama", "Ollama", 1, "completed", "{}", "{}", "{}", "[]", "[]", "tenant result", "tenant dossier", "2026-08-01", "2026-08-01");
  db.prepare(`UPDATE chat_conversations SET multi_tenant_job_id = ? WHERE id = ?`).run("job-1", "chat-1");
  db.prepare(`INSERT INTO multi_tenant_agent_batches (id, agent_slug, agent_name, agent_mode, tenant_scope_json, resolved_tenant_ids_json, status, run_ids_json, preflight_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("batch-1", "fixture", "Fixture", "read", "{}", JSON.stringify([tenantId]), "completed", "[]", "{}", "2026-08-01", "2026-08-01");
  db.prepare(`INSERT INTO workspaces (id, tenant_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("workspace-1", tenantId, "Workspace", "active", "2026-08-01", "2026-08-01");
  db.prepare(`INSERT INTO workspace_evidence (id, workspace_id, tenant_id, title, source_type, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("evidence-1", "workspace-1", tenantId, "Evidence", "manual", "{}", "2026-08-01");
  db.prepare(`INSERT INTO workspace_notes (id, workspace_id, tenant_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run("note-1", "workspace-1", tenantId, "Note", "2026-08-01", "2026-08-01");
  db.prepare(`INSERT INTO workspace_links (id, workspace_id, tenant_id, type, ref_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("link-1", "workspace-1", tenantId, "run", "run-1", "Run", "2026-08-01");
  db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`)
    .run(`graphCacheRefreshSchedule:${tenantId}`, "{}", "2026-08-01");
  db.exec("COMMIT");
}

describe("disconnect stops in-flight work first (design round review, Muse A)", () => {
  async function fixture(extra: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-disconnect-live-"));
    const statePath = join(dir, "state.json");
    const running = {
      id: "run-live", agentSlug: "fixture", tenantId: "tenant-1", status: "running",
      queuedAt: "2026-08-01T00:00:00.000Z", startedAt: "2026-08-01T00:00:01.000Z", providerId: "ollama", steps: [], logs: [],
    };
    await writeFile(statePath, `${JSON.stringify({
      activeProviderId: "ollama",
      installedAgents: [],
      tenants: [{ id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-1", connectedAt: "2026-08-01T00:00:00.000Z" }],
      activeTenantId: "tenant-1",
      runs: [running],
      gateway: { enabled: true, port: 7777, boundTenantId: "tenant-1", clients: [] },
      ...extra,
    })}\n`, "utf8");
    const store = new AppStateStore({ filePath: statePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
    return { dir, statePath, store, running };
  }

  it("cancels the tenant's running runs and waits for their work before deleting anything", async () => {
    const { dir, statePath, store } = await fixture();
    const runService = (store as unknown as { runService: { drives: Map<string, Promise<void>> } }).runService;
    let finishDrive!: () => void;
    const drive = new Promise<void>((resolve) => (finishDrive = resolve));
    runService.drives.set("run-live", drive);
    try {
      let disconnected = false;
      const pending = store.disconnectTenant("tenant-1").then(() => (disconnected = true));
      // The run is cancelled, and the disconnect waits for its drive.
      type Stored = { runs: Array<{ id: string; status: string }>; tenants: unknown[] };
      let during: Stored = JSON.parse(await readFile(statePath, "utf8")) as Stored;
      for (let attempt = 0; attempt < 200 && during.runs.find((run) => run.id === "run-live")?.status !== "cancelled"; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        during = JSON.parse(await readFile(statePath, "utf8")) as Stored;
      }
      assert.equal(during.runs.find((run) => run.id === "run-live")?.status, "cancelled");
      assert.equal(during.tenants.length, 1);
      assert.equal(disconnected, false);
      finishDrive();
      await pending;
      const after = JSON.parse(await readFile(statePath, "utf8")) as { runs: unknown[]; tenants: unknown[]; gateway?: { boundTenantId?: string } };
      assert.deepEqual(after.runs, []);
      assert.deepEqual(after.tenants, []);
      // The write gateway is no longer bound to the removed tenant.
      assert.equal(after.gateway?.boundTenantId, undefined);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a late snapshot of a deleted run and sends no report for it", async () => {
    const { dir, statePath, store, running } = await fixture();
    try {
      await store.disconnectTenant("tenant-1");
      const runService = (store as unknown as { runService: { persistRunSnapshot(run: unknown): Promise<void> } }).runService;
      await runService.persistRunSnapshot({ ...running, status: "completed", finishedAt: "2026-08-01T00:01:00.000Z" });
      const after = JSON.parse(await readFile(statePath, "utf8")) as { runs: unknown[]; runDeliveryQueue?: unknown[] };
      assert.deepEqual(after.runs, []);
      assert.equal(after.runDeliveryQueue, undefined);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an unknown tenant like rename refuses an unknown organization", async () => {
    const { dir, store } = await fixture();
    try {
      await assert.rejects(store.disconnectTenant("tenant-missing"), /no longer on this device/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("disconnect closes the door on work in flight (design round review 2)", () => {
  const tenant = { id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-1", addedAt: "2026-08-01T00:00:00.000Z" };
  const agent = {
    id: "fixture", slug: "fixture", name: "Fixture", description: "Reads devices.", mode: "read", category: "devices", tier: "agent",
    requiresEntraTier: "free", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"], author: { name: "OpenAdminOS" },
    version: "1.0.0", installedAt: "2026-08-01T00:00:00.000Z",
  };
  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    return { opened, open };
  }
  async function until(check: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for the condition.");
  }
  async function fixture(extra: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-disconnect-door-"));
    const statePath = join(dir, "state.json");
    await writeFile(statePath, `${JSON.stringify({ activeProviderId: "ollama", installedAgents: [agent], tenants: [tenant], activeTenantId: tenant.id, runs: [], ...extra })}\n`, "utf8");
    const store = new AppStateStore({ filePath: statePath, tokenStore, userDataPath: dir, statsApiUrl: "", ...options });
    // No real MSAL cache in tests: removing the sign-in succeeds.
    (store as unknown as { removeCachedAccount: () => Promise<void> }).removeCachedAccount = async () => undefined;
    return { dir, statePath, store };
  }

  it("drops the rows of an ordinary cache refresh released after Disconnect began", async () => {
    const graphGate = gate();
    let requested = false;
    const graph = {
      request: async () => {
        requested = true;
        await graphGate.opened;
        return { value: [{ id: "device-1", deviceName: "WIN-01", operatingSystem: "Windows" }] };
      },
    };
    const { dir, store } = await fixture({}, { graphFactory: () => graph });
    try {
      const refresh = store.refreshGraphCache({ tenantId: tenant.id, resources: ["managedDevices"] }).catch(() => undefined);
      await until(() => requested);
      const disconnected = store.disconnectTenant(tenant.id);
      // The door is closed before the refresh is released.
      await until(() => store.tenantClosed(tenant.id));
      graphGate.open();
      await disconnected;
      await refresh;
      const db = new DatabaseSync(join(dir, "openadminos.db"));
      const rows = db.prepare(`SELECT COUNT(*) AS count FROM graph_resources WHERE tenant_id = ?`).get(tenant.id) as { count: number };
      db.close();
      assert.equal(rows.count, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a run started while Disconnect waits for an earlier run", async () => {
    const running = { id: "run-live", agentSlug: "fixture", tenantId: tenant.id, status: "running", queuedAt: "2026-08-01T00:00:00.000Z", providerId: "ollama", steps: [], logs: [] };
    const { dir, statePath, store } = await fixture({ runs: [running] });
    const runService = (store as unknown as { runService: { drives: Map<string, Promise<void>> } }).runService;
    const driveGate = gate();
    runService.drives.set("run-live", driveGate.opened);
    try {
      const disconnected = store.disconnectTenant(tenant.id);
      await until(() => store.tenantClosed(tenant.id));
      await assert.rejects(store.startRun("fixture", { tenantId: tenant.id }), /being disconnected/);
      driveGate.open();
      await disconnected;
      const after = JSON.parse(await readFile(statePath, "utf8")) as { runs: unknown[] };
      assert.deepEqual(after.runs, []);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never posts a claimed report whose secret lookup resolves after Disconnect began", async () => {
    const secretGate = gate();
    let lookedUp = false;
    const posts: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      posts.push(String(input));
      return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const completed = { id: "run-done", agentSlug: "fixture", tenantId: tenant.id, status: "completed", queuedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z", trigger: "manual", summary: "Done.", steps: [], logs: [] };
    const { dir, store } = await fixture(
      {
        installedAgents: [{ ...agent, delivery: { slack: { enabled: true } } }],
        runs: [completed],
        connectors: { slack: { config: { defaultChannel: "C1" } } },
        runDeliveryQueue: [{ id: "run-done:slack", runId: "run-done", connectorId: "slack", attempts: 0, createdAt: "2026-08-01T00:00:00.000Z", nextAttemptAt: "2026-08-01T00:00:00.000Z" }],
      },
      {
        connectorSecretsFor: () => ({
          get: async () => {
            lookedUp = true;
            await secretGate.opened;
            return "xoxb-test";
          },
          set: async () => undefined,
          remove: async () => undefined,
        }),
      },
    );
    try {
      const delivering = store.processPendingRunDeliveries();
      await until(() => lookedUp);
      const disconnected = store.disconnectTenant(tenant.id);
      await until(() => store.tenantClosed(tenant.id));
      secretGate.open();
      await disconnected;
      await delivering;
      // Local provider probes may run; nothing reached Slack.
      assert.deepEqual(posts.filter((url) => url.includes("slack.com")), []);
    } finally {
      globalThis.fetch = originalFetch;
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves everything in place and says so when the sign-in cannot be removed (item 7)", async () => {
    const { dir, statePath, store } = await fixture({});
    const office = (store as unknown as { officeService: { purgeTenant: (id: string) => Promise<void> } }).officeService;
    let purged = false;
    office.purgeTenant = async () => {
      purged = true;
    };
    (store as unknown as { removeCachedAccount: () => Promise<void> }).removeCachedAccount = async () => {
      throw new Error("Secure storage is not available.");
    };
    try {
      await assert.rejects(store.disconnectTenant(tenant.id), /nothing was deleted and the organization is still connected/);
      assert.equal(purged, false);
      assert.equal(store.tenantClosed(tenant.id), false);
      const after = JSON.parse(await readFile(statePath, "utf8")) as { tenants: unknown[] };
      assert.equal(after.tenants.length, 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("finishes the disconnect and reports partial completion when Agent Team data cannot be deleted (item 7)", async () => {
    const { dir, statePath, store } = await fixture({});
    const office = (store as unknown as { officeService: { purgeTenant: (id: string) => Promise<void> } }).officeService;
    office.purgeTenant = async () => {
      throw new Error("The Agent Team database is locked.");
    };
    try {
      await assert.rejects(store.disconnectTenant(tenant.id), /was disconnected and its local data deleted, but its Agent Team data could not be deleted: The Agent Team database is locked\./);
      const after = JSON.parse(await readFile(statePath, "utf8")) as { tenants: unknown[] };
      assert.equal(after.tenants.length, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes a multi-tenant job that includes the tenant whole, with the other organization's results (item 5)", async () => {
    const { dir, store } = await fixture({});
    const schemaStore = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
    schemaStore.close();
    const db = new DatabaseSync(join(dir, "openadminos.db"));
    db.prepare(`INSERT INTO multi_tenant_jobs (id, conversation_id, prompt, tenant_scope_json, resolved_tenant_ids_json, provider_id, provider_name, provider_is_local, status, preflight_json, progress_json, summary_json, comparisons_json, device_rows_json, assistant_text, export_dossier_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("job-two", null, "prompt", "{}", JSON.stringify([tenant.id, "tenant-2"]), "ollama", "Ollama", 1, "completed", "{}", "{}", "{}", "[]", "[]", "both results", "both dossier", "2026-08-01", "2026-08-01");
    db.close();
    try {
      await store.disconnectTenant(tenant.id);
      const inspected = new DatabaseSync(join(dir, "openadminos.db"));
      const jobs = inspected.prepare(`SELECT COUNT(*) AS count FROM multi_tenant_jobs`).get() as { count: number };
      inspected.close();
      assert.equal(jobs.count, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
