import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TenantRecord } from "@openadminos/agent-sdk";
import { definitionForResource } from "../planner.js";
import { IntelligenceSqliteStore } from "../sqlite-store.js";
import { DriftService, type DriftPersistedState } from "./service.js";

describe("drift service", () => {
  it("returns a capped newest-first timeline with hasMore and a baseline meta entry", async () => {
    await withDriftService(async ({ service, store }) => {
      seedTimeline(store);

      const capped = await service.getDriftTimeline({
        tenantId: "tenant-1",
        resources: ["configurationPolicies"],
        limit: 2,
      });
      assert.equal(capped.entries.length, 2);
      assert.equal(capped.hasMore, true);
      assert.deepEqual(
        capped.entries.map((entry) => entry.changeKind),
        ["removed", "added"],
      );

      const full = await service.getDriftTimeline({
        tenantId: "tenant-1",
        resources: ["configurationPolicies"],
        limit: 10,
      });
      const baseline = full.entries.find((entry) => entry.changeKind === "baseline");
      assert.ok(baseline);
      assert.equal(baseline.rowCount, 2);
      assert.equal(baseline.resourceLabel, "Settings catalog policies");
      assert.equal(baseline.graphId, undefined);

      const searched = await service.getDriftTimeline({
        tenantId: "tenant-1",
        resources: ["configurationPolicies"],
        query: "policy two",
        limit: 10,
      });
      assert.ok(searched.entries.length > 0);
      assert.ok(
        searched.entries.every((entry) =>
          `${entry.displayName ?? ""} ${entry.graphId ?? ""}`.toLowerCase().includes("policy-2") ||
          (entry.displayName ?? "").toLowerCase().includes("policy two"),
        ),
      );
    });
  });

  it("omits oversized before/after bodies while keeping field changes", async () => {
    await withDriftService(async ({ service, store }) => {
      const tenantId = "tenant-1";
      const resource = "configurationPolicies";
      const blob = "x".repeat(50_000);
      store.replaceGraphResources({
        tenantId,
        resource,
        label: "Settings catalog policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
        refreshedAt: "2026-07-05T10:00:00.000Z",
        rows: [
          {
            id: "policy-large",
            displayName: "Large policy",
            blob,
            setting: "old",
          },
        ],
      });
      const baseline = store.listDriftSnapshots(tenantId, { resource })[0];
      assert.ok(baseline);
      store.replaceGraphResources({
        tenantId,
        resource,
        label: "Settings catalog policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
        refreshedAt: "2026-07-05T10:05:00.000Z",
        rows: [
          {
            id: "policy-large",
            displayName: "Large policy",
            blob,
            setting: "new",
          },
        ],
      });
      const snapshot = store.listDriftSnapshots(tenantId, { resource })[0];
      assert.ok(snapshot);

      const detail = await service.getDriftEntryDetail({
        tenantId,
        snapshotId: snapshot.id,
        resource,
        graphId: "policy-large",
      });

      assert.equal(detail.truncated, true);
      assert.equal(Object.prototype.hasOwnProperty.call(detail, "before"), false);
      assert.equal(Object.prototype.hasOwnProperty.call(detail, "after"), false);
      assert.deepEqual(detail.changes, [
        { path: "setting", kind: "changed", before: "old", after: "new" },
      ]);
    });
  });

  it("returns object history without raw bodies", async () => {
    await withDriftService(async ({ service, store }) => {
      seedTimeline(store);

      const history = await service.getDriftObjectHistory({
        tenantId: "tenant-1",
        resource: "configurationPolicies",
        graphId: "policy-1",
      });

      assert.deepEqual(
        history.versions.map((version) => version.version),
        [2, 1],
      );
      assert.equal(
        Object.prototype.hasOwnProperty.call(history.versions[0] ?? {}, "rawJson"),
        false,
      );
      assert.equal(history.versions[0]?.snapshotId.startsWith("configurationPolicies-"), true);
    });
  });

  it("reports per-resource drift status for tracked resources", async () => {
    await withDriftService(async ({ service, store }) => {
      seedTimeline(store);
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "deviceCompliancePolicies",
        label: "Device compliance policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
        refreshedAt: "2026-07-05T10:20:00.000Z",
        pageLimitReached: true,
        rows: [{ id: "compliance-1", displayName: "Compliance policy" }],
      });

      const status = await service.getDriftStatus("tenant-1");
      const configurationPolicies = status.resources.find(
        (entry) => entry.resource === "configurationPolicies",
      );

      assert.ok(configurationPolicies);
      assert.equal(configurationPolicies.resourceLabel, "Settings catalog policies");
      assert.equal(configurationPolicies.baselineCaptured, true);
      assert.equal(
        configurationPolicies.baselineCapturedAt,
        "2026-07-05T10:00:00.000Z",
      );
      assert.equal(configurationPolicies.lastSnapshotAt, "2026-07-05T10:15:00.000Z");
      assert.equal(configurationPolicies.snapshotCount, 4);
      assert.equal(configurationPolicies.totalTrackedVersions, 4);
      assert.equal(configurationPolicies.currentObjectCount, 2);

      const capped = status.resources.find(
        (entry) => entry.resource === "deviceCompliancePolicies",
      );
      assert.equal(capped?.baselineCaptured, true);
      assert.equal(capped?.pageLimitReached, true);

      const untouched = status.resources.find((entry) => entry.resource === "roleScopeTags");
      assert.equal(untouched?.baselineCaptured, false);
      assert.equal(untouched?.totalTrackedVersions, 0);
    });
  });
});

