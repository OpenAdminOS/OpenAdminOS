import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";

import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import { prepareNovaAction, type NovaActionHost } from "./nova-actions.js";
import { AppStateStore } from "./state.js";
import { TenantClosedError } from "./tenant-lifecycle.js";

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
      // The append-only audit log outlives the disconnect, including the
      // removed run and the disconnect itself.
      const audited = inspected
        .prepare(`SELECT type FROM audit_log WHERE tenant_id = ? ORDER BY seq`)
        .all("tenant-1") as Array<{ type: string }>;
      assert.ok(audited.some((row) => row.type === "run.queued"));
      assert.ok(audited.some((row) => row.type === "microsoft365.disconnected"));
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

const tenant = { id: "tenant-1", displayName: "Contoso", username: "admin@contoso.example", homeAccountId: "home-1", addedAt: "2026-08-01T00:00:00.000Z" };
const otherTenant = { id: "tenant-2", displayName: "Fabrikam", username: "admin@fabrikam.example", homeAccountId: "home-2", addedAt: "2026-08-01T00:00:00.000Z" };
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

type StoredState = {
  tenants: Array<{ id: string }>;
  runs: Array<{ id: string; status: string }>;
  runDeliveryQueue?: unknown[];
  activeTenantId?: string;
  gateway?: { boundTenantId?: string };
  tenantRemovals?: Array<{ tenantId: string; error?: string }>;
  novaConnectorAudit?: Array<{ tenantId: string }>;
};

async function stored(statePath: string): Promise<StoredState> {
  return JSON.parse(await readFile(statePath, "utf8")) as StoredState;
}

function count(dir: string, sql: string, ...params: string[]): number {
  const db = new DatabaseSync(join(dir, "openadminos.db"));
  try {
    return (db.prepare(sql).get(...params) as { count: number }).count;
  } finally {
    db.close();
  }
}

