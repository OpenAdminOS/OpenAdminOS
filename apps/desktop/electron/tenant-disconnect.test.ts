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