function seedTimeline(store: IntelligenceSqliteStore): void {
  const tenantId = "tenant-1";
  const resource = "configurationPolicies";
  const scopeSet = ["DeviceManagementConfiguration.Read.All"];
  store.replaceGraphResources({
    tenantId,
    resource,
    label: "Settings catalog policies",
    scopeSet,
    refreshedAt: "2026-07-05T10:00:00.000Z",
    rows: [
      { id: "policy-1", displayName: "Policy One", setting: "A" },
      { id: "policy-2", displayName: "Policy Two", setting: "B" },
    ],
  });
  store.replaceGraphResources({
    tenantId,
    resource,
    label: "Settings catalog policies",
    scopeSet,
    refreshedAt: "2026-07-05T10:05:00.000Z",
    rows: [
      { id: "policy-1", displayName: "Policy One", setting: "A2" },
      { id: "policy-2", displayName: "Policy Two", setting: "B" },
    ],
  });
  store.replaceGraphResources({
    tenantId,
    resource,
    label: "Settings catalog policies",
    scopeSet,
    refreshedAt: "2026-07-05T10:10:00.000Z",
    rows: [
      { id: "policy-1", displayName: "Policy One", setting: "A2" },
      { id: "policy-2", displayName: "Policy Two", setting: "B" },
      { id: "policy-3", displayName: "Policy Three", setting: "C" },
    ],
  });
  store.replaceGraphResources({
    tenantId,
    resource,
    label: "Settings catalog policies",
    scopeSet,
    refreshedAt: "2026-07-05T10:15:00.000Z",
    rows: [
      { id: "policy-1", displayName: "Policy One", setting: "A2" },
      { id: "policy-3", displayName: "Policy Three", setting: "C" },
    ],
  });
}

async function withDriftService(
  run: (input: {
    service: DriftService;
    store: IntelligenceSqliteStore;
  }) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-drift-service-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  const persisted: DriftPersistedState = {
    tenants: [tenant],
    activeTenantId: tenant.id,
  };
  const service = new DriftService({
    read: async () => persisted,
    resolveTenant(state, tenantId) {
      const resolved = state.tenants.find((entry) => entry.id === tenantId);
      if (!resolved) throw new Error("Tenant not found.");
      return resolved;
    },
    listDriftSnapshots: (tenantId, options) =>
      store.listDriftSnapshots(tenantId, options),
    getDriftSnapshot: (tenantId, snapshotId) =>
      store.getDriftSnapshot(tenantId, snapshotId),
    listDriftChangesForSnapshot: (tenantId, snapshotId) =>
      store.listDriftChangesForSnapshot(tenantId, snapshotId),
    getDriftObjectHistory: (tenantId, resource, graphId, options) =>
      store.getDriftObjectHistory(tenantId, resource, graphId, options),
    listCachedGraphResourceRows: (input) =>
      store.listCachedGraphResourceRows(input),
    getGraphCacheStatus: (tenantId, resources) =>
      store.getGraphCacheStatus(
        tenantId,
        resources.map((resource) => definitionForResource(resource)),
      ),
    getDriftResourceStats: (tenantId, resources) =>
      store.getDriftResourceStats(tenantId, resources),
  });
  try {
    await run({ service, store });
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const tenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-account-1",
  addedAt: "2026-07-05T09:00:00.000Z",
};
