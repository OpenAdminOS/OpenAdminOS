import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunRecord, TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { latestScheduledRunForAgent } from "./companion-schedules.js";
import { ranOnThisDesktop, storedSandboxRunDigest } from "./sandbox-runs.js";
import { AppStateStore } from "./state.js";
import { TenantClosedError } from "./tenant-lifecycle.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };

const tenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-1",
  addedAt: "2026-07-05T00:00:00.000Z",
  lastUsedAt: "2026-07-05T00:00:00.000Z",
  entraTier: "p1",
};

function run(id: string, executedOn?: RunRecord["executedOn"], summary = id): RunRecord {
  return {
    id,
    agentSlug: "find-inactive-devices",
    status: "completed",
    queuedAt: "2026-11-01T00:00:00.000Z",
    finishedAt: "2026-11-01T00:01:00.000Z",
    tenantId: tenant.id,
    summary,
    steps: [],
    logs: [],
    ...(executedOn ? { executedOn } : {}),
  };
}

const KEY_A = "A".repeat(52);
const attested = (checkpointSeq: number) => ({ sandboxId: "mini-pc", pairingKeyFingerprint: KEY_A, checkpointSeq, verifiedAt: "2026-11-15T00:00:00.000Z" });
const onSandbox = (sandboxId: string, organizationId = "org-tenant-1", pairingKeyFingerprint = KEY_A): RunRecord["executedOn"] => ({
  kind: "sandbox",
  sandboxId,
  name: "Office mini PC",
  organizationId,
  model: "llama3.1:8b",
  pairingKeyFingerprint,
});

