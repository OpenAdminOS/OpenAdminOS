import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { TenantRecord } from "@openadminos/agent-sdk";

import type { SophosChatContext } from "../intune-chat/tools.js";
import { AppStateStore } from "../state.js";

const tenant: TenantRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "Fixture organization",
  username: "admin@example.test",
  homeAccountId: "fixture-home",
  addedAt: "2026-09-01T00:00:00.000Z",
  connectionId: "fixture-connection",
};
const other = { ...tenant, id: "22222222-2222-2222-2222-222222222222", displayName: "Other fixture" };
const organizationId = `org-${tenant.id}`;
const endpointId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Sophos tools and confirmed writes stay in their organization and records never include credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openadminos-sophos-"));
  const filePath = join(directory, "state.json");
  await writeFile(filePath, JSON.stringify({ tenants: [tenant, other], activeTenantId: tenant.id, runs: [], installedAgents: [] }));
  const writes: unknown[] = [];
  let isolation = "notIsolated";
  let expired = false;
  let blockedRead: { started: () => void; resume: Promise<void> } | undefined;
  const store = new AppStateStore({
    filePath,
    tokenStore: { read: async () => "", write: async () => undefined },
    statsApiUrl: "",
    sophosFetch: async (url, init) => {
      const target = new URL(String(url));
      if (target.hostname === "id.sophos.com") return expired ? new Response(null, { status: 401 }) : Response.json({ access_token: "test-sophos-token", expires_in: 3600, token_type: "bearer" });
      if (target.pathname.startsWith("/whoami/")) {
        return Response.json({ id: endpointId, idType: "tenant", apiHosts: { dataRegion: "https://api-eu01.central.sophos.com" } });
      }
      if (target.pathname.endsWith("/isolation")) {
        writes.push(JSON.parse(String(init?.body)));
        return Response.json({ items: [{ id: endpointId, isolation: { enabled: true } }] }, { status: 202 });
      }
      assert.equal(target.pathname, "/endpoint/v1/endpoints");
      if (blockedRead) {
        blockedRead.started();
        await blockedRead.resume;
      }
      return Response.json({ items: [{ id: endpointId, hostname: "LAB-01", isolation: { status: isolation } }] });
    },
  });
  const context = (which: TenantRecord) => (store as unknown as {
    sophosChatContext(tenant: TenantRecord): Promise<SophosChatContext | undefined>;
  }).sophosChatContext(which);
  try {
    assert.equal(await context(tenant), undefined);
    const credential = { clientId: "fixture-client-id", clientSecret: "fixture-client-secret" };
    const summary = await store.connectSophos({ organizationId, ...credential });
    assert.equal(summary.region, "EU01");
    assert.doesNotMatch(JSON.stringify(summary), /fixture-client|test-sophos-token/);
    assert.doesNotMatch(await readFile(filePath, "utf8"), /fixture-client|test-sophos-token/);
    const started = await context(tenant);
    assert.ok(started);
    assert.match(JSON.stringify(await started.read("sophos_list_endpoints", {})), /LAB-01/);
    assert.equal(await context(other), undefined);
    const run = await store.prepareSophosChange({ organizationId, kind: "isolate", targetIds: [endpointId], comment: "Investigate" });
    assert.equal(run.status, "awaiting-confirmation");
    assert.deepEqual(writes, []);
    await assert.rejects(store.confirmRun(run.id, "ISOLATE 2 DEVICES", { activeOrganizationOnly: true }), /does not match/);
    await store.setActiveTenant(other.id);
    await assert.rejects(started.read("sophos_list_endpoints", {}), /Switch to the organization/);
    await assert.rejects(store.confirmRun(run.id, "ISOLATE 1 DEVICE", { activeOrganizationOnly: true }));
    assert.deepEqual(writes, []);
    await store.setActiveTenant(tenant.id);
    await store.confirmRun(run.id, "ISOLATE 1 DEVICE", { activeOrganizationOnly: true });
    for (let attempt = 0; attempt < 200 && (await store.getRun(run.id))?.status === "running"; attempt++) await delay(10);
    const done = await store.getRun(run.id);
    assert.equal(done?.status, "completed", done?.error);
    assert.match(done.summary ?? "", /accepted/);
    assert.deepEqual(writes, [{ enabled: true, ids: [endpointId], comment: "Investigate" }]);
    for (const [live, message] of [
      ["isolating", /isolation status changed since the plan/],
      ["isolated", /already has the requested isolation state/],
    ] as const) {
      isolation = "notIsolated";
      const stale = await store.prepareSophosChange({ organizationId, kind: "isolate", targetIds: [endpointId], comment: "Investigate" });
      isolation = live;
      await store.confirmRun(stale.id, "ISOLATE 1 DEVICE", { activeOrganizationOnly: true });
      for (let attempt = 0; attempt < 200 && (await store.getRun(stale.id))?.status === "running"; attempt++) await delay(10);
      const refused = await store.getRun(stale.id);
      assert.equal(refused?.status, "failed");
      assert.match(refused.error ?? "", message);
      assert.equal(writes.length, 1);
    }
    expired = true;
    await assert.rejects(store.testSophos(organizationId), /expired/);
    assert.equal((await store.getAppState()).sophosConnections?.[0]?.issue, "credentials");
    expired = false;
    assert.equal((await store.testSophos(organizationId)).issue, undefined);
    isolation = "notIsolated";
    for (const read of [
      () => store.listSophosTargets(organizationId, ""),
      () => store.prepareSophosChange({ organizationId, kind: "isolate", targetIds: [endpointId], comment: "Investigate" }),
    ]) {
      const started = deferred();
      const resume = deferred();
      blockedRead = { started: started.resolve, resume: resume.promise };
      const pending = read();
      await started.promise;
      await store.disconnectSophos(organizationId);
      resume.resolve();
      await assert.rejects(pending, /connection changed/);
      blockedRead = undefined;
      await store.connectSophos({ organizationId, ...credential });
    }
    await store.disconnectSophos(organizationId);
    assert.equal(await context(tenant), undefined);
    await assert.rejects(started.read("sophos_list_endpoints", {}), /connection changed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Sophos refuses credential use after the data folder is sealed and sweeps orphan files", async () => {
  const { mkdir, readdir } = await import("node:fs/promises");
  const { sealDataFolder, unsealDataFolder } = await import("../data-folder-seal.js");
  const { SophosService } = await import("./service.js");
  const root = await mkdtemp(join(tmpdir(), "openadminos-sophos-sweep-"));
  try {
    const secrets = join(root, "sophos");
    await mkdir(secrets);
    await writeFile(join(secrets, "orphan.bin"), "fixture ciphertext");
    const service = new SophosService({
      secretsRoot: root,
      read: async () => ({ tenants: [tenant], activeTenantId: tenant.id }),
      serialize: (work) => work(),
      write: async () => { assert.fail("Unexpected write"); },
      changed: () => assert.fail("Unexpected change"),
      clock: () => new Date(),
      fetch: async () => { assert.fail("Unexpected network request"); },
    });
    sealDataFolder(root);
    await assert.rejects(service.connect({ organizationId, clientId: "fixture", clientSecret: "fixture" }), /resetting/);
    await service.sweep();
    assert.deepEqual(await readdir(secrets), ["orphan.bin"]);
    unsealDataFolder();
    await service.sweep();
    assert.deepEqual(await readdir(secrets), []);
  } finally {
    unsealDataFolder();
    await rm(root, { recursive: true, force: true });
  }
});