async function fixture(extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-disconnect-"));
  const statePath = join(dir, "state.json");
  await writeFile(statePath, `${JSON.stringify({ activeProviderId: "ollama", installedAgents: [agent], tenants: [tenant], activeTenantId: tenant.id, runs: [], ...extra })}\n`, "utf8");
  const store = new AppStateStore({ filePath: statePath, tokenStore, userDataPath: dir, statsApiUrl: "", ...options });
  // No real MSAL cache in tests: removing the sign-in succeeds and is counted.
  const signIn = { removed: 0 };
  (store as unknown as { removeCachedAccount: () => Promise<void> }).removeCachedAccount = async () => {
    signIn.removed += 1;
  };
  return {
    dir, statePath, store, signIn,
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

/** Hold the tenant's cleanup in its drain until `release`, by keeping one leased piece of work open. */
function holdCleanup(store: AppStateStore) {
  const held = gate();
  let aborted = false;
  const work = store.withTenantLease(tenant.id, async (signal) => {
    signal.addEventListener("abort", () => (aborted = true));
    await held.opened;
  });
  return { work, release: held.open, aborted: () => aborted };
}

describe("Disconnect redesign: two phases with a removal record", () => {
  it("removes the organization at once, fires the lease signal, and drains leased work before removing the sign-in", async () => {
    const running = { id: "run-live", agentSlug: "fixture", tenantId: tenant.id, status: "running", queuedAt: "2026-08-01T00:00:00.000Z", providerId: "ollama", steps: [], logs: [] };
    const f = await fixture({ runs: [running], gateway: { enabled: true, port: 7777, boundTenantId: tenant.id, clients: [] } });
    try {
      const hold = holdCleanup(f.store);
      const disconnected = f.store.disconnectTenant(tenant.id);
      await until(async () => (await stored(f.statePath)).tenants.length === 0);
      // Phase 1: gone at once, with a removal record, and closed.
      const during = await stored(f.statePath);
      assert.deepEqual(during.runs, []);
      assert.equal(during.activeTenantId, undefined);
      assert.equal(during.gateway?.boundTenantId, undefined);
      assert.deepEqual(during.tenantRemovals?.map((removal) => removal.tenantId), [tenant.id]);
      assert.equal(f.store.tenantPhase(tenant.id), "closing");
      assert.equal(hold.aborted(), true);
      // Phase 2 waits for the leased work before removing the sign-in.
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(f.signIn.removed, 0);
      hold.release();
      await hold.work;
      const state = await disconnected;
      assert.equal(f.signIn.removed, 1);
      assert.equal((await stored(f.statePath)).tenantRemovals, undefined);
      assert.equal(state.tenantCleanups, undefined);
      assert.equal(f.store.tenantPhase(tenant.id), "removed");
    } finally {
      await f.close();
    }
  });

  it("drops a late snapshot of a deleted run and sends no report for it", async () => {
    const running = { id: "run-live", agentSlug: "fixture", tenantId: tenant.id, status: "running", queuedAt: "2026-08-01T00:00:00.000Z", providerId: "ollama", steps: [], logs: [] };
    const f = await fixture({ runs: [running] });
    try {
      await f.store.disconnectTenant(tenant.id);
      const runService = (f.store as unknown as { runService: { persistRunSnapshot(run: unknown): Promise<void> } }).runService;
      await runService.persistRunSnapshot({ ...running, status: "completed", finishedAt: "2026-08-01T00:01:00.000Z" });
      const after = await stored(f.statePath);
      assert.deepEqual(after.runs, []);
      assert.equal(after.runDeliveryQueue, undefined);
    } finally {
      await f.close();
    }
  });

  it("refuses an unknown tenant like rename refuses an unknown organization", async () => {
    const f = await fixture();
    try {
      await assert.rejects(f.store.disconnectTenant("tenant-missing"), /no longer on this device/);
    } finally {
      await f.close();
    }
  });

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
    const f = await fixture({}, { graphFactory: () => graph });
    try {
      const refresh = f.store.refreshGraphCache({ tenantId: tenant.id, resources: ["managedDevices"] }).catch((error: unknown) => error);
      await until(() => requested);
      const disconnected = f.store.disconnectTenant(tenant.id);
      await until(() => f.store.tenantPhase(tenant.id) === "closing");
      graphGate.open();
      await disconnected;
      assert.match(String(await refresh), /being disconnected/);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM graph_resources WHERE tenant_id = ?", tenant.id), 0);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM app_settings WHERE key LIKE ?", `%${tenant.id}%`), 0);
    } finally {
      await f.close();
    }
  });

  it("refuses a run started while cleanup drains, and writes nothing for it", async () => {
    const f = await fixture();
    try {
      const hold = holdCleanup(f.store);
      const disconnected = f.store.disconnectTenant(tenant.id);
      await until(() => f.store.tenantPhase(tenant.id) === "closing");
      await assert.rejects(f.store.startRun("fixture", { tenantId: tenant.id }));
      hold.release();
      await disconnected;
      assert.deepEqual((await stored(f.statePath)).runs, []);
    } finally {
      await f.close();
    }
  });

  it("never posts a claimed Slack report whose secret lookup resolves after Disconnect began", async () => {
    const secretGate = gate();
    let lookedUp = false;
    const posts: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      posts.push(String(input));
      return new Response(JSON.stringify({ ok: true, channel: "C1", ts: "1.2" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const completed = { id: "run-done", agentSlug: "fixture", tenantId: tenant.id, status: "completed", queuedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z", trigger: "manual", summary: "Done.", steps: [], logs: [] };
    const f = await fixture(
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
      const delivering = f.store.processPendingRunDeliveries();
      await until(() => lookedUp);
      const disconnected = f.store.disconnectTenant(tenant.id);
      await until(() => f.store.tenantPhase(tenant.id) === "closing");
      secretGate.open();
      await disconnected;
      await delivering;
      assert.deepEqual(posts.filter((url) => url.includes("slack.com")), []);
    } finally {
      globalThis.fetch = originalFetch;
      await f.close();
    }
  });

  it("deletes a multi-tenant job that includes the tenant whole, with the other organization's results (item 5)", async () => {
    const f = await fixture();
    const schemaStore = new IntelligenceSqliteStore(join(f.dir, "openadminos.db"));
    schemaStore.close();
    const db = new DatabaseSync(join(f.dir, "openadminos.db"));
    db.prepare(`INSERT INTO multi_tenant_jobs (id, conversation_id, prompt, tenant_scope_json, resolved_tenant_ids_json, provider_id, provider_name, provider_is_local, status, preflight_json, progress_json, summary_json, comparisons_json, device_rows_json, assistant_text, export_dossier_markdown, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("job-two", null, "prompt", "{}", JSON.stringify([tenant.id, "tenant-2"]), "ollama", "Ollama", 1, "completed", "{}", "{}", "{}", "[]", "[]", "both results", "both dossier", "2026-08-01", "2026-08-01");
    db.close();
    try {
      await f.store.disconnectTenant(tenant.id);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM multi_tenant_jobs"), 0);
    } finally {
      await f.close();
    }
  });
});

/** A fake MSAL client for the tenant fixture. `gate` holds every token until it opens. */
function fakeMsalClient(options: { gate?: Promise<void>; onAcquire?: () => void } = {}) {
  const account = { homeAccountId: tenant.homeAccountId, tenantId: tenant.id, username: tenant.username, environment: "login.microsoftonline.com", localAccountId: "local" };
  return {
    getTokenCache: () => ({ getAllAccounts: async () => [account] }),
    acquireTokenSilent: async (request: { scopes: string[] }) => {
      options.onAcquire?.();
      await options.gate;
      return { accessToken: "token", scopes: request.scopes, account, tenantId: tenant.id };
    },
  };
}

function recordFetch() {
  const requests: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input instanceof Request ? input.url : input));
    return new Response(JSON.stringify({ ok: true, value: [], channel: "C1", ts: "1.2", id: "m1" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = original; } };
}

describe("Disconnect redesign: GPT-6.1-Sol reproductions", () => {
  it("1. a multi-tenant Chat job waiting for its model answer never recreates its job or conversation", async () => {
    const llmGate = gate();
    let asked = false;
    const f = await fixture(
      { tenants: [tenant, otherTenant], activeModelByProviderId: { ollama: "mock-chat" } },
      {
        graphFactory: ({ tenantId }: { tenantId: string }) => ({
          async listManagedDevices() { return []; },
          async retireManagedDevice() { throw new Error("No writes."); },
          async request() {
            return { value: [{ id: `${tenantId}-pc`, deviceName: `${tenantId}-PC`, operatingSystem: "Windows", complianceState: "compliant", lastSyncDateTime: new Date().toISOString() }] };
          },
        }),
        llmFactory: () => ({
          available: true,
          defaultModel: "mock-chat",
          async complete() {
            asked = true;
            await llmGate.opened;
            return { text: "Summary of both organizations.", model: "mock-chat" };
          },
          async *stream() { yield { delta: "", accumulated: "", done: true, model: "mock-chat" }; },
        }),
      },
    );
    f.store.listProviders = async () => [
      { id: "ollama", name: "Ollama", description: "Local", isLocal: true, status: "connected", models: ["mock-chat"], defaultModel: "mock-chat" },
    ];
    try {
      const job = f.store.runMultiTenantIntuneChat({ prompt: "Compare Windows compliance across tenants", tenantScope: { kind: "all" } }).catch((error: unknown) => error);
      await until(() => asked);
      const disconnected = f.store.disconnectTenant(tenant.id);
      await until(() => f.store.tenantPhase(tenant.id) === "closing");
      llmGate.open();
      const outcome = await job;
      assert.ok(outcome instanceof TenantClosedError, String(outcome));
      await disconnected;
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM multi_tenant_jobs"), 0);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM chat_conversations"), 0);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM chat_messages"), 0);
    } finally {
      await f.close();
    }
  });

  it("2. a Teams report whose token is released after Disconnect began never reaches Graph", async () => {
    const tokenGate = gate();
    let asked = false;
    const network = recordFetch();
    const completed = { id: "run-done", agentSlug: "fixture", tenantId: tenant.id, status: "completed", queuedAt: "2026-08-01T00:00:00.000Z", finishedAt: "2026-08-01T00:01:00.000Z", trigger: "manual", summary: "Done.", steps: [], logs: [] };
    const f = await fixture({
      installedAgents: [{ ...agent, delivery: { teams: { enabled: true, useDefaultTarget: true } } }],
      runs: [completed],
      connectors: { teams: { config: { defaultTeamId: "team-1", defaultChannelId: "channel-1" } } },
      runDeliveryQueue: [{ id: "run-done:teams", runId: "run-done", connectorId: "teams", attempts: 0, createdAt: "2026-08-01T00:00:00.000Z", nextAttemptAt: "2026-08-01T00:00:00.000Z" }],
    });
    (f.store as unknown as { msalClientFor: () => unknown }).msalClientFor = () =>
      fakeMsalClient({ gate: tokenGate.opened, onAcquire: () => (asked = true) });
    try {
      const delivering = f.store.processPendingRunDeliveries();
      await until(() => asked);
      const disconnected = f.store.disconnectTenant(tenant.id);
      await until(() => f.store.tenantPhase(tenant.id) === "closing");
      tokenGate.open();
      await disconnected;
      await delivering;
      assert.deepEqual(network.requests.filter((url) => url.includes("graph.microsoft.com")), []);
    } finally {
      network.restore();
      await f.close();
    }
  });

  it("3. a multi-part Nova Slack send interrupted by Disconnect stops after the accepted part, is drained, and writes no audit for the removed tenant", async () => {
    const network = recordFetch();
    const secretGate = gate();
    let lookups = 0;
    const config = { defaultChannel: "C1" };
    const f = await fixture(
      { connectors: { slack: { config } } },
      {
        connectorSecretsFor: () => ({
          get: async () => {
            lookups += 1;
            if (lookups > 1) await secretGate.opened;
            return "xoxb-test";
          },
          set: async () => undefined,
          remove: async () => undefined,
        }),
      },
    );
    try {
      const state = await f.store.getAppState();
      const host: NovaActionHost = {
        activeTenantId: () => f.store.activeTenantId(),
        connectors: async () => [{ descriptor: { id: "slack", name: "Slack" }, status: "connected", config }] as never,
        send: (input) => f.store.sendNovaConnector(input),
        startRun: (slug, options) => f.store.startRun(slug, options),
        tenantLease: (tenantId, work) => f.store.withTenantLease(tenantId, work),
      };
      const action = await prepareNovaAction("send this via Slack", "x".repeat(40_000), state, host);
      assert.ok(action);
      const executing = action.execute(new AbortController().signal).catch((error: unknown) => error);
      await until(async () => lookups === 2 && ((await stored(f.statePath)).novaConnectorAudit?.length ?? 0) > 0);
      const auditBefore = (await stored(f.statePath)).novaConnectorAudit?.length ?? 0;
      let drained = false;
      const disconnected = f.store.disconnectTenant(tenant.id).then(() => (drained = true));
      await until(() => f.store.tenantPhase(tenant.id) === "closing");
      assert.equal(drained, false);
      secretGate.open();
      assert.match(String(await executing), /1 of 2 messages confirmed accepted by Slack/);
      await disconnected;
      assert.equal(network.requests.filter((url) => url.includes("slack.com")).length, 1);
      assert.equal((await stored(f.statePath)).novaConnectorAudit?.length ?? 0, auditBefore);
    } finally {
      network.restore();
      await f.close();
    }
  });

  it("4. a gateway read whose token is released after Disconnect began sends no /users request", async () => {
    const tokenGate = gate();
    let asked = false;
    const network = recordFetch();
    const f = await fixture();
    (f.store as unknown as { msalClientFor: () => unknown }).msalClientFor = () =>
      fakeMsalClient({ gate: tokenGate.opened, onAcquire: () => (asked = true) });
    const chat = (f.store as unknown as { chatService: { executeReadTool(tenantId: string, name: string, params: Record<string, unknown>): Promise<unknown> } }).chatService;
    try {
      const reading = chat.executeReadTool(tenant.id, "graph_get", { path: "/users" }).catch((error: unknown) => error);
      await until(() => asked);
      const disconnected = f.store.disconnectTenant(tenant.id);
      await until(() => f.store.tenantPhase(tenant.id) === "closing");
      tokenGate.open();
      await reading;
      await disconnected;
      assert.deepEqual(network.requests.filter((url) => url.includes("graph.microsoft.com")), []);
      // A new gateway read for the removed organization is refused too.
      await assert.rejects(chat.executeReadTool(tenant.id, "graph_get", { path: "/users" }));
      assert.deepEqual(network.requests.filter((url) => url.includes("graph.microsoft.com")), []);
    } finally {
      network.restore();
      await f.close();
    }
  });

  it("5. a failure after the sign-in was removed leaves a pending cleanup that blocks reconnecting until Retry cleanup finishes", async () => {
    const network = recordFetch();
    const f = await fixture({}, {
      interactiveSignIn: async ({ scopes }: { scopes?: string[] }) => ({
        account: { homeAccountId: tenant.homeAccountId, tenantId: tenant.id, username: tenant.username },
        scopes: scopes ?? [],
        accessToken: "token",
      }),
    });
    const intelligence = (f.store as unknown as { intelligenceStore: { purgeTenant(id: string): void } }).intelligenceStore;
    const purge = intelligence.purgeTenant.bind(intelligence);
    intelligence.purgeTenant = () => {
      throw new Error("The database is locked.");
    };
    try {
      // The outcome is truthful: removed, with cleanup pending and why.
      const state = await f.store.disconnectTenant(tenant.id);
      assert.equal(f.signIn.removed, 1);
      assert.deepEqual(state.tenants, []);
      assert.equal(state.activeTenantId, undefined);
      assert.deepEqual(state.tenantCleanups?.map((cleanup) => [cleanup.tenantId, cleanup.error]), [
        [tenant.id, "Its Chat and cache data could not be deleted. The database is locked."],
      ]);
      assert.equal(f.store.tenantPhase(tenant.id), "closing");
      // Reconnecting the same tenant shows the designed message.
      await assert.rejects(f.store.connectTenant(), /Disconnecting Contoso has not finished on this device: Its Chat and cache data could not be deleted\. The database is locked\. Retry cleanup on Connections, then connect again\./);
      assert.deepEqual((await stored(f.statePath)).tenants, []);
      // Retry cleanup finishes it; then the tenant connects with a new generation.
      intelligence.purgeTenant = purge;
      const retried = await f.store.retryTenantCleanup(tenant.id);
      assert.equal(retried.tenantCleanups, undefined);
      assert.equal(f.store.tenantPhase(tenant.id), "removed");
      const connected = await f.store.connectTenant();
      assert.deepEqual(connected.tenants.map((entry) => entry.id), [tenant.id]);
      assert.equal(f.store.tenantPhase(tenant.id), "open");
    } finally {
      network.restore();
      await f.close();
    }
  });
});

describe("Disconnect redesign: choke points, restart and agent batches", () => {
  it("with a closed lease, no egress or persistence choke point sends or writes anything", async () => {
    const network = recordFetch();
    let tokens = 0;
    const f = await fixture({ connectors: { slack: { config: { defaultChannel: "C1" } } } }, {
      connectorSecretsFor: () => ({ get: async () => "xoxb-test", set: async () => undefined, remove: async () => undefined }),
    });
    (f.store as unknown as { msalClientFor: () => unknown }).msalClientFor = () => fakeMsalClient({ onAcquire: () => (tokens += 1) });
    const internals = f.store as unknown as {
      tenantLifecycle: { close(id: string): void };
      buildGraph(tenantId: string, scopes: string[]): Promise<{ createGraph(log: () => void): { request(input: { method: string; path: string }): Promise<unknown> } }>;
      msalClientForTenant(record: unknown): { acquireTokenSilent(request: unknown): Promise<unknown> };
      createTenantSessionForRecord(record: unknown): { acquireTokenForScopes(scopes: string[]): Promise<string> };
      connectorTransport(tenantId: string): { fetch: typeof fetch; assertEgress(): void };
      intelligenceStore: IntelligenceSqliteStore;
      write(state: unknown): Promise<void>;
      read(): Promise<{ runs: unknown[] }>;
      chatService: {
        executeReadTool(tenantId: string, name: string, params: Record<string, unknown>): Promise<unknown>;
        queueMultiTenantAgentBatch(input: unknown): Promise<unknown>;
      };
    };
    const record = (await f.store.getAppState()).tenants[0]!;
    // A conversation written while the tenant was open.
    internals.intelligenceStore.createConversation({ id: "chat-open", title: "Before", tenantId: tenant.id, now: "2026-08-01" });
    internals.tenantLifecycle.close(tenant.id);
    try {
      // Egress: Graph client factory, MSAL wrapper, tenant session, connector transport.
      const graph = await internals.buildGraph(tenant.id, []);
      await assert.rejects(graph.createGraph(() => undefined).request({ method: "GET", path: "/users" }), TenantClosedError);
      await assert.rejects(internals.msalClientForTenant(record).acquireTokenSilent({ scopes: ["User.Read"] }), TenantClosedError);
      await assert.rejects(internals.createTenantSessionForRecord(record).acquireTokenForScopes(["User.Read"]), TenantClosedError);
      const transport = internals.connectorTransport(tenant.id);
      await assert.rejects(transport.fetch("https://slack.com/api/chat.postMessage"), TenantClosedError);
      assert.throws(() => transport.assertEgress(), TenantClosedError);
      await assert.rejects(f.store.sendNovaConnector({ connectorId: "slack", config: { defaultChannel: "C1" }, method: "sendMessage", args: { channel: "C1", text: "x" }, tenantId: tenant.id, actionId: "a1", signal: new AbortController().signal }));
      // Local provider probes may run; nothing left for a service.
      assert.deepEqual(network.requests.filter((url) => !url.startsWith("http://127.0.0.1")), []);
      assert.equal(tokens, 0);
      // Entry points: runs, Chat sends, gateway reads, cache refresh, Nova, Agent Team.
      await assert.rejects(f.store.startRun("fixture", { tenantId: tenant.id }));
      await assert.rejects(f.store.sendIntuneChatMessage({ content: "How many devices?" }), TenantClosedError);
      await assert.rejects(internals.chatService.executeReadTool(tenant.id, "query_cache", { resource: "managedDevices" }), TenantClosedError);
      await assert.rejects(f.store.refreshGraphCache({ tenantId: tenant.id, resources: ["managedDevices"] }), TenantClosedError);
      await assert.rejects(f.store.withTenantLease(tenant.id, async () => "nova action"), TenantClosedError);
      await assert.rejects(f.store.saveOfficePersona({ tenantId: tenant.id }), TenantClosedError);
      // Persistence: every tenant-scoped SQLite write is refused and nothing lands.
      const sqlite = internals.intelligenceStore;
      const writes: Array<[string, () => unknown]> = [
        ["createConversation", () => sqlite.createConversation({ id: "chat-late", title: "Late", tenantId: tenant.id, now: "2026-08-02" })],
        ["insertMessage", () => sqlite.insertMessage({ id: "msg-late", conversationId: "chat-open", role: "user", content: "late", status: "completed", createdAt: "2026-08-02" })],
        ["touchConversation", () => sqlite.touchConversation("chat-open", "Renamed", "2026-08-02")],
        ["replaceGraphResources", () => sqlite.replaceGraphResources({ tenantId: tenant.id } as never)],
        ["recordGraphResourceError", () => sqlite.recordGraphResourceError({ tenantId: tenant.id } as never)],
        ["markGraphResourcesStale", () => sqlite.markGraphResourcesStale(tenant.id, ["managedDevices"])],
        ["upsertMultiTenantJob", () => sqlite.upsertMultiTenantJob({ resolvedTenantIds: [tenant.id] } as never)],
        ["upsertMultiTenantAgentBatch", () => sqlite.upsertMultiTenantAgentBatch({ resolvedTenantIds: [tenant.id] } as never)],
        ["setGraphCacheRefreshSchedule", () => sqlite.setGraphCacheRefreshSchedule({ tenantId: tenant.id } as never)],
        ["markGraphCacheRefreshScheduleRun", () => sqlite.markGraphCacheRefreshScheduleRun({ tenantId: tenant.id } as never)],
        ["recordLearningEvent", () => sqlite.recordLearningEvent({ tenantId: tenant.id } as never)],
        ["createWorkspace", () => sqlite.createWorkspace({ tenantId: tenant.id } as never)],
        ["createDriftBaseline", () => sqlite.createDriftBaseline({ tenantId: tenant.id } as never)],
      ];
      for (const [name, write] of writes) assert.throws(write, TenantClosedError, name);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM chat_messages"), 0);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM chat_conversations WHERE id = ?", "chat-late"), 0);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM chat_conversations WHERE title = ?", "Before"), 1);
      // state.json: a run of the closing tenant is not written.
      const persisted = await internals.read();
      await internals.write({ ...persisted, runs: [{ id: "run-late", agentSlug: "fixture", tenantId: tenant.id, status: "completed", queuedAt: "2026-08-02", steps: [], logs: [] }] });
      assert.deepEqual((await stored(f.statePath)).runs, []);
    } finally {
      network.restore();
      await f.close();
    }
  });

  it("refuses a Chat model request for a closing organization and aborts one in flight (model egress choke point)", async () => {
    const calls: Array<AbortSignal | undefined> = [];
    const f = await fixture({ tenants: [tenant, otherTenant] }, {
      llmFactory: () => ({
        available: true,
        defaultModel: "mock-chat",
        async complete(options: { signal?: AbortSignal }) {
          calls.push(options.signal);
          return { text: "ok", model: "mock-chat" };
        },
        async *stream() { yield { delta: "", accumulated: "", done: true, model: "mock-chat" }; },
      }),
    });
    const internals = f.store as unknown as {
      tenantLifecycle: { close(id: string): void };
      chatService: { tenantLlm(providerId: string, model: string, tenantIds: string[]): Promise<{ complete(options: Record<string, unknown>): Promise<unknown> }> };
    };
    try {
      const both = await internals.chatService.tenantLlm("ollama", "mock-chat", [tenant.id, otherTenant.id]);
      await both.complete({ prompt: "summary" });
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.aborted, false);
      internals.tenantLifecycle.close(tenant.id);
      // The signal handed to the request in flight fired with the close.
      assert.equal(calls[0]?.aborted, true);
      await assert.rejects(both.complete({ prompt: "again" }), TenantClosedError);
      assert.equal(calls.length, 1);
      // A model request for the other, open organization is unaffected.
      const other = await internals.chatService.tenantLlm("ollama", "mock-chat", [otherTenant.id]);
      await other.complete({ prompt: "fine" });
      assert.equal(calls.length, 2);
    } finally {
      await f.close();
    }
  });

  it("refuses a multi-tenant agent batch that includes a closing organization and writes no batch", async () => {
    const f = await fixture({ tenants: [tenant, otherTenant] }, { appVersion: "0.8.0" });
    const internals = f.store as unknown as { tenantLifecycle: { close(id: string): void } };
    try {
      internals.tenantLifecycle.close(tenant.id);
      await assert.rejects(f.store.queueMultiTenantAgentBatch({ agentSlug: "fixture", tenantScope: { kind: "all" } }), TenantClosedError);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM multi_tenant_agent_batches"), 0);
      assert.deepEqual((await stored(f.statePath)).runs, []);
    } finally {
      await f.close();
    }
  });

  it("does not refresh or mark the refresh schedule of a closing organization (Muse nit)", async () => {
    let requested = false;
    const f = await fixture({}, { graphFactory: () => ({ request: async () => { requested = true; return { value: [] }; } }) });
    const internals = f.store as unknown as {
      tenantLifecycle: { close(id: string): void };
      intelligenceStore: IntelligenceSqliteStore;
      chatService: { refreshDueGraphCaches(): Promise<void> };
    };
    try {
      internals.intelligenceStore.setGraphCacheRefreshSchedule({ tenantId: tenant.id, enabled: true, intervalMinutes: 60, now: "2020-01-01T00:00:00.000Z" });
      const before = count(f.dir, "SELECT COUNT(*) AS count FROM app_settings WHERE key LIKE ? AND value LIKE ?", `%${tenant.id}%`, "%lastRunAt%");
      internals.tenantLifecycle.close(tenant.id);
      await internals.chatService.refreshDueGraphCaches();
      assert.equal(requested, false);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM app_settings WHERE key LIKE ? AND value LIKE ?", `%${tenant.id}%`, "%lastRunAt%"), before);
    } finally {
      await f.close();
    }
  });

  it("resumes a pending cleanup at the next launch, keeping the organization closed until then", async () => {
    const f = await fixture({
      tenants: [],
      activeTenantId: undefined,
      tenantRemovals: [{ tenantId: tenant.id, displayName: "Contoso", homeAccountId: tenant.homeAccountId, removedAt: "2026-08-01T00:00:00.000Z", error: "The app quit." }],
    });
    try {
      const seeded = new DatabaseSync(join(f.dir, "openadminos.db"));
      seedTenantRows(seeded);
      seeded.close();
      // Launch: the record keeps the tenant closed before any work starts.
      const state = await f.store.getAppState();
      assert.deepEqual(state.tenantCleanups?.map((cleanup) => cleanup.tenantId), [tenant.id]);
      assert.equal(f.store.tenantPhase(tenant.id), "closing");
      await assert.rejects(f.store.withTenantLease(tenant.id, async () => undefined), TenantClosedError);
      await f.store.resumeTenantCleanups();
      assert.equal(f.signIn.removed, 1);
      assert.equal((await stored(f.statePath)).tenantRemovals, undefined);
      assert.equal(f.store.tenantPhase(tenant.id), "removed");
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM graph_resources WHERE tenant_id = ?", tenant.id), 0);
      assert.equal(count(f.dir, "SELECT COUNT(*) AS count FROM chat_conversations WHERE tenant_id = ?", tenant.id), 0);
    } finally {
      await f.close();
    }
  });
});
