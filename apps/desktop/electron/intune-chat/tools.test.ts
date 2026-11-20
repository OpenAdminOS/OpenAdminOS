import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import {
  DEFAULT_GRAPH_READ_SCOPE_NAMES,
  type GraphCacheResourceKind,
  type RunGraphApi,
} from "@openadminos/agent-sdk";

import { ClassificationLedger, classifyCacheRows, hasGraphFieldClass, hasGraphFieldClasses, withClassificationScope } from "@openadminos/runtime/data-classification";
import { GRAPH_CACHE_RESOURCES, pathForResource } from "./planner.js";
import { executeIntuneChatTool } from "./tools.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";

const { GRAPH_CLASSIFICATION_FIXTURES } = await import(new URL(
  "../../../../packages/runtime/src/graph-classification.fixtures.ts", import.meta.url,
).href) as { GRAPH_CLASSIFICATION_FIXTURES: Record<string, [string, unknown, import("@openadminos/agent-sdk").DataClass]> };

for (const { resource, label } of GRAPH_CACHE_RESOURCES) {
  it(`classifies the ${resource} cache fixture and maps every planner selection`, async () => {
    const { path, select, query } = pathForResource(resource);
    assert.ok(hasGraphFieldClasses(path));
    for (const field of [...select ?? [], ...query?.$select?.split(",") ?? []]) {
      assert.ok(hasGraphFieldClass(path, field), `${path} selects ${field}`);
    }
    const fixture = GRAPH_CLASSIFICATION_FIXTURES[path];
    assert.ok(fixture, path);
    const [field, value, kind] = fixture;
    const row = { id: "synthetic-row-id", [field]: value };
    const dir = await mkdtemp(join(tmpdir(), "openadminos-classification-cache-"));
    const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
    try {
      store.replaceGraphResources({ tenantId: "tenant-1", resource, label, scopeSet: [], rows: [row],
        refreshedAt: "2026-11-18T00:00:00.000Z" });
      const ledger = new ClassificationLedger();
      const result = withClassificationScope(ledger, () => store.queryGraphCache({ tenantId: "tenant-1", resource }));
      assert.deepEqual(result.rows[0]?.row, row);
      const prompt = JSON.stringify(result.rows[0]?.row);
      await ledger.waitForObservations();
      const spans = ledger.classifyRequest({ prompt }).spans;
      assert.ok(spans.some(span => span.source === `cache:${resource}` && span.kind === kind &&
        prompt.slice(span.start, span.end).includes(String(value))), resource);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

it("recognizes a cached user's first name inside a device name and resolves typed user IDs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-classification-identities-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  try {
    const tenantId = "tenant-1";
    const knownId = "c91daa9b-3502-4b61-a461-31862371cad0";
    const unknownId = "a10daa9b-3502-4b61-a461-31862371cad1";
    const deviceName = "Synthea's laptop";
    const common = { tenantId, scopeSet: [], refreshedAt: "2026-11-18T00:00:00.000Z" };
    store.replaceGraphResources({ ...common, resource: "users", label: "Users",
      rows: [{ id: knownId, displayName: "Synthea Fixture", userPrincipalName: "synthea@example.invalid" }] });
    store.replaceGraphResources({ ...common, resource: "managedDevices", label: "Devices",
      rows: [{ id: "workstation-01", deviceName }, { id: "workstation-02", deviceName: "Desk computer" }] });
    const index = store.classificationIdentityIndex(tenantId);
    const ledger = new ClassificationLedger(index);
    const read = withClassificationScope(ledger, () => store.queryGraphCache({ tenantId, resource: "managedDevices" }));
    const prompt = JSON.stringify(read.rows);
    const system = `Compare ${knownId} with ${unknownId}`;
    await ledger.waitForObservations();
    const spans = ledger.classifyRequest({ system, prompt }).spans;
    assert.ok(spans.some(span => span.kind === "identity" && span.source === "cache:managedDevices" &&
      prompt.slice(span.start, span.end) === deviceName));
    assert.ok(spans.some(span => span.kind === "device" && prompt.slice(span.start, span.end) === "Desk computer"));
    assert.deepEqual(spans.filter(span => span.section === "system").map(span => system.slice(span.start, span.end)), [knownId, unknownId]);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("publishes only complete startup identity shards to the request worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-classification-startup-"));
  const path = join(dir, "openadminos.db");
  const tenantId = "fixture-tenant";
  let store = new IntelligenceSqliteStore(path);
  try {
    store.replaceGraphResources({ tenantId, resource: "users", label: "Users", scopeSet: [],
      refreshedAt: "2026-11-18T00:00:00.000Z",
      rows: Array.from({ length: 600 }, (_, i) => ({ id: `user-${i}`, displayName: i === 599 ? "Yelena Last" : `Fixture ${i}` })),
    });
    store.close();
    store = new IntelligenceSqliteStore(path, { backgroundClassification: true });
    const index = store.classificationIdentityIndex(tenantId);
    const ledger = new ClassificationLedger(index);
    await nextTick();
    assert.equal(index.isComplete?.(), false);
    assert.deepEqual([...index.workerShards!()], []);
    assert.equal(ledger.classifyRequest({ prompt: "Yelena" }).coverageIncomplete, true);
    await store.waitForCacheClassification();
    const result = await ledger.classifyProviderRequest({ prompt: "Yelena" });
    assert.equal(result.coverageIncomplete, false);
    assert.equal(result.counts.identity, 1);
    ledger.dispose();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("Disconnect clears staged shards while startup is waiting on a different tenant", async t => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-classification-disconnect-"));
  const path = join(dir, "openadminos.db");
  const tenantId = "fixture-tenant-a";
  const otherId = "fixture-tenant-b";
  let store = new IntelligenceSqliteStore(path);
  try {
    const snapshot = { resource: "users" as const, label: "Users", scopeSet: [], refreshedAt: "2026-11-18T00:00:00.000Z" };
    store.replaceGraphResources({ ...snapshot, tenantId, rows: [{ id: "user-a", displayName: "Yelena Fixture" }] });
    store.replaceGraphResources({ ...snapshot, tenantId: otherId, rows: [{ id: "user-b", displayName: "Cassandra Another" }] });
    store.close();

    let unblock!: () => void;
    const started = new Promise<void>(resolve => { unblock = resolve; });
    let blocked = false;
    const post = Worker.prototype.postMessage;
    t.mock.method(Worker.prototype, "postMessage", function (this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      const message = args[0] as { startup?: { tenantId: string; indexOnly: boolean } };
      if (!blocked && message.startup?.tenantId === otherId && message.startup.indexOnly) {
        blocked = true;
        unblock();
        return;
      }
      post.apply(this, args);
    });
    store = new IntelligenceSqliteStore(path, { backgroundClassification: true });
    await started;

    const stagedIdentity = store["stagedIdentityShards"].get(tenantId)?.get("users");
    const stagedFirstName = store["stagedFirstNames"].get(tenantId)?.get("users");
    assert.ok(stagedIdentity);
    assert.ok(stagedFirstName);
    assert.equal(stagedIdentity.matches("Yelena Fixture"), true);
    assert.equal(stagedFirstName.matches("Yelena"), true);
    assert.deepEqual([...store.classificationIdentityIndex(tenantId).workerShards!()], []);
    await store.disconnectClassification(tenantId);

    assert.equal(store["stagedIdentityShards"].has(tenantId), false);
    assert.equal(store["stagedFirstNames"].has(tenantId), false);
    assert.equal(stagedIdentity.size, 0);
    assert.equal(stagedFirstName.size, 0);
    await store.waitForCacheClassification();
    assert.deepEqual([...store.classificationIdentityIndex(tenantId).workerShards!()], []);
    assert.equal(store.tenantIdentityValues(tenantId).size, 0);
    assert.equal(store.classificationIdentityIndex(otherId).matches("Cassandra"), true);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("reuses versioned cache metadata on reopen and backfills rows from older versions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-cache-classification-version-"));
  const path = join(dir, "openadminos.db");
  const tenantId = "fixture-tenant";
  const resource = "applications";
  const row = { id: "fixture-app", passwordCredentials: [{ hint: "Jz7" }] };
  let store = new IntelligenceSqliteStore(path);
  try {
    store.replaceGraphResources({ tenantId, resource, label: "Applications", scopeSet: [],
      refreshedAt: "2026-11-18T00:00:00.000Z", rows: [row] });
    store.close();
    const db = new DatabaseSync(path);
    try {
      const record = db.prepare("SELECT classification_json FROM graph_resources").get();
      assert.match(String(record?.classification_json), /"hint","credential"/);
      assert.doesNotMatch(String(record?.classification_json), /Jz7/);
      db.exec("UPDATE graph_resources SET classification_json = NULL");
    } finally { db.close(); }
    store = new IntelligenceSqliteStore(path, { backgroundClassification: true });
    await store.waitForCacheClassification();
    const ledger = new ClassificationLedger();
    const result = withClassificationScope(ledger, () => store.queryGraphCache({ tenantId, resource }));
    assert.deepEqual(result.rows[0]?.row, row);
    await ledger.waitForObservations();
    const request = ledger.classifyRequest({ prompt: JSON.stringify(row) });
    assert.equal(request.coverageIncomplete, false);
    assert.equal(request.counts.credential, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("background backfill leaves a removed database absent", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "openadminos-cache-removed-"));
  const dbPath = join(dir, "openadminos.db");
  try {
    await assert.rejects(classifyCacheRows([], "/users", undefined, false, false, undefined, {
      dbPath, tenantId: "tenant-1", resource: "users", afterRowId: 0, indexOnly: false,
    }), /unable to open database file/);
    await assert.rejects(access(dbPath), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("backfills a stale Secure Score page through bounded worker jobs", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = await mkdtemp(join(tmpdir(), "openadminos-score-backfill-"));
  const path = join(dir, "openadminos.db");
  let store = new IntelligenceSqliteStore(path);
  try {
    const tenantId = "fixture-tenant";
    const resource = "secureScores";
    const rows = Array.from({ length: 90 }, (_, i) => ({
      id: `score-${i}`, controlScores: Array.from({ length: 242 }, (_, j) => ({
        controlName: `Control${j}`, description: "A synthetic description for the control that applies to the organization. ".repeat(3),
      })),
    }));
    const db = new DatabaseSync(path);
    store.replaceGraphResources({ tenantId, resource, label: "Secure Score", scopeSet: [],
      refreshedAt: "2026-11-18T00:00:00.000Z", rows });
    store.close();
    try { db.exec("UPDATE graph_resources SET classification_json = NULL"); }
    finally { db.close(); }
    const cursors: number[] = [];
    const post = Worker.prototype.postMessage;
    t.mock.method(Worker.prototype, "postMessage", function (
      this: Worker, ...args: Parameters<Worker["postMessage"]>
    ) {
      const message = args[0] as { type?: string; graphPath?: string; rows?: unknown[]; startup?: { afterRowId: number } };
      if (message.type === "cache" && message.graphPath === "/security/secureScores") {
        assert.deepEqual(message.rows, []);
        cursors.push(message.startup!.afterRowId);
      }
      post.apply(this, args);
    });
    store = new IntelligenceSqliteStore(path, { backgroundClassification: true });
    await store.waitForCacheClassification();
    assert.deepEqual(cursors, [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 90]);
    const check = new DatabaseSync(path);
    try {
      assert.equal(check.prepare("SELECT COUNT(*) AS missing FROM graph_resources WHERE classification_json IS NULL").get()?.missing, 0);
      const record = check.prepare("SELECT classification_json FROM graph_resources WHERE graph_id = 'score-89'").get();
      const [, incomplete, fields] = JSON.parse(String(record?.classification_json));
      assert.equal(incomplete, false);
      assert.deepEqual(fields.at(-1), [["controlScores", "241", "description"], "description", "public"]);
    } finally { check.close(); }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("defers registration of 50 Secure Score sidecars and retains only projected fields", async t => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-score-cache-read-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  const ledger = new ClassificationLedger();
  try {
    const tenantId = "tenant-1";
    const resource = "secureScores";
    const description = "a synthetic control description ".repeat(7);
    store.replaceGraphResources({ tenantId, resource, label: "Secure Score", scopeSet: [],
      refreshedAt: "2026-11-18T00:00:00.000Z",
      rows: Array.from({ length: 50 }, (_, i) => ({
        id: `score-${i}`, controlScores: Array.from({ length: 242 }, (_, j) => ({
          controlName: `control-${j}`, description,
        })),
      })),
    });
    const seen: unknown[] = [];
    const register = ledger.registerClassified.bind(ledger);
    t.mock.method(ledger, "registerClassified", (...args: Parameters<typeof ledger.registerClassified>) => {
      seen.push(...args[1].fields.map(field => field.key));
      register(...args);
    });
    const response = withClassificationScope(ledger, () => store.queryGraphCache({
      tenantId, resource, limit: 50, projectRow: row => ({ id: (row as { id: string }).id }),
    }));
    assert.equal(response.rows.length, 50);
    assert.equal(seen.length, 0);
    const prompt = JSON.stringify(response.rows);
    assert.equal(ledger.classifyRequest({ prompt }).coverageIncomplete, true);
    await ledger.waitForObservations();
    assert.deepEqual(seen, Array<string>(50).fill("id"));
    assert.equal(ledger.classifyRequest({ prompt }).coverageIncomplete, false);
  } finally {
    ledger.dispose();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not register sidecars from a snapshot that replaced the cache read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-cache-read-replaced-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  const ledger = new ClassificationLedger();
  try {
    const snapshot = { tenantId: "tenant-1", resource: "applications" as const, label: "Applications", scopeSet: [] };
    const row = { id: "fixture-app", passwordCredentials: [{ hint: "q7z" }] };
    store.replaceGraphResources({ ...snapshot, refreshedAt: "2026-11-18T00:00:00.000Z", rows: [row] });
    const read = withClassificationScope(ledger, () => store.queryGraphCache(snapshot));
    store.replaceGraphResources({ ...snapshot, refreshedAt: "2026-11-18T01:00:00.000Z", rows: [row] });
    await ledger.waitForObservations();
    assert.deepEqual(read.rows[0]?.row, row);
    const result = ledger.classifyRequest({ prompt: JSON.stringify(row) });
    assert.equal(result.counts.credential, 0);
    assert.equal(result.unexamined.registrations, 1);
    assert.equal(result.effectiveClass, "credential");
  } finally {
    ledger.dispose();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps the previous rows and identity index when batched preparation is cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-cache-classification-cancel-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  try {
    const snapshot = { tenantId: "tenant-1", resource: "users" as const, label: "Users",
      scopeSet: [], refreshedAt: "2026-11-18T00:00:00.000Z" };
    const original = { id: "old-user", displayName: "Synthea Fixture" };
    store.replaceGraphResources({ ...snapshot, rows: [original] });
    const abort = new AbortController();
    const rows = Array.from({ length: 300 }, (_, i) => ({ id: `new-user-${i}`, displayName: `Replacement ${i}` }));
    const refresh = store.replaceGraphResourcesInBatches({ ...snapshot, rows }, abort.signal);
    queueMicrotask(() => abort.abort(new Error("Cancelled fixture refresh")));
    await assert.rejects(refresh, /Cancelled fixture refresh/);
    assert.deepEqual(store.queryGraphCache(snapshot).rows.map(entry => entry.row), [original]);
    const identities = store.classificationIdentityIndex(snapshot.tenantId);
    assert.equal(identities.matches(original.displayName), true);
    assert.equal(identities.matches("Replacement 1"), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("commits a refresh while startup classification is still pending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-cache-refresh-pending-"));
  let resolveStartup!: () => void;
  const startup = new Promise<void>(resolve => { resolveStartup = resolve; });
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"), {
    backgroundClassification: true, beforeClassification: () => startup,
  });
  try {
    const snapshot = { tenantId: "tenant-1", resource: "users" as const, label: "Users",
      scopeSet: [], refreshedAt: "2026-11-18T00:00:00.000Z" };
    const row = { id: "new-user", displayName: "Synthetic Person" };
    await Promise.race([
      store.replaceGraphResourcesInBatches({ ...snapshot, rows: [row] }),
      nextTick().then(() => assert.fail("Refresh waited for startup classification")),
    ]);
    assert.deepEqual(store.queryGraphCache(snapshot).rows.map(entry => entry.row), [row]);
    assert.equal(store.classificationIdentityIndex(snapshot.tenantId).isComplete?.(), false);
  } finally {
    resolveStartup();
    await store.waitForCacheClassification();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("prepares fresh cache sidecars and identity indexes in the local worker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-classification-ingress-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  try {
    const common = { tenantId: "tenant-1", scopeSet: [], refreshedAt: "2026-11-18T00:00:00.000Z" };
    await store.replaceGraphResourcesInBatches({ ...common, resource: "users", label: "Users",
      rows: [{ id: "fixture-id", displayName: "Yelena Fixture" }] });
    assert.equal(store.tenantIdentityValues(common.tenantId).matches("Yelena Fixture"), true);
    await store.waitForCacheClassification();
    const resource = "managedDevices";
    const row = { id: "device-1", deviceName: "Yelena", activationLockBypassCode: "q7z" };
    await store.replaceGraphResourcesInBatches({ ...common, resource, label: "Devices", rows: [row] });
    await store.waitForCacheClassification();
    const ledger = new ClassificationLedger();
    const result = withClassificationScope(ledger, () => store.queryGraphCache({ ...common, resource }));
    assert.deepEqual(result.rows.map(entry => entry.row), [row]);
    await ledger.waitForObservations();
    const { counts, coverageIncomplete } = ledger.classifyRequest({ prompt: JSON.stringify(row) });
    assert.equal(counts.identity, 1);
    assert.equal(counts.credential, 1);
    assert.equal(coverageIncomplete, false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

describe("Intune Chat read-only tools", () => {
  it("lists cache inventory and query_cache enforces row caps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 75);
    try {
      const ctx = toolContext(store);

      const inventory = await executeIntuneChatTool(ctx, "list_cached_resources", {});
      assert.equal(inventory.trace.tool, "list_cached_resources");
      assert.match(inventory.trace.resultSummary, /cache resources listed/);
      assert.equal(inventory.trace.error, undefined);

      const query = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        filters: [{ field: "operatingSystem", op: "eq", value: "Windows" }],
        sort: { field: "displayName", direction: "asc" },
        limit: 500,
      });
      const result = query.result as {
        totalCount: number;
        returnedRows: number;
        limit: number;
        rows: unknown[];
      };
      assert.equal(result.totalCount, 75);
      assert.equal(result.returnedRows, 50);
      assert.equal(result.limit, 50);
      assert.equal(result.rows.length, 50);
      const count = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', select: ['id'], limit: 1 });
      const projected = count.result as { totalCount: number; rows: Array<{ row: Record<string, unknown> }> };
      assert.equal(projected.totalCount, 75);
      assert.deepEqual(Object.keys(projected.rows[0]!.row), ['id']);

      assert.match(query.trace.resultSummary, /50 of 75 cached rows returned/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("log resources carry their 7-day window at the front of cache tool results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-log-"));
    const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
    try {
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "signIns",
        label: "Sign-in logs",
        scopeSet: ["AuditLog.Read.All"],
        refreshedAt: new Date().toISOString(),
        pageLimitReached: true,
        rows: [{ id: "sign-in-1", userPrincipalName: "a@example.invalid", createdDateTime: new Date().toISOString() }],
      });
      const ctx = toolContext(store);
      const query = await executeIntuneChatTool(ctx, "query_cache", { resource: "signIns", limit: 5 });
      const result = query.result as Record<string, unknown>;
      // Observation compaction keeps leading keys, so the window comes first.
      assert.deepEqual(Object.keys(result).slice(0, 2), ["resource", "coverage"]);
      assert.match(String(result.coverage), /^Newest 1 entries from the 7 days/);
      const inventory = await executeIntuneChatTool(ctx, "list_cached_resources", {});
      const entry = (inventory.result as { resources: Array<Record<string, unknown>> }).resources.find((r) => r.resource === "signIns")!;
      assert.match(String(entry.coverage), /7 days/);
      const managed = (inventory.result as { resources: Array<Record<string, unknown>> }).resources.find((r) => r.resource === "managedDevices")!;
      assert.equal(managed.coverage, undefined);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("query_cache can count Intune apps by @odata.type for platform questions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 0);
    try {
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "mobileApps",
        label: "Intune apps",
        scopeSet: ["DeviceManagementApps.Read.All"],
        refreshedAt: "2026-06-01T10:00:00.000Z",
        rows: [
          { id: "mac-pkg", displayName: "Mac PKG", "@odata.type": "#microsoft.graph.macOSPkgApp" },
          { id: "mac-dmg", displayName: "Mac DMG", "@odata.type": "#microsoft.graph.macOSDmgApp" },
          { id: "win", displayName: "Win32", "@odata.type": "#microsoft.graph.win32LobApp" },
        ],
      });

      const count = await executeIntuneChatTool(toolContext(store), "query_cache", {
        resource: "mobileApps",
        filters: [{ field: "@odata.type", op: "contains", value: "macOS" }],
        select: ["id", "@odata.type"],
        limit: 1,
      });

      assert.equal(count.trace.error, undefined);
      const result = count.result as {
        totalCount: number;
        rows: Array<{ row: Record<string, unknown> }>;
      };
      assert.equal(result.totalCount, 2);
      assert.match(String(result.rows[0]!.row["@odata.type"]), /macOS/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("query_cache accepts operator objects in where for comparison filters", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 0);
    try {
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "managedDevices",
        label: "Intune managed devices",
        scopeSet: ["DeviceManagementManagedDevices.Read.All"],
        refreshedAt: "2026-06-01T10:00:00.000Z",
        rows: [
          { id: "stale-1", deviceName: "STALE-1", operatingSystem: "Windows", lastSyncDateTime: "2026-05-10T09:00:00.000Z" },
          { id: "fresh-1", deviceName: "FRESH-1", operatingSystem: "Windows", lastSyncDateTime: "2026-05-30T09:00:00.000Z" },
          { id: "fresh-2", deviceName: "FRESH-2", operatingSystem: "macOS", lastSyncDateTime: "2026-05-31T09:00:00.000Z" },
        ],
      });
      const ctx = toolContext(store);
      // The shape models reach for when a comparison does not fit the
      // scalar where map: an operator object per field.
      const stale = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        where: { lastSyncDateTime: { lt: "2026-05-20" } },
        limit: 25,
      });
      assert.equal(stale.trace.error, undefined);
      assert.equal((stale.result as { totalCount: number }).totalCount, 1);

      const wrongOp = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        where: { lastSyncDateTime: { approx: "2026-05-20" } },
      });
      assert.match(wrongOp.trace.error ?? "", /Unsupported query_cache operator: approx/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list_cached_resources staleness follows per-resource host TTLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      store.replaceGraphResources({
        tenantId: "tenant-1", resource: "signIns", label: "Sign-in logs",
        scopeSet: ["AuditLog.Read.All"], refreshedAt: anHourAgo,
        rows: [{ id: "sign-in-1" }],
      });
      store.replaceGraphResources({
        tenantId: "tenant-1", resource: "deviceConfigurations", label: "Device configurations",
        scopeSet: ["DeviceManagementConfiguration.Read.All"], refreshedAt: twelveHoursAgo,
        rows: [{ id: "profile-1" }],
      });
      const inventory = await executeIntuneChatTool(toolContext(store), "list_cached_resources", {});
      const resources = (inventory.result as { resources: Array<{ resource: string; stale: boolean }> }).resources;
      assert.equal(resources.find((entry) => entry.resource === "signIns")?.stale, true);
      assert.equal(resources.find((entry) => entry.resource === "deviceConfigurations")?.stale, false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get rejects writes and unknown paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);

      const write = await executeIntuneChatTool(ctx, "graph_get", {
        method: "POST",
        path: "/users",
      });
      assert.equal(write.trace.error, "graph_get is read-only. Only GET is accepted.");

      const unknown = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/openAdminOS/not-real",
      });
      assert.match(unknown.trace.error ?? "", /Unknown Microsoft Graph GET path/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get validates allowed read scopes, caps $top, and records trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const graphRequests: Array<{ scopes: string[]; path: string; top?: string }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          graphRequests.push({
            scopes: currentScopes,
            path: input.path,
            top: input.query?.$top,
          });
          return {
            value: Array.from({ length: 60 }, (_, index) => ({
              id: `user-${index}`,
              displayName: `User ${index}`,
            })),
            "@odata.nextLink": "https://graph.microsoft.com/beta/users?$skiptoken=next",
          };
        },
      };
      let currentScopes: string[] = [];
      const ctx = toolContext(store, {
        graphForScopes: async (scopes) => {
          currentScopes = scopes;
          return graph;
        },
      });

      const execution = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/users",
        query: { $top: "500", $select: "id,displayName" },
      });
      const result = execution.result as {
        returnedRows: number;
        rowCountInPage: number;
        truncated: boolean;
      };
      assert.equal(graphRequests[0]?.path, "/users");
      assert.equal(graphRequests[0]?.top, "50");
      assert.ok(graphRequests[0]?.scopes.includes("User.Read.All"));
      assert.equal(result.returnedRows, 50);
      assert.equal(result.rowCountInPage, 60);
      assert.equal(result.truncated, true);
      assert.equal(execution.trace.tool, "graph_get");
      assert.match(execution.trace.resultSummary, /live rows returned/i);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get omits $top on endpoints that reject it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      // Verified against live Graph via Lokka: the managedDeviceOverview
      // and authenticationMethodsPolicy singletons and the fixed-page-size
      // directoryRoles collection answer 400 to any $top, so the host must
      // not inject its default page size there.
      const noTopPaths = new Map<string, unknown>([
        ["/deviceManagement/managedDeviceOverview", { "@odata.type": "#microsoft.graph.managedDeviceOverview", enrolledDeviceCount: 3 }],
        ["/policies/authenticationMethodsPolicy", { id: "authenticationMethodsPolicy", displayName: "Authentication Methods Policy" }],
        ["/directoryRoles", { value: [{ id: "role-1", displayName: "Global Administrator", roleTemplateId: "template-1" }] }],
      ]);
      const graphRequests: Array<{ path: string; top?: string }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          graphRequests.push({ path: input.path, top: input.query?.$top });
          if (input.query?.$top !== undefined) {
            throw new Error(`HTTP 400: $top is not valid for ${input.path}`);
          }
          return noTopPaths.get(input.path) ?? { value: [] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });

      for (const path of noTopPaths.keys()) {
        const execution = await executeIntuneChatTool(ctx, "graph_get", { path });
        assert.equal(execution.trace.error, undefined, `${path} should not error`);
      }
      assert.deepEqual(
        graphRequests.map((request) => [request.path, request.top]),
        [...noTopPaths.keys()].map((path) => [path, undefined]),
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get allows planner paths whose declared scope is broader than the catalog minimum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      // The bundled catalog lists least-privileged scopes only, so
      // /groups (GroupMember.Read.All declared) and the authentication
      // methods policy (Policy.Read.All declared, documented as a
      // higher-privileged permission) read as unconsented there. Both
      // are planner cache paths refreshed with those scopes, so
      // graph_get must reach Graph instead of refusing up front.
      const scopedRequests: Array<{ scopes: string[]; path: string }> = [];
      let currentScopes: string[] = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          scopedRequests.push({ scopes: currentScopes, path: input.path });
          return { value: [{ id: "row-1" }] };
        },
      };
      const ctx = toolContext(store, {
        graphForScopes: async (scopes) => {
          currentScopes = scopes;
          return graph;
        },
      });

      const groups = await executeIntuneChatTool(ctx, "graph_get", { path: "/groups" });
      assert.equal(groups.trace.error, undefined);
      const authn = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/policies/authenticationMethodsPolicy",
      });
      assert.equal(authn.trace.error, undefined);
      assert.ok(scopedRequests[0]?.scopes.includes("GroupMember.Read.All"));
      assert.ok(scopedRequests[1]?.scopes.includes("Policy.Read.All"));
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get refuses deeper descendants of planner paths that need other scopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      // The planner exemption covers the declared collection and its
      // by-id children. Deeper descendants such as group drives need
      // Files.Read, which Chat never requests, so they must be refused
      // before any Graph call even though /groups itself is exempt.
      let requests = 0;
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request() {
          requests += 1;
          return { value: [{ id: "drive-1" }] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const execution = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/groups/11111111-2222-3333-4444-555555555555/drives",
      });
      assert.match(execution.trace.error ?? "", /was not granted/);
      assert.equal(requests, 0);

      // The by-id child of the same collection stays allowed with the
      // declared scope.
      let byIdScopes: string[] = [];
      const byIdCtx = toolContext(store, {
        graphForScopes: async (scopes) => {
          byIdScopes = scopes;
          return graph;
        },
      });
      const byId = await executeIntuneChatTool(byIdCtx, "graph_get", {
        path: "/groups/11111111-2222-3333-4444-555555555555",
      });
      assert.equal(byId.trace.error, undefined);
      assert.ok(byIdScopes.includes("GroupMember.Read.All"));
      assert.equal(requests, 1);

      // Mixed-case paths still attribute the declared scope.
      const upper = await executeIntuneChatTool(byIdCtx, "graph_get", {
        path: "/GROUPS/11111111-2222-3333-4444-555555555555",
      });
      assert.equal(upper.trace.error, undefined);
      assert.ok(byIdScopes.includes("GroupMember.Read.All"));
      assert.equal(requests, 2);

      // A function segment is not a by-id child: this one needs the
      // ReadWrite scope Chat never requests. The parenthesized catalog
      // spelling carries no permissions of its own and must inherit
      // the plain form's instead of reading as permission-free.
      for (const fnPath of [
        "/deviceManagement/deviceCompliancePolicies/getDevicesScheduledToRetire",
        "/deviceManagement/deviceCompliancePolicies/getDevicesScheduledToRetire()",
      ]) {
        const fn = await executeIntuneChatTool(ctx, "graph_get", { path: fnPath });
        assert.match(fn.trace.error ?? "", /was not granted/, fnPath);
        assert.equal(requests, 2, fnPath);
      }

      // A type-cast segment is not a by-id child either.
      const cast = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/applications/microsoft.graph.agentIdentityBlueprint",
      });
      assert.match(cast.trace.error ?? "", /was not granted/);
      assert.equal(requests, 2);

      // Verified deeper reads: another user's memberships are covered
      // by the already-consented User.Read.All even though the catalog
      // lists only the self-only User.Read least-privileged scope.
      let memberScopes: string[] = [];
      const memberCtx = toolContext(store, {
        graphForScopes: async (scopes) => {
          memberScopes = scopes;
          return graph;
        },
      });
      const memberOf = await executeIntuneChatTool(memberCtx, "graph_get", {
        path: "/users/11111111-2222-3333-4444-555555555555/memberOf",
      });
      assert.equal(memberOf.trace.error, undefined);
      assert.ok(memberScopes.includes("User.Read.All"));
      const transitive = await executeIntuneChatTool(memberCtx, "graph_get", {
        path: "/users/11111111-2222-3333-4444-555555555555/transitiveMemberOf",
      });
      assert.equal(transitive.trace.error, undefined);
      assert.equal(requests, 4);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get pages directoryRoles without a client page size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const requests: Array<{ path: string; query?: Record<string, string> }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("write should not run"); },
        async request(input) {
          requests.push({ path: input.path, query: input.query as Record<string, string> | undefined });
          if (!input.query?.$skiptoken) {
            return {
              value: [{ id: "role-1" }, { id: "role-2" }],
              "@odata.nextLink": "https://graph.microsoft.com/beta/directoryRoles?$skiptoken=page-2",
            };
          }
          return { value: [{ id: "role-3" }] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const execution = await executeIntuneChatTool(ctx, "graph_get", { path: "/directoryRoles" });
      const result = execution.result as { returnedRows: number; truncated: boolean };
      assert.equal(execution.trace.error, undefined);
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.query?.$top, undefined);
      assert.equal(requests[1]?.query?.$skiptoken, "page-2");
      assert.equal(result.returnedRows, 3);
      assert.equal(result.truncated, false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get leaves a 403 without token evidence unverified", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store, {
        graphForScopes: async () => ({
          async listManagedDevices() { return []; },
          async retireManagedDevice() { throw new Error("write should not run"); },
          async request() {
            throw new Error('Graph GET /users failed (HTTP 403): {"error":{"code":"Authorization_RequestDenied"}}');
          },
        }),
      });
      const execution = await executeIntuneChatTool(ctx, "graph_get", { path: "/users" });
      assert.ok(execution.trace.error, "expected a traced error");
      assert.match(execution.trace.error, /denied access to GET \/users/);
      assert.match(execution.trace.error, /cannot determine the cause/);
      assert.doesNotMatch(execution.trace.error, /reconnect/i);
      assert.match(execution.trace.error, /HTTP 403/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("traces a failed refresh_resource as an error, not as evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store, {
        refreshResource: async (resource) => ({
          resource,
          label: resource,
          rows: 0,
          refreshedAt: "2026-06-01T10:01:00.000Z",
          ok: false,
          error: "Microsoft Graph denied read access (HTTP 403).",
        }),
      });
      const execution = await executeIntuneChatTool(ctx, "refresh_resource", {
        resource: "managedDevices",
      });
      assert.match(execution.trace.error ?? "", /HTTP 403/);
      assert.match(execution.trace.resultSummary, /Refresh failed/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get follows a $skip continuation with its full query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const requests: Array<{ path: string; query?: Record<string, string> }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("write should not run"); },
        async request(input) {
          requests.push({ path: input.path, query: input.query as Record<string, string> | undefined });
          if (!input.query?.["$skip"]) {
            return {
              value: Array.from({ length: 10 }, (_, index) => ({ id: `user-${index}` })),
              "@odata.nextLink": "https://graph.microsoft.com/beta/users?$skip=10&$select=id,displayName",
            };
          }
          return { value: [{ id: "user-10" }, { id: "user-11" }] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const execution = await executeIntuneChatTool(ctx, "graph_get", { path: "/users" });
      const result = execution.result as { returnedRows: number; rows: Array<{ id: string }> };
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.query?.["$skip"], "10");
      assert.equal(requests[1]?.query?.["$select"], "id,displayName");
      assert.equal(result.returnedRows, 12);
      assert.equal(result.rows.at(-1)?.id, "user-11");
      const graphSource = (execution.trace as { graphSource?: { rows: number; pagesFetched?: number } }).graphSource;
      assert.equal(graphSource?.rows, 12);
      assert.equal(graphSource?.pagesFetched, 2);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get follows nextLink pages within the row cap", async t => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    const ledger = new ClassificationLedger();
    let resolveGate!: () => void;
    const gate = new Promise<void>(resolve => { resolveGate = resolve; });
    const registrations: Promise<void>[] = [];
    t.mock.method(ledger, "registerGraph", () => {
      const job = ledger.scheduleRegistration(() => gate);
      registrations.push(job);
      return job;
    });
    try {
      const seenSkiptokens: Array<string | undefined> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("write should not run"); },
        async request(input) {
          const token = input.query?.$skiptoken;
          seenSkiptokens.push(token);
          const page = token === "page2" ? 2 : 1;
          return {
            value: Array.from({ length: 30 }, (_, index) => ({
              id: `user-p${page}-${index}`,
              displayName: `User P${page} ${index}`,
            })),
            "@odata.count": 75,
            "@odata.nextLink": `https://graph.microsoft.com/beta/users?$skiptoken=page${page + 1}`,
          };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const executionPromise = withClassificationScope(ledger, () => executeIntuneChatTool(ctx, "graph_get", {
        path: "/users",
        query: { $select: "id,displayName", $count: "true" },
      }));
      const execution = await Promise.race([executionPromise, nextTick().then(() => assert.fail("Paging waited for registration"))]);
      const result = execution.result as {
        returnedRows: number;
        truncated: boolean;
        totalCount?: number;
        pagesFetched?: number;
        rows: Array<{ id: string }>;
      };
      assert.equal(registrations.length, 2);
      assert.equal(ledger.classifyRequest({ prompt: "Paging completed" }).coverageIncomplete, true);
      assert.deepEqual(seenSkiptokens, [undefined, "page2"]);
      assert.equal(result.returnedRows, 50);
      assert.equal(result.truncated, true);
      assert.equal(result.totalCount, 75);
      assert.equal(result.pagesFetched, 2);
      assert.equal(result.rows.length, 50);
      assert.equal(result.rows[0]?.id, "user-p1-0");
      assert.equal(result.rows[30]?.id, "user-p2-0");
    } finally {
      resolveGate();
      await Promise.all(registrations);
      ledger.dispose();
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get accepts Entra and Defender read paths with their scopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const graphRequests: Array<{ scopes: string[]; path: string }> = [];
      let currentScopes: string[] = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          graphRequests.push({ scopes: currentScopes, path: input.path });
          return { value: [] };
        },
      };
      const ctx = toolContext(store, {
        graphForScopes: async (scopes) => {
          currentScopes = scopes;
          return graph;
        },
      });

      const cases: Array<{ path: string; scope: string }> = [
        { path: "/identity/conditionalAccess/namedLocations", scope: "Policy.Read.All" },
        { path: "/directoryRoles", scope: "RoleManagement.Read.Directory" },
        { path: "/security/alerts_v2", scope: "SecurityAlert.Read.All" },
        { path: "/security/incidents", scope: "SecurityIncident.Read.All" },
        { path: "/security/secureScores", scope: "SecurityEvents.Read.All" },
      ];
      for (const [index, entry] of cases.entries()) {
        const execution = await executeIntuneChatTool(ctx, "graph_get", {
          path: entry.path,
        });
        assert.equal(execution.trace.error, undefined, `${entry.path} should be allowed`);
        assert.equal(graphRequests[index]?.path, entry.path);
        assert.ok(
          graphRequests[index]?.scopes.includes(entry.scope),
          `${entry.path} should request ${entry.scope}, got ${graphRequests[index]?.scopes.join(", ")}`,
        );
      }
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refresh_resource triggers the provided refresh callback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const refreshed: GraphCacheResourceKind[] = [];
      const ctx = toolContext(store, {
        refreshResource: async (resource) => {
          refreshed.push(resource);
          return {
            resource,
            label: "Intune managed devices",
            rows: 3,
            refreshedAt: "2026-06-01T10:02:00.000Z",
            ok: true,
          };
        },
      });

      const execution = await executeIntuneChatTool(ctx, "refresh_resource", {
        resource: "managedDevices",
      });
      assert.deepEqual(refreshed, ["managedDevices"]);
      assert.equal(execution.trace.tool, "refresh_resource");
      assert.match(execution.trace.resultSummary, /3 rows refreshed/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("query_drift reads local drift timeline rows, clamps top, and records trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const timelineCalls: unknown[] = [];
      const ctx = toolContext(store, {
        getDriftTimeline: async (input) => {
          timelineCalls.push(input);
          return {
            tenantId: "tenant-1",
            limit: 500,
            hasMore: true,
            entries: Array.from({ length: 60 }, (_, index) => ({
              id: `entry-${index}`,
              snapshotId: `snapshot-${index}`,
              capturedAt: `2026-07-05T10:${String(index).padStart(2, "0")}:00.000Z`,
              resource: "configurationPolicies" as const,
              resourceLabel: "Settings catalog policies",
              changeKind: "modified" as const,
              fieldChangeCount: index + 1,
              timestampOnly: false,
              graphId: `policy-${index}`,
              displayName: `Policy ${index}`,
              attribution: {
                status: "matched" as const,
                actor: { userPrincipalName: "admin@contoso.example" },
              },
            })),
          };
        },
      });

      const execution = await executeIntuneChatTool(ctx, "query_drift", {
        resource: "configurationPolicies",
        from: "2026-07-05T00:00:00.000Z",
        to: "2026-07-06T00:00:00.000Z",
        changeKind: "modified",
        top: 500,
      });

      const result = execution.result as {
        returnedRows: number;
        top: number;
        note?: string;
        rows: Array<{ actor: string; kind: string; fieldsChanged: number }>;
      };
      assert.equal(result.top, 50);
      assert.equal(result.returnedRows, 50);
      assert.match(result.note ?? "", /capped at 50 rows/i);
      assert.equal(result.rows[0]?.actor, "admin@contoso.example");
      assert.equal(result.rows[0]?.kind, "modified");
      assert.equal(result.rows[0]?.fieldsChanged, 1);
      assert.equal(execution.trace.tool, "query_drift");
      assert.match(execution.trace.resultSummary, /50 drift changes returned/);
      assert.deepEqual(timelineCalls[0], {
        tenantId: "tenant-1",
        resources: ["configurationPolicies"],
        from: "2026-07-05T00:00:00.000Z",
        to: "2026-07-06T00:00:00.000Z",
        limit: 500,
      });

      const invalid = await executeIntuneChatTool(ctx, "query_drift", {
        resource: "managedDevices",
      });
      assert.match(invalid.trace.error ?? "", /drift-tracked resource/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function seededStore(dir: string, deviceCount: number): IntelligenceSqliteStore {
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  store.replaceGraphResources({
    tenantId: "tenant-1",
    resource: "managedDevices",
    label: "Intune managed devices",
    scopeSet: ["DeviceManagementManagedDevices.Read.All"],
    refreshedAt: "2026-06-01T10:00:00.000Z",
    rows: Array.from({ length: deviceCount }, (_, index) => ({
      id: `device-${index}`,
      deviceName: `WIN-${String(index).padStart(2, "0")}`,
      displayName: `WIN-${String(index).padStart(2, "0")}`,
      operatingSystem: "Windows",
      complianceState: index % 2 === 0 ? "compliant" : "noncompliant",
      lastSyncDateTime: "2026-06-01T09:00:00.000Z",
    })),
  });
  return store;
}

function toolContext(
  store: IntelligenceSqliteStore,
  overrides: Partial<{
    graphForScopes: Parameters<typeof executeIntuneChatTool>[0]["graphForScopes"];
    refreshResource: Parameters<typeof executeIntuneChatTool>[0]["refreshResource"];
    getDriftTimeline: Parameters<typeof executeIntuneChatTool>[0]["getDriftTimeline"];
  }> = {},
): Parameters<typeof executeIntuneChatTool>[0] {
  return {
    tenantId: "tenant-1",
    store,
    grantedScopes: new Set(DEFAULT_GRAPH_READ_SCOPE_NAMES),
    graphForScopes:
      overrides.graphForScopes ??
      (async () => ({
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request() {
          return { value: [] };
        },
      })),
    refreshResource:
      overrides.refreshResource ??
      (async (resource) => ({
        resource,
        label: resource,
        rows: 0,
        refreshedAt: "2026-06-01T10:01:00.000Z",
        ok: true,
      })),
    getDriftTimeline:
      overrides.getDriftTimeline ??
      (async () => ({
        tenantId: "tenant-1",
        entries: [],
        hasMore: false,
        limit: 500,
      })),
  };
}

describe("Graph endpoint discovery and reachability", () => {
  it("ranks license inventory for seat questions and returns no unrelated endpoints for unmatched words", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-license-search-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "find_graph_endpoint", { query: "licenses available seats" });
      assert.equal((result.result as { candidates: Array<{ path: string }> }).candidates[0]?.path, "/subscribedSkus");
      const absent = await executeIntuneChatTool(ctx, "find_graph_endpoint", { query: "unmatchablezzzzzz" });
      assert.deepEqual((absent.result as { candidates: unknown[] }).candidates, []);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("reads subscribed SKUs without injecting unsupported paging and rejects unsupported filtering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-license-query-"));
    const store = seededStore(dir, 1);
    let requests = 0;
    try {
      const ctx = toolContext(store, { graphForScopes: async () => ({
        async request(input) { requests++; assert.deepEqual(input.query, { $select: "skuPartNumber,prepaidUnits,consumedUnits" }); return { value: [{ skuPartNumber: "TEST", prepaidUnits: { enabled: 10 }, consumedUnits: 4 }] }; },
      }) as RunGraphApi });
      const ok = await executeIntuneChatTool(ctx, "graph_get", { path: "/subscribedSkus", query: { $select: "skuPartNumber,prepaidUnits,consumedUnits" } });
      assert.equal(ok.trace.error, undefined);
      const blocked = await executeIntuneChatTool(ctx, "graph_get", { path: "/subscribedSkus", query: { $filter: "consumedUnits eq 0" } });
      assert.match(blocked.trace.error!, /supports only \$select/);
      assert.equal(requests, 1);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("finds candidate endpoints from plain words so a path need not be recalled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      const found = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "conditional access named locations",
      });
      const result = found.result as {
        candidates: Array<{ path: string; usable: boolean }>;
      };
      assert.equal(found.trace.error, undefined);
      assert.ok(result.candidates.length > 0, "expected candidate endpoints");
      assert.ok(
        result.candidates.some((entry) => entry.path.includes("namedLocations")),
        `expected a namedLocations path, got ${result.candidates.map((c) => c.path).join(", ")}`,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks planner paths usable when their declared scope covers the catalog minimum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      // /groups and the authentication methods policy are usable through
      // graph_get with planner-declared scopes, so discovery must not
      // steer the model away from them as unconsented.
      const groups = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "groups",
      });
      const groupCandidates = (
        groups.result as { candidates: Array<{ path: string; usable: boolean }> }
      ).candidates;
      const groupsEntry = groupCandidates.find((entry) => entry.path === "/groups");
      assert.ok(groupsEntry, `expected /groups, got ${groupCandidates.map((c) => c.path).join(", ")}`);
      assert.equal(groupsEntry.usable, true);

      const authn = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "authentication methods policy",
      });
      const authnCandidates = (
        authn.result as { candidates: Array<{ path: string; usable: boolean }> }
      ).candidates;
      const authnEntry = authnCandidates.find(
        (entry) => entry.path === "/policies/authenticationMethodsPolicy",
      );
      assert.ok(authnEntry, `expected the policy path, got ${authnCandidates.map((c) => c.path).join(", ")}`);
      assert.equal(authnEntry.usable, true);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps how many candidates are returned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-cap-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      const found = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "user",
        limit: 500,
      });
      const result = found.result as { candidates: unknown[] };
      assert.ok(result.candidates.length <= 15);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attempts a read endpoint whose permissions the catalog does not document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-unknown-"));
    const store = seededStore(dir, 1);
    try {
      let requested: string | undefined;
      const ctx = toolContext(store, {
        graphForScopes: async () => ({
          async listManagedDevices() {
            return [];
          },
          async retireManagedDevice() {
            throw new Error("write should not run");
          },
          async request(input) {
            requested = input.path;
            return { value: [{ id: "a" }] };
          },
        }),
      });

      // A real catalog path the bundled docs carry no permissions for.
      // Previously rejected as "outside Chat's read-only scope
      // allowlist" purely because of that missing metadata.
      const result = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/admin/edge/internetExplorerMode",
      });

      assert.equal(result.trace.error, undefined, `unexpected error: ${result.trace.error}`);
      assert.equal(requested, "/admin/edge/internetExplorerMode");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an endpoint needing a permission this app never requests, without calling Graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-refuse-"));
    const store = seededStore(dir, 1);
    try {
      let called = false;
      const ctx = toolContext(store, {
        graphForScopes: async () => ({
          async listManagedDevices() {
            return [];
          },
          async retireManagedDevice() {
            throw new Error("write should not run");
          },
          async request() {
            called = true;
            return { value: [] };
          },
        }),
      });

      const result = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/me/messages",
      });

      assert.ok(result.trace.error, "reading mail must be refused");
      assert.match(result.trace.error ?? "", /was not granted/);
      assert.equal(called, false, "no Graph call may be made for a refused endpoint");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still rejects a path that does not exist in the catalog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-bogus-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/totallyMadeUpThing",
      });
      assert.match(result.trace.error ?? "", /Unknown Microsoft Graph GET path/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an empty query result is not evidence of an empty tenant", () => {
  it("reports the unfiltered row count when a filter matches nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-empty-"));
    const store = seededStore(dir, 9);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        where: { operatingSystem: "SolarisNotAThing" },
      });
      const record = result.result as {
        returnedRows: number;
        cachedRowsForResource: number;
        availableFields?: string[];
        note: string;
      };
      assert.equal(record.returnedRows, 0);
      assert.equal(
        record.cachedRowsForResource,
        9,
        "the model must be told the resource is populated, or it reports the tenant as empty",
      );
      assert.match(record.note, /not an empty tenant/i);
      assert.match(
        result.trace.resultSummary,
        /9 rows are cached/,
        "the summary must not read as an empty cache when only the filter missed",
      );
      assert.ok(record.availableFields?.includes("operatingSystem"));
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes an uncached resource from an empty one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-uncached-"));
    const store = seededStore(dir, 9);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "users",
      });
      const record = result.result as { cachedRowsForResource: number; note: string };
      assert.equal(record.cachedRowsForResource, 0);
      assert.match(record.note, /Nothing is cached/i);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cached rows advertise the fields available to filter on", () => {
  it("lists field names on a successful query, not only after one fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-fields-"));
    const store = seededStore(dir, 5);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        limit: 3,
      });
      const record = result.result as {
        returnedRows: number;
        availableFields?: string[];
      };
      assert.ok(record.returnedRows > 0);
      assert.ok(
        record.availableFields?.includes("complianceState"),
        `fields must be advertised on a successful read; got ${JSON.stringify(record.availableFields)}`,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cache inventory lean, since it covers every resource at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-fields-inv-"));
    const store = seededStore(dir, 5);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "list_cached_resources", {});
      const record = result.result as {
        resources: Array<{ resource: string; availableFields?: string[] }>;
      };
      assert.ok(record.resources.length > 10);
      assert.ok(
        record.resources.every((entry) => entry.availableFields === undefined),
        "field lists across every resource make this observation too expensive",
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('rejects invented or malformed filters, preserves optional fields, and handles null as unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cache-filter-guards-'));
  const store = seededStore(dir, 2);
  try {
    const ctx = toolContext(store);
    for (const params of [
      { where: { deviceEncryptionState: 'unencrypted', platform: 'Windows' } },
      { where: { isEncrypted: 'false' } },
      { filters: ['isEncrypted=false'] },
      { filters: { isEncrypted: false } },
      { where: { isEncrypted: {} } },
      { filters: Array.from({ length: 9 }, () => ({ field: 'id', op: 'eq', value: 'device-1' })) },
      { sort: { field: 'platform' } },
      { filter: { isEncrypted: false } },
      { where: { isEncrypted: false }, select: ['platform'] },
    ]) {
      const result = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', ...params });
      assert.equal((result.result as { code: string }).code, 'invalid-cache-query', JSON.stringify(params));
      assert.ok(result.trace.error);
      assert.equal((result.result as { totalCount?: number }).totalCount, undefined);
    }
    // isEncrypted is a supported selected field even when every record omits it.
    const unknown = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', where: { isEncrypted: null } });
    assert.equal(unknown.trace.error, undefined);
    assert.equal((unknown.result as { totalCount: number }).totalCount, 2);
    const known = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', filters: [{ field: 'isEncrypted', op: 'neq', value: null }] });
    assert.equal((known.result as { totalCount: number }).totalCount, 0);
    assert.doesNotMatch((known.result as { note: string }).note, /field or value that does not exist/);
    assert.ok((known.result as { snapshot: unknown }).snapshot);
    store.replaceGraphResources({ tenantId: 'tenant-1', resource: 'managedDevices', label: 'Devices', scopeSet: [], refreshedAt: new Date().toISOString(), rows: [{ id: 'first' }, { id: 'second', optionalField: 'present' }] });
    const optional = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', where: { optionalField: 'present' } });
    assert.equal(optional.trace.error, undefined);
    assert.equal((optional.result as { totalCount: number }).totalCount, 1);
    store.replaceGraphResources({ tenantId: 'tenant-1', resource: 'users', label: 'Users', scopeSet: [], refreshedAt: new Date().toISOString(), rows: [{ id: 'user-1', accountEnabled: false }] });
    const invalidBoolean = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'users', where: { accountEnabled: 'false' } });
    assert.match(invalidBoolean.trace.error!, /boolean field/);
    const validBoolean = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'users', where: { accountEnabled: false } });
    assert.equal((validBoolean.result as { totalCount: number }).totalCount, 1);

  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
