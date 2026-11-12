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
import { NOVA_PROFILE_CHANGED, prepareNovaProfileChange, type NovaActionHost } from "./nova-actions.js";
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

async function makeStore(options: { policy?: ManagedPolicyStatus; clock?: () => Date; extra?: Partial<ConstructorParameters<typeof AppStateStore>[0] & object> } = {}) {
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
    ...(options.extra ?? {}),
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

  it("refuses to confirm or edit a note while the IT policy turns notes off, and still forgets it", async () => {
    const { store, dir } = await makeStore({ policy: await policyOf({ novaMemory: "off" }) });
    try {
      const note = await store.novaNotesHost().propose({ tenantId: contoso.id, text: "Kiosks are in Berlin", source: "user-said" });
      await assert.rejects(store.handleNovaRecords({ action: "note-confirm", id: note.id }), /IT department turned Nova notes off/);
      await assert.rejects(store.handleNovaRecords({ action: "note-edit", id: note.id, text: "Kiosks are in Munich" }), /IT department turned Nova notes off/);
      assert.equal((await store.handleNovaRecords({ action: "list" })).notes[0]?.reviewState, "proposed");
      assert.deepEqual((await store.handleNovaRecords({ action: "note-forget", id: note.id })).notes, []);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("starts without notes and follow-ups when openadminos.db cannot be opened, and says why", async () => {
    const { store, dir } = await makeStore({ extra: { openNovaDatabase: () => { throw new Error("database disk image is malformed"); } } });
    try {
      const state = await store.getAppState();
      assert.equal(state.activeTenantId, contoso.id);
      assert.match(state.novaRecordsUnavailable ?? "", /could not open openadminos\.db/);
      await assert.rejects(store.handleNovaRecords({ action: "list" }), /notes and follow-ups are unavailable/);
      await assert.rejects(store.novaNotesHost().propose({ tenantId: contoso.id, text: "Kiosks", source: "user-said" }), /notes and follow-ups are unavailable/);
      await store.fireDueNovaFollowUps();
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a due follow-up when the IT policy no longer allows its provider", async () => {
    let now = new Date("2026-11-12T10:00:00.000Z");
    let policy = await policyOf({});
    const { store, dir } = await makeStore({ clock: () => now, policy });
    try {
      const state = await store.getAppState();
      const model = state.providers.find((entry) => entry.id === state.activeProviderId)?.models?.[0];
      const followUp = await store.novaFollowUpsHost().create({ tenantId: contoso.id, question: "Check compliance", providerId: state.activeProviderId, ...(model ? { model } : {}), delayMinutes: 5 });
      policy = (await policyOf({ allowedProviders: ["anthropic"] }))!;
      // The store reads its policy object; replace its values as a reload would.
      Object.assign((store as unknown as { managedPolicy: ManagedPolicyStatus }).managedPolicy, policy);
      now = new Date("2026-11-12T10:06:00.000Z");
      await store.fireDueNovaFollowUps();
      const done = (await store.handleNovaRecords({ action: "list" })).followUps.find((entry) => entry.id === followUp.id);
      assert.equal(done?.status, "skipped-provider");
      assert.match(done?.reason ?? "", /IT department no longer allows this provider/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a Nova settings card", () => {
  it("does not overwrite a Settings save made between the card and its write", async () => {
    const { store, dir } = await makeStore();
    try {
      await store.handleNovaProfile({ action: "save", patch: { instructions: "Answer in English." } });
      const host = {
        profile: () => store.novaProfile(),
        // A Settings save lands after the click's first check and before the card's write.
        applyProfileProposal: async (patch, assertUnchanged) => {
          await store.handleNovaProfile({ action: "save", patch: { instructions: "Answer in German." } });
          await store.applyNovaProfileProposal(patch, assertUnchanged);
        },
      } as Pick<NovaActionHost, "profile" | "applyProfileProposal"> as NovaActionHost;
      const prepared = await prepareNovaProfileChange({ field: "instructions", mode: "replace", text: "Answer briefly." }, host);
      await assert.rejects(prepared.execute(new AbortController().signal), { message: NOVA_PROFILE_CHANGED });
      assert.equal((await store.novaProfile()).effective.instructions, "Answer in German.");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a Nova follow-up run", () => {
  const providers = () => [{ id: "ollama", name: "Ollama", isLocal: true, status: "connected", models: ["test"], defaultModel: "test" } as never];
  const graph = (requests: string[]) => () => ({
    listManagedDevices: async () => [],
    retireManagedDevice: async () => { throw new Error("A follow-up must not write."); },
    request: async (input: { method: string; path: string }) => {
      requests.push(`${input.method} ${input.path}`);
      if (input.path === "/deviceManagement/managedDevices") return { value: [{ id: "one", deviceName: "Device A", complianceState: "noncompliant" }] };
      return { value: [] };
    },
  }) as never;

  it("asks once in its organization, lands in a new Chat conversation, sends nothing, and audits in order", async () => {
    let now = new Date();
    const requests: string[] = [];
    let streams = 0;
    const { store, dir, dbPath } = await makeStore({
      clock: () => now,
      extra: {
        providerListFactory: providers,
        graphFactory: graph(requests),
        llmFactory: () => ({
          available: true,
          complete: async () => ({ text: "Device A is noncompliant.", model: "test" }),
          async *stream() { streams += 1; yield { delta: "Device A is noncompliant.", accumulated: "Device A is noncompliant.", done: true, model: "test" }; },
        }) as never,
      },
    });
    let closed = false;
    const close = () => { if (!closed) { closed = true; store.close(); } };
    try {
      const before = (await store.listIntuneChatConversations()).length;
      const followUp = await store.novaFollowUpsHost().create({ tenantId: contoso.id, question: "Check device compliance", providerId: "ollama", model: "test", delayMinutes: 1 });
      now = new Date(now.getTime() + 61_000);
      await store.fireDueNovaFollowUps();
      const done = (await store.handleNovaRecords({ action: "list" })).followUps.find((entry) => entry.id === followUp.id);
      assert.equal(done?.status, "completed", done?.reason);
      const conversations = await store.listIntuneChatConversations();
      assert.equal(conversations.length, before + 1);
      const conversation = conversations.find((entry) => entry.id === done?.conversationId);
      assert.equal(conversation?.title, "Follow-up: Check device compliance");
      assert.equal(conversation?.tenantId, contoso.id);
      assert.ok(requests.every((request) => request.startsWith("GET ")), requests.join(", "));
      close();
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare("SELECT type, initiator FROM audit_log WHERE type LIKE 'nova.followup.%' ORDER BY seq").all() as { type: string; initiator: string }[];
      db.close();
      assert.deepEqual(rows.map((row) => `${row.type}:${row.initiator}`), ["nova.followup.created:person", "nova.followup.started:schedule", "nova.followup.completed:schedule"]);
      assert.ok(streams >= 1, "the follow-up asked the model");
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves no conversation and no completed event when the organization is disconnected while it runs", async () => {
    let now = new Date();
    let release: (() => void) | undefined;
    const { store, dir, dbPath } = await makeStore({
      clock: () => now,
      extra: {
        providerListFactory: providers,
        graphFactory: () => ({
          listManagedDevices: async () => [],
          retireManagedDevice: async () => { throw new Error("A follow-up must not write."); },
          request: async () => {
            await new Promise<void>((resolve) => { release = resolve; });
            return { value: [] };
          },
        }) as never,
        llmFactory: () => ({ available: true, complete: async () => ({ text: "Nothing.", model: "test" }), async *stream() { yield { delta: "Nothing.", accumulated: "Nothing.", done: true, model: "test" }; } }) as never,
      },
    });
    let closed = false;
    const close = () => { if (!closed) { closed = true; store.close(); } };
    try {
      const before = (await store.listIntuneChatConversations()).length;
      const followUp = await store.novaFollowUpsHost().create({ tenantId: contoso.id, question: "Check device compliance", providerId: "ollama", model: "test", delayMinutes: 1 });
      now = new Date(now.getTime() + 61_000);
      const firing = store.fireDueNovaFollowUps();
      // Wait on conditions, not on a number of event loop turns: on a slow
      // runner the follow-up needs file reads before it reaches Graph.
      const until = async (condition: () => boolean, message: string) => {
        for (let index = 0; index < 500 && !condition(); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.ok(condition(), message);
      };
      await until(() => release !== undefined, "the follow-up reached Graph before the Disconnect");
      const disconnecting = store.disconnectTenant(contoso.id);
      const lifecycle = (store as unknown as { tenantLifecycle: { isWritable(id: string): boolean } }).tenantLifecycle;
      await until(() => !lifecycle.isWritable(contoso.id), "the Disconnect closed the organization while the follow-up waited on Graph");
      release?.();
      await firing;
      await disconnecting;
      assert.equal((await store.listIntuneChatConversations()).length, before);
      close();
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const types = (db.prepare("SELECT type FROM audit_log WHERE type LIKE 'nova.followup.%' AND json_extract(event_json, '$.details.followUpId') = ? ORDER BY seq").all(followUp.id) as { type: string }[]).map((row) => row.type);
      db.close();
      assert.equal(types.includes("nova.followup.completed"), false, types.join(", "));
      assert.equal(types[0], "nova.followup.created");
      assert.deepEqual(types, ["nova.followup.created", "nova.followup.started", "nova.followup.failed"]);
    } finally {
      close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
