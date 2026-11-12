import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { providerCatalog, type ManagedPolicyStatus } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { loadManagedPolicy } from "./managed-policy.js";
import { MCP_CATALOG } from "./mcp/catalog.js";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };
const MACHINE = "/etc/openadminos/policy.json";

async function policyOf(machine: unknown): Promise<ManagedPolicyStatus | undefined> {
  return loadManagedPolicy({
    providerIds: providerCatalog.map((provider) => provider.id),
    publicReferenceIds: MCP_CATALOG.map((entry) => entry.id),
    paths: [{ scope: "machine", path: MACHINE }],
    read: async (path) => {
      if (path !== MACHINE) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return new TextEncoder().encode(JSON.stringify(machine));
    },
  });
}

const contoso = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-contoso",
  addedAt: "2026-09-01T08:00:00.000Z",
};

async function makeStore(options: { policy?: ManagedPolicyStatus; clock?: () => Date } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-nova-records-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      activeProviderId: "ollama",
      providerChosenByUser: true,
      installedAgents: [],
      runs: [],
      tenants: [contoso],
      activeTenantId: contoso.id,
      organizations: [{ id: "org-contoso", name: "Contoso", createdAt: "2026-09-01T08:00:00.000Z", connections: { microsoft365: { tenantId: contoso.id } } }],
      activeOrganizationId: "org-contoso",
      novaProfile: { addenda: { "org-contoso": "Contoso uses German device names." } },
    }),
    "utf8",
  );
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    tokenStoreFor: () => tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
    appVersion: "0.8.0",
    ...(options.policy ? { managedPolicy: options.policy } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  return { store, dir, statePath, dbPath: join(dir, "openadminos.db") };
}

describe("Nova notes and follow-ups in the store", () => {
  it("lists, confirms, edits and forgets the active organization's notes", async () => {
    const { store, dir } = await makeStore();
    try {
      const notes = store.novaNotesHost();
      const note = await notes.propose({ tenantId: contoso.id, text: "Kiosks are in Berlin", source: "user-said" });
      assert.equal(note.organizationId, "org-contoso");
      assert.deepEqual(await notes.promptNotes(contoso.id), []);
      let view = await store.handleNovaRecords({ action: "note-confirm", id: note.id });
      assert.equal(view.notes[0]?.reviewState, "confirmed");
      assert.deepEqual(await notes.promptNotes(contoso.id), ["Kiosks are in Berlin"]);
      view = await store.handleNovaRecords({ action: "note-edit", id: note.id, text: "Kiosks are in Berlin and Munich" });
      assert.equal(view.notes[0]?.reviewState, "edited");
      await assert.rejects(store.handleNovaRecords({ action: "note-edit", id: note.id, text: "x".repeat(301) }), /at most 300 characters/);
      await assert.rejects(store.handleNovaRecords({ action: "note-forget", id: "note_missing" }), /another organization or is gone/);
      view = await store.handleNovaRecords({ action: "note-forget", id: note.id });
      assert.deepEqual(view.notes, []);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives no notes to a prompt when the IT policy turns notes off", async () => {
    const { store, dir } = await makeStore({ policy: await policyOf({ novaMemory: "off" }) });
    try {
      const notes = store.novaNotesHost();
      const note = await notes.propose({ tenantId: contoso.id, text: "Kept but unused", source: "user-said" });
      await notes.confirm(note.id);
      assert.deepEqual(await notes.promptNotes(contoso.id), []);
      assert.equal((await store.handleNovaRecords({ action: "list" })).notes.length, 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks a late follow-up missed, cancels a pending one, and refuses one for another provider", async () => {
    let now = new Date("2026-11-12T10:00:00.000Z");
    const { store, dir } = await makeStore({ clock: () => now });
    try {
      const host = store.novaFollowUpsHost();
      const state = await store.getAppState();
      const providerId = state.activeProviderId;
      const model = state.providers.find((entry) => entry.id === providerId)?.models?.[0];
      const cancelled = await host.create({ tenantId: contoso.id, question: "Check compliance", providerId, ...(model ? { model } : {}), delayMinutes: 5 });
      assert.equal(cancelled.organizationId, "org-contoso");
      assert.equal((await store.getAppState()).novaFollowUpsPending, 1);
      const late = await host.create({ tenantId: contoso.id, question: "Check apps", providerId, ...(model ? { model } : {}), delayMinutes: 1 });
      // Only the late one is due at first; it is more than an hour past its time.
      now = new Date("2026-11-12T11:02:00.000Z");
      await store.handleNovaRecords({ action: "follow-up-cancel", id: cancelled.id });
      await store.fireDueNovaFollowUps();
      const view = await store.handleNovaRecords({ action: "list" });
      assert.equal(view.followUps.find((entry) => entry.id === late.id)?.status, "missed");
      assert.equal(view.followUps.find((entry) => entry.id === cancelled.id)?.status, "cancelled");
      await assert.rejects(host.create({ tenantId: contoso.id, question: "Check", providerId: "anthropic", delayMinutes: 5 }), /provider or model changed/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deletes the organization's notes, follow-ups and instructions on Disconnect and keeps their audit rows", async () => {
    const { store, dir, dbPath, statePath } = await makeStore();
    try {
      const note = await store.novaNotesHost().propose({ tenantId: contoso.id, text: "Kiosks are in Berlin", source: "user-said" });
      await store.novaNotesHost().confirm(note.id);
      const state = await store.getAppState();
      const model = state.providers.find((entry) => entry.id === state.activeProviderId)?.models?.[0];
      await store.novaFollowUpsHost().create({ tenantId: contoso.id, question: "Check compliance", providerId: state.activeProviderId, ...(model ? { model } : {}), delayMinutes: 30 });
      await store.disconnectTenant(contoso.id);
      store.close();
      const db = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM nova_memory_notes").get() as { count: number }).count, 0);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM nova_followups").get() as { count: number }).count, 0);
      const types = (db.prepare("SELECT type FROM audit_log WHERE tenant_id = ? ORDER BY seq").all(contoso.id) as { type: string }[]).map((row) => row.type);
      db.close();
      for (const type of ["nova.memory-note-proposed", "nova.memory-note-confirmed", "nova.memory-note-purged", "nova.followup.created", "nova.followup.cancelled"]) {
        assert.ok(types.includes(type), `${type} is missing from the audit log`);
      }
      const persisted = JSON.parse(await readFile(statePath, "utf8")) as { novaProfile?: { addenda?: Record<string, string> } };
      assert.equal(persisted.novaProfile?.addenda?.["org-contoso"], undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