test("An unreadable Sophos connection can be disconnected and its secret removed", async () => {
  const { createHash } = await import("node:crypto");
  const { mkdir, readdir } = await import("node:fs/promises");
  const { SophosService } = await import("./service.js");
  const root = await mkdtemp(join(tmpdir(), "openadminos-sophos-unreadable-"));
  try {
    const secrets = join(root, "sophos");
    await mkdir(secrets);
    const filename = createHash("sha256").update(organizationId).digest("hex") + ".bin";
    await writeFile(join(secrets, filename), "fixture ciphertext");
    let state: { tenants: TenantRecord[]; activeTenantId: string; organizations: import("@openadminos/agent-sdk").OrganizationRecord[] } = {
      tenants: [tenant],
      activeTenantId: tenant.id,
      organizations: [{
        id: organizationId, name: tenant.displayName, createdAt: tenant.addedAt,
        connections: { microsoft365: { tenantId: tenant.id }, sophos: {
          tenantId: "invalid", host: "invalid", connectedAt: tenant.addedAt, lastCheckedAt: tenant.addedAt, connectionId: "fixture",
        } },
      }],
    };
    const service = new SophosService({
      secretsRoot: root,
      read: async () => state,
      serialize: (work) => work(),
      write: async (updated) => { state = updated; },
      changed: () => {},
      clock: () => new Date(),
    });
    assert.equal(service.summaries(state)[0]?.unreadable, true);
    await service.sweep();
    assert.deepEqual(await readdir(secrets), [filename]);
    await service.disconnect(organizationId);
    assert.deepEqual(service.summaries(state), []);
    assert.deepEqual(await readdir(secrets), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