describe("AppStateStore for paired sandboxes", () => {
  it("lists connected organizations with ids, name and tenant id only, and imports sandbox runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-state-sandbox-"));
    const filePath = join(dir, "state.json");
    await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [run("run-desktop")], tenants: [tenant], activeTenantId: tenant.id }));
    const store = new AppStateStore({ filePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
    try {
      const organizations = await store.listConnectedOrganizations();
      assert.equal(organizations.length, 1);
      assert.deepEqual(Object.keys(organizations[0]!).sort(), ["id", "name", "tenantId"]);
      assert.equal(organizations[0]!.tenantId, tenant.id);

      // A desktop run is never replaced, and a run without a sandbox is not taken.
      assert.equal((await store.importSandboxRuns([run("run-desktop", onSandbox("mini-pc")), run("run-plain"), run("run-a", onSandbox("mini-pc"))])).length, 1);
      assert.equal((await store.getRun("run-desktop"))?.executedOn, undefined);
      assert.equal(await store.getRun("run-plain"), undefined);
      assert.equal((await store.getRun("run-a"))?.executedOn?.kind, "sandbox");

      // An unverified reread never replaces a run; a record verified against a newer event does.
      assert.equal((await store.importSandboxRuns([run("run-a", onSandbox("mini-pc"), "unverified reread")])).length, 0);
      assert.equal((await store.importSandboxRuns([{ ...run("run-a", onSandbox("mini-pc"), "updated"), attestedBy: attested(5) }])).length, 1);
      assert.equal((await store.getRun("run-a"))?.summary, "updated");
      assert.equal((await store.importSandboxRuns([{ ...run("run-a", onSandbox("mini-pc"), "same event"), attestedBy: attested(5) }])).length, 0);
      assert.equal((await store.importSandboxRuns([{ ...run("run-a", onSandbox("mini-pc"), "older event"), attestedBy: attested(4) }])).length, 0);
      assert.equal((await store.getRun("run-a"))?.summary, "updated");
      // Another sandbox does not replace it either.
      assert.equal((await store.importSandboxRuns([run("run-a", onSandbox("other-pc"), "other")])).length, 0);
      assert.equal((await store.getRun("run-a"))?.summary, "updated");
      // The same sandbox id under another organization, or with another key, does not either.
      // An organization that is not connected here is refused outright.
      await assert.rejects(store.importSandboxRuns([run("run-a", onSandbox("mini-pc", "org-b"), "organization b")]), (error: unknown) => error instanceof TenantClosedError);
      assert.equal((await store.importSandboxRuns([run("run-a", onSandbox("mini-pc", "org-tenant-1", "B".repeat(52)), "another key")])).length, 0);
      await assert.rejects(store.importSandboxRuns([{ ...run("run-a", onSandbox("mini-pc"), "another tenant"), tenantId: "tenant-2" }]), (error: unknown) => error instanceof TenantClosedError);
      assert.equal((await store.getRun("run-a"))?.summary, "updated");
      // A sandbox run without the binding the desktop sets is not taken.
      const unbound = { kind: "sandbox" as const, sandboxId: "mini-pc", name: "Office mini PC", organizationId: "org-tenant-1", model: "llama3.1:8b" };
      assert.equal((await store.importSandboxRuns([run("run-unbound", unbound)])).length, 0);

      // A run imported unverified gets its attestation later, on the full binding only.
      assert.equal((await store.importSandboxRuns([run("run-b", onSandbox("mini-pc"))])).length, 1);
      const storedB = (await store.getRun("run-b"))!;
      const entry = {
        runId: "run-b",
        sandboxId: "mini-pc",
        organizationId: "org-tenant-1",
        tenantId: tenant.id,
        pairingKeyFingerprint: KEY_A,
        agentSlug: storedB.agentSlug,
        status: storedB.status,
        storedDigest: storedSandboxRunDigest(storedB),
        attestedBy: attested(9),
      };
      // Another record than the one stored, or another status, is not attested.
      assert.deepEqual((await store.attestSandboxRuns([{ ...entry, storedDigest: "0".repeat(64) }])).attested, []);
      assert.deepEqual((await store.attestSandboxRuns([{ ...entry, status: "failed" }])).attested, []);
      await assert.rejects(store.attestSandboxRuns([{ ...entry, organizationId: "org-b" }]), (error: unknown) => error instanceof TenantClosedError);
      assert.deepEqual((await store.attestSandboxRuns([{ ...entry, pairingKeyFingerprint: "B".repeat(52) }])).attested, []);
      assert.deepEqual((await store.attestSandboxRuns([entry])).attested, ["run-b"]);
      assert.equal((await store.getRun("run-b"))?.attestedBy?.checkpointSeq, 9);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never takes a sandbox run as this desktop's earlier scheduled run", () => {
    const desktopRun = { ...run("run-desktop"), trigger: "schedule" as const, queuedAt: "2026-11-01T00:00:00.000Z" };
    const sandboxRun = { ...run("run-sandbox", onSandbox("mini-pc")), trigger: "schedule" as const, queuedAt: "2026-11-02T00:00:00.000Z" };
    assert.equal(ranOnThisDesktop(sandboxRun), false);
    assert.equal(ranOnThisDesktop(desktopRun), true);
    assert.equal(latestScheduledRunForAgent([sandboxRun, desktopRun], "find-inactive-devices")?.id, "run-desktop");
  });

  it("writes no sandbox run for an organization that is closing, or under a lease of an older generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-state-sandbox-"));
    const filePath = join(dir, "state.json");
    await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [tenant], activeTenantId: tenant.id }));
    const store = new AppStateStore({ filePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
    try {
      await assert.rejects(store.importSandboxRuns([run("run-x", onSandbox("mini-pc", "org-other"))]), (error: unknown) => error instanceof TenantClosedError);
      await assert.rejects(
        store.withSandboxTenantLease(tenant.id, async () => {
          const lifecycle = (store as unknown as { tenantLifecycle: { close(id: string): void } }).tenantLifecycle;
          lifecycle.close(tenant.id);
          return store.importSandboxRuns([run("run-y", onSandbox("mini-pc"))]);
        }),
        (error: unknown) => error instanceof TenantClosedError,
      );
      assert.equal(await store.getRun("run-y"), undefined);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attests a run imported unverified after a state.json round trip, and only that record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-state-sandbox-"));
    const filePath = join(dir, "state.json");
    await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [tenant], activeTenantId: tenant.id }));
    const first = new AppStateStore({ filePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
    let written: Awaited<ReturnType<AppStateStore["importSandboxRuns"]>>;
    try {
      written = await first.importSandboxRuns([run("run-c", onSandbox("mini-pc"))]);
    } finally {
      first.close();
    }
    assert.equal(written.length, 1);
    // A new store reads state.json again, with its normalization.
    const store = new AppStateStore({ filePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
    try {
      const stored = (await store.getRun("run-c"))!;
      assert.equal(stored.usage, null);
      const entry = {
        runId: "run-c",
        sandboxId: "mini-pc",
        organizationId: "org-tenant-1",
        tenantId: tenant.id,
        pairingKeyFingerprint: KEY_A,
        agentSlug: stored.agentSlug,
        status: stored.status,
        storedDigest: written[0]!.storedDigest,
        attestedBy: attested(3),
      };
      assert.deepEqual(await store.attestSandboxRuns([{ ...entry, storedDigest: "0".repeat(64) }]), { attested: [], stale: ["run-c"] });
      assert.deepEqual(await store.attestSandboxRuns([{ ...entry, sandboxId: "other-pc" }]), { attested: [], stale: ["run-c"] });
      assert.deepEqual(await store.attestSandboxRuns([entry]), { attested: ["run-c"], stale: [] });
      assert.equal((await store.getRun("run-c"))?.attestedBy?.checkpointSeq, 3);
      // Attested already: stale from now on.
      assert.deepEqual(await store.attestSandboxRuns([entry]), { attested: [], stale: ["run-c"] });
      // A closing tenant takes nothing.
      (store as unknown as { tenantLifecycle: { close(id: string): void } }).tenantLifecycle.close(tenant.id);
      await assert.rejects(store.attestSandboxRuns([entry]), (error: unknown) => error instanceof TenantClosedError);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
