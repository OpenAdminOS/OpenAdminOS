import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStateStore } from "../state.js";
import { it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { validateCachePage } from "./cache-page.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";

it("validates and pages local cache rows in stable order within one tenant", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaos-cache-rows-"));
  const store = new IntelligenceSqliteStore(join(dir, "cache.db"));
  try {
    const base = {
      tenantId: "tenant-1",
      resource: "users" as const,
      label: "Users",
      scopeSet: [],
      refreshedAt: "2026-11-24T08:00:00.000Z",
    };
    const rows = Array.from({ length: 201 }, (_, index) => ({
      id: String(index).padStart(3, "0"),
      displayName: "Sample user",
      mail: index === 200 ? "unique@example.invalid" : undefined,
    }));
    store.replaceGraphResources({ ...base, rows });
    store.replaceGraphResources({ ...base, tenantId: "tenant-2", rows: [{ id: "private", displayName: "Other tenant" }] });
    const request = { tenantId: base.tenantId, resource: base.resource, offset: 0, limit: 1000 };
    const first = store.browseGraphCache(validateCachePage(request));
    const second = store.browseGraphCache(validateCachePage({ ...request, offset: 200 }));
    assert.equal(first.total, 201);
    assert.equal(first.rows.length, 200);
    assert.deepEqual([...first.rows, ...second.rows].map(({ id }) => id), rows.map(({ id }) => id));
    const filtered = store.browseGraphCache(validateCachePage({ ...request, search: "UNIQUE@" }));
    assert.equal(filtered.total, 1);
    assert.deepEqual(filtered.rows.map(({ id }) => id), ["200"]);
    assert.deepEqual(store.browseGraphCache({ ...request, offset: 9999 }), second);
    for (const search of ["%", "' OR 1=1 --"]) {
      assert.equal(store.browseGraphCache({ ...request, search }).total, 0);
    }
    const detail = { tenantId: base.tenantId, resource: base.resource, id: "200" };
    assert.equal(store.readGraphCacheRow(detail).status, "ready");
    assert.equal(store.readGraphCacheRow({ ...detail, tenantId: "tenant-2" }).status, "missing");
    const db = new DatabaseSync(join(dir, "cache.db"));
    db.prepare("UPDATE graph_resources SET raw_json = ? WHERE tenant_id = ? AND graph_id = ?").run("{", base.tenantId, detail.id);
    db.close();
    assert.deepEqual(store.browseGraphCache({ ...request, offset: 200 }), second);
    assert.equal(store.readGraphCacheRow(detail).status, "unreadable");
    assert.throws(() => validateCachePage({ ...request, limit: 0 }), /Invalid cache page range/);
    assert.throws(() => validateCachePage({ ...request, resource: "unknown" }), /Unknown cache resource/);
    assert.throws(() => validateCachePage({ ...request, offset: -1 }), /Invalid cache page range/);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects cache browsing for another connected organization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaos-cache-page-"));
  try {
    const filePath = join(dir, "state.json");
    await writeFile(filePath, JSON.stringify({
      activeTenantId: "tenant-1",
      tenants: ["tenant-1", "tenant-2"].map((id) => ({
        id, displayName: id, homeAccountId: id, username: "sample@example.invalid",
        addedAt: "2026-11-24T08:00:00.000Z",
      })),
    }));
    const store = new AppStateStore({
      filePath,
      userDataPath: dir,
      statsApiUrl: "",
      tokenStore: { read: async () => "", write: async () => {} },
    });
    try {
      const request = { resource: "users" as const, offset: 0, limit: 100 };
      assert.equal((await store.browseGraphCache({ ...request, tenantId: "tenant-1" })).total, 0);
      await assert.rejects(
        store.browseGraphCache({ ...request, tenantId: "tenant-2" }),
        /Select the connected organization/,
      );
      store["tenantLifecycle"].close("tenant-1");
      await assert.rejects(store.browseGraphCache({ ...request, tenantId: "tenant-1" }), /organization is disconnecting/);
      await assert.rejects(store.readGraphCacheRow({ tenantId: "tenant-1", resource: "users", id: "a" }), /organization is disconnecting/);
      await store.setActiveOrganization(null);
      await assert.rejects(store.browseGraphCache({ ...request, tenantId: "tenant-1" }), /Select the connected organization/);
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
