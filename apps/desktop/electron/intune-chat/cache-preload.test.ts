import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppStateStore } from "../state.js";
import type { RunGraphApi } from "@openadminos/agent-sdk";

it("preloads all pages and preserves the complete snapshot after a paging failure or cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaos-preload-"));
  const filePath = join(dir, "state.json");
  await writeFile(
    filePath,
    JSON.stringify({
      activeProviderId: "ollama",
      tenants: [
        {
          id: "tenant-1",
          displayName: "Test",
          homeAccountId: "test",
          username: "test@example.invalid",
          addedAt: new Date().toISOString(),
        },
      ],
      activeTenantId: "tenant-1",
      installedAgents: [],
      runs: [],
    }),
  );
  let mode = "success",
    requests = 0;
  const graph = {
    request: async (input: {
      query?: Record<string, string>;
      signal?: AbortSignal;
    }) => {
      requests++;
      const page = Number(input.query?.$skiptoken || 0);
      if (mode === "failure" && page === 1)
        throw new Error("HTTP 403 Forbidden");
      if (mode === "cancel") {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10000);
          input.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new Error("Cancelled"));
            },
            { once: true },
          );
        });
      }
      return {
        value: Array.from({ length: 100 }, (_, i) => ({
          id: String(page * 100 + i),
          operatingSystem: "Windows",
          osVersion: "test",
          isEncrypted: true,
        })),
        ...(page < 11
          ? {
              "@odata.nextLink": `https://graph.microsoft.com/beta/deviceManagement/managedDevices?$skiptoken=${page + 1}`,
            }
          : {}),
      };
    },
  } as unknown as RunGraphApi;
  const store = new AppStateStore({
    filePath,
    userDataPath: dir,
    statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => {} },
    graphFactory: () => graph,
  });
  async function waitForDone() {
    for (let i = 0; i < 500; i++) {
      const status = await store.getGraphCacheStatus("tenant-1");
      if (status.preload?.status !== "running") return status;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("Preload timeout");
  }
  try {
    await store.startGraphCachePreload({
      resources: ["managedDevices"],
      tenantId: "tenant-1",
    });
    let status = await waitForDone();
    assert.equal(status.preload?.status, "complete");
    let cached = status.resources.find((r) => r.resource === "managedDevices")!;
    assert.equal(cached.rows, 1200);
    assert.equal(cached.pageLimitReached, false);
    const refreshedAt = cached.refreshedAt;
    mode = "failure";
    await store.startGraphCachePreload({
      resources: ["managedDevices"],
      tenantId: "tenant-1",
    });
    status = await waitForDone();
    assert.equal(status.preload?.status, "incomplete");
    cached = status.resources.find((r) => r.resource === "managedDevices")!;
    assert.equal(cached.rows, 1200);
    assert.equal(cached.refreshedAt, refreshedAt);
    assert.match(cached.lastError!, /read permissions/);
    mode = "cancel";
    const before = requests;
    await store.startGraphCachePreload({
      resources: ["managedDevices"],
      tenantId: "tenant-1",
    });
    while (requests === before) await new Promise((r) => setTimeout(r, 5));
    await store.cancelGraphCachePreload("tenant-1");
    status = await waitForDone();
    assert.equal(status.preload?.status, "cancelled");
    assert.equal(
      status.resources.find((r) => r.resource === "managedDevices")!.rows,
      1200,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('preloads incidents within their 50-row endpoint limit and follows the next page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'incidents-preload-'));
  const filePath = join(dir, 'state.json');
  await writeFile(filePath, JSON.stringify({ activeTenantId: 'tenant-1', activeProviderId: 'ollama', tenants: [{ id: 'tenant-1', displayName: 'Test', homeAccountId: 'test', username: 'test@example.invalid', addedAt: new Date().toISOString() }], installedAgents: [], runs: [] }));
  const requests: string[] = [];
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: '', tokenStore: { read: async () => '', write: async () => {} }, graphFactory: () => ({
    request: async (input: { path: string; query?: Record<string, string> }) => {
      assert.equal(input.path, '/security/incidents');
      if (Number(input.query?.$top) > 50) throw Error("The limit of '50' for Top query has been exceeded.");
      requests.push(input.query?.$skiptoken ?? 'first');
      return input.query?.$skiptoken ? { value: [{ id: 'incident-last' }] } : {
        value: Array.from({ length: 50 }, (_, i) => ({ id: `incident-${i}` })),
        '@odata.nextLink': 'https://graph.microsoft.com/beta/security/incidents?$top=50&$skiptoken=next',
      };
    },
  } as unknown as RunGraphApi) });
  try {
    await store.startGraphCachePreload({ tenantId: 'tenant-1', resources: ['securityIncidents'] });
    for (let i = 0; i < 500; i++) {
      const status = await store.getGraphCacheStatus('tenant-1');
      if (status.preload?.status !== 'running') {
        assert.equal(status.preload?.status, 'complete');
        const incidents = status.resources.find(r => r.resource === 'securityIncidents')!;
        assert.equal(incidents.rows, 51);
        assert.equal(incidents.pageLimitReached, false);
        assert.equal(incidents.lastError, undefined);
        assert.deepEqual(requests, ['first', 'next']);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('Incident preload did not complete');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
