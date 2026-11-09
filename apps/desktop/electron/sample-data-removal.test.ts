import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AppStateStore, LEGACY_SAMPLE_TENANT_ID } from "./state.js";

/**
 * Pilot mode and its sample data were removed (maintainer decision,
 * 2026-11-09). An install that used pilot mode still has the sample tenant
 * in its state file; the one-time upgrade removes it with its runs,
 * conversations, cache and organization, and says so once.
 */
const sample = {
  id: LEGACY_SAMPLE_TENANT_ID,
  kind: "sample",
  displayName: "Contoso (pilot)",
  username: "admin@contoso-sample.invalid",
  homeAccountId: "openadminos-sample-account",
  addedAt: "2026-10-26T12:00:00.000Z",
};
const real = {
  id: "tenant-real",
  displayName: "Woodgrove Bank",
  username: "admin@woodgrove.example",
  homeAccountId: "home-real",
  addedAt: "2026-10-20T12:00:00.000Z",
  appRegistration: { kind: "openadminos", clientId: "4e5ab4e0-1f80-4f58-8ff2-1a56d3a2a8b1" },
  grantedScopes: ["graph:User.Read"],
};
const run = (id: string, tenantId: string) => ({
  id,
  agentSlug: "find-inactive-devices",
  status: "completed",
  queuedAt: "2026-10-27T08:00:00.000Z",
  startedAt: "2026-10-27T08:00:00.000Z",
  finishedAt: "2026-10-27T08:00:01.000Z",
  tenantId,
  steps: [],
  logs: [],
  ...(tenantId === LEGACY_SAMPLE_TENANT_ID ? { pilot: true, model: "pilot-prepared" } : {}),
});

async function makeStore(state: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-sample-removal-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const store = new AppStateStore({
    filePath,
    userDataPath: dir,
    statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    providerListFactory: () => [],
  });
  const internal = store as unknown as {
    intelligenceStore: {
      createConversation(input: { id: string; title: string; tenantId: string | null; now: string }): unknown;
      db: { prepare(sql: string): { get(...args: unknown[]): { count: number } } };
    };
    removeCachedAccount: (...args: unknown[]) => Promise<void>;
  };
  return {
    store,
    internal,
    file: async () => JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown> & {
      tenants: Array<{ id: string }>;
      runs: Array<{ id: string }>;
      organizations?: Array<{ id: string }>;
      activeTenantId?: string;
      sampleDataRemovedNotice?: true;
      tenantRemovals?: unknown[];
    },
    conversations: (tenantId: string) =>
      internal.intelligenceStore.db.prepare("SELECT COUNT(*) AS count FROM chat_conversations WHERE tenant_id = ?").get(tenantId).count,
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("removing pilot mode's sample data on upgrade", () => {
  it("removes the sample tenant with its runs, conversations and organization, says so once, and touches nothing else", async () => {
    const fixture = await makeStore({
      activeProviderId: "ollama",
      providerChosenByUser: true,
      installedAgents: [],
      runs: [run("run-sample", LEGACY_SAMPLE_TENANT_ID), run("run-real", real.id)],
      tenants: [real, sample],
      activeTenantId: LEGACY_SAMPLE_TENANT_ID,
      organizations: [
        { id: `org-${real.id}`, name: "Woodgrove Bank", createdAt: real.addedAt, connections: { microsoft365: { tenantId: real.id } } },
        { id: `org-${LEGACY_SAMPLE_TENANT_ID}`, name: "Contoso (pilot)", kind: "sample", createdAt: sample.addedAt, connections: { microsoft365: { tenantId: LEGACY_SAMPLE_TENANT_ID } } },
      ],
    });
    let signInRemovals = 0;
    fixture.internal.removeCachedAccount = async () => {
      signInRemovals += 1;
    };
    try {
      await fixture.store.getAppState();
      fixture.internal.intelligenceStore.createConversation({ id: "chat-sample", title: "Pilot", tenantId: LEGACY_SAMPLE_TENANT_ID, now: "2026-10-27T08:00:00.000Z" });
      fixture.internal.intelligenceStore.createConversation({ id: "chat-real", title: "Real", tenantId: real.id, now: "2026-10-27T08:00:00.000Z" });

      assert.equal(await fixture.store.removeLegacySampleData(), true);

      const file = await fixture.file();
      assert.deepEqual(file.tenants.map((tenant) => tenant.id), [real.id]);
      assert.deepEqual(file.runs.map((entry) => entry.id), ["run-real"]);
      assert.deepEqual(file.organizations?.map((organization) => organization.id), [`org-${real.id}`]);
      assert.equal(file.activeTenantId, undefined);
      assert.equal(file.tenantRemovals, undefined, "the cleanup finished");
      assert.equal(fixture.conversations(LEGACY_SAMPLE_TENANT_ID), 0);
      assert.equal(fixture.conversations(real.id), 1);
      // The sample tenant never signed in: nothing is removed at Microsoft.
      assert.equal(signInRemovals, 0);

      // The one-line notice shows once.
      assert.equal((await fixture.store.getAppState()).sampleDataRemoved, true);
      assert.equal((await fixture.store.dismissSampleDataRemovedNotice()).sampleDataRemoved, undefined);

      // Idempotent: a later launch finds nothing to remove and shows nothing.
      assert.equal(await fixture.store.removeLegacySampleData(), false);
      assert.equal((await fixture.store.getAppState()).sampleDataRemoved, undefined);
      assert.deepEqual((await fixture.file()).tenants.map((tenant) => tenant.id), [real.id]);
    } finally {
      await fixture.close();
    }
  });

  it("recognizes a sample tenant by its id when the kind was not saved", async () => {
    const { kind: _kind, ...unmarked } = sample;
    const fixture = await makeStore({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [unmarked] });
    try {
      assert.equal(await fixture.store.removeLegacySampleData(), true);
      assert.deepEqual((await fixture.file()).tenants, []);
    } finally {
      await fixture.close();
    }
  });

  it("does nothing on an install that never used pilot mode", async () => {
    const fixture = await makeStore({ activeProviderId: "ollama", installedAgents: [], runs: [run("run-real", real.id)], tenants: [real], activeTenantId: real.id });
    try {
      assert.equal(await fixture.store.removeLegacySampleData(), false);
      const file = await fixture.file();
      assert.deepEqual(file.tenants.map((tenant) => tenant.id), [real.id]);
      assert.equal(file.activeTenantId, real.id);
      assert.equal(file.sampleDataRemovedNotice, undefined);
    } finally {
      await fixture.close();
    }
  });
});
