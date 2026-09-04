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

describe("named drift baselines", () => {
  const RESOURCE = "configurationPolicies" as const;
  const SCOPES = ["DeviceManagementConfiguration.Read.All"];

  function refresh(
    store: IntelligenceSqliteStore,
    refreshedAt: string,
    rows: Array<Record<string, unknown>>,
  ): void {
    store.replaceGraphResources({
      tenantId: "tenant-1",
      resource: RESOURCE,
      label: "Settings catalog policies",
      scopeSet: SCOPES,
      refreshedAt,
      rows,
    });
  }

  it("creates, lists, renames, and retires a baseline with one-active enforcement", async () => {
    await withDriftService(async ({ service, store }) => {
      refresh(store, "2026-08-29T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "A" },
        { id: "policy-2", displayName: "Policy Two", setting: "B" },
      ]);

      const created = await service.createBaseline({
        tenantId: "tenant-1",
        name: "  Golden   config ",
      });
      assert.equal(created.name, "Golden config");
      assert.equal(created.status, "active");
      assert.equal(created.pinnedObjectCount, 2);
      assert.deepEqual(created.resources, [RESOURCE]);

      await assert.rejects(
        service.createBaseline({ tenantId: "tenant-1", name: "Second" }),
        /active baseline already exists/i,
      );

      const renamed = await service.renameBaseline({
        tenantId: "tenant-1",
        baselineId: created.id,
        name: "Approved config",
      });
      assert.equal(renamed.name, "Approved config");

      const retired = await service.retireBaseline({
        tenantId: "tenant-1",
        baselineId: created.id,
      });
      assert.equal(retired.status, "retired");
      assert.ok(retired.retiredAt);

      const replacement = await service.createBaseline({
        tenantId: "tenant-1",
        name: "Second",
      });
      assert.equal(replacement.status, "active");
      const listed = await service.listBaselines({ tenantId: "tenant-1" });
      assert.equal(listed.length, 2);
    });
  });

  it("refuses to create a baseline before any tracked capture exists", async () => {
    await withDriftService(async ({ service }) => {
      await assert.rejects(
        service.createBaseline({ tenantId: "tenant-1", name: "Too early" }),
        /Refresh the tenant cache first/i,
      );
    });
  });

  it("reports added, removed, and modified drift against the active baseline", async () => {
    await withDriftService(async ({ service, store }) => {
      refresh(store, "2026-08-29T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "A" },
        { id: "policy-2", displayName: "Policy Two", setting: "B" },
      ]);
      await service.createBaseline({ tenantId: "tenant-1", name: "Golden" });

      refresh(store, "2026-08-29T11:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "CHANGED" },
        { id: "policy-3", displayName: "Policy Three", setting: "C" },
      ]);

      const drift = await service.getBaselineDrift({ tenantId: "tenant-1" });
      assert.equal(drift.baseline.name, "Golden");
      const resourceDrift = drift.resources.find((entry) => entry.resource === RESOURCE);
      assert.deepEqual(
        {
          added: resourceDrift?.added,
          removed: resourceDrift?.removed,
          modified: resourceDrift?.modified,
        },
        { added: 1, removed: 1, modified: 1 },
      );

      const byKind = new Map(drift.entries.map((entry) => [entry.changeKind, entry]));
      assert.equal(byKind.get("added")?.graphId, "policy-3");
      assert.equal(byKind.get("removed")?.graphId, "policy-2");
      const modified = byKind.get("modified");
      assert.equal(modified?.graphId, "policy-1");
      const settingChange = modified?.changes.find((change) => change.path === "setting");
      assert.equal(settingChange?.before, "A");
      assert.equal(settingChange?.after, "CHANGED");
    });
  });

  it("keeps pinned versions through retention pruning while the baseline is active", async () => {
    await withDriftService(async ({ service, store }) => {
      refresh(store, "2026-08-01T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "A" },
      ]);
      const baseline = await service.createBaseline({
        tenantId: "tenant-1",
        name: "Golden",
      });
      refresh(store, "2026-08-02T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "B" },
      ]);

      // Zero-day retention would normally delete every superseded version.
      store.pruneDriftHistory("tenant-1", 0);
      const protectedDrift = await service.getBaselineDrift({ tenantId: "tenant-1" });
      const modified = protectedDrift.entries.find(
        (entry) => entry.changeKind === "modified",
      );
      const settingChange = modified?.changes.find((change) => change.path === "setting");
      assert.equal(settingChange?.before, "A", "pinned version must survive pruning");

      await service.retireBaseline({
        tenantId: "tenant-1",
        baselineId: baseline.id,
      });
      const afterRetire = store.pruneDriftHistory("tenant-1", 0);
      assert.ok(
        afterRetire.versionsDeleted >= 1,
        "retired baselines no longer protect superseded versions",
      );
    });
  });
});

describe("point-in-time compare", () => {
  const RESOURCE = "configurationPolicies" as const;

  function refresh(
    store: IntelligenceSqliteStore,
    refreshedAt: string,
    rows: Array<Record<string, unknown>>,
  ): void {
    store.replaceGraphResources({
      tenantId: "tenant-1",
      resource: RESOURCE,
      label: "Settings catalog policies",
      scopeSet: ["DeviceManagementConfiguration.Read.All"],
      refreshedAt,
      rows,
    });
  }

  it("diffs the reconstructed states at two moments", async () => {
    await withDriftService(async ({ service, store }) => {
      refresh(store, "2026-08-10T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "A" },
        { id: "policy-2", displayName: "Policy Two", setting: "B" },
      ]);
      refresh(store, "2026-08-15T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "CHANGED" },
        { id: "policy-3", displayName: "Policy Three", setting: "C" },
      ]);
      refresh(store, "2026-08-20T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "CHANGED AGAIN" },
        { id: "policy-3", displayName: "Policy Three", setting: "C" },
      ]);

      // Between capture 1 and capture 2: policy-1 modified, policy-2
      // removed, policy-3 added. Capture 3 is after the window and must
      // not leak into the "to" side.
      const compare = await service.getTimeCompare({
        tenantId: "tenant-1",
        from: "2026-08-10T12:00:00.000Z",
        to: "2026-08-15T12:00:00.000Z",
      });
      const counts = compare.resources.find((entry) => entry.resource === RESOURCE);
      assert.deepEqual(
        { added: counts?.added, removed: counts?.removed, modified: counts?.modified },
        { added: 1, removed: 1, modified: 1 },
      );
      const modified = compare.entries.find((entry) => entry.changeKind === "modified");
      const settingChange = modified?.changes.find((change) => change.path === "setting");
      assert.equal(settingChange?.before, "A");
      assert.equal(settingChange?.after, "CHANGED");
      assert.equal(compare.retentionLimited, undefined);

      const identical = await service.getTimeCompare({
        tenantId: "tenant-1",
        from: "2026-08-15T12:00:00.000Z",
        to: "2026-08-15T13:00:00.000Z",
      });
      assert.equal(identical.entries.length, 0);
    });
  });

  it("flags retention-limited windows and rejects inverted ranges", async () => {
    await withDriftService(async ({ service, store }) => {
      refresh(store, "2026-08-10T10:00:00.000Z", [
        { id: "policy-1", displayName: "Policy One", setting: "A" },
      ]);
      const limited = await service.getTimeCompare({
        tenantId: "tenant-1",
        from: "2026-08-01T00:00:00.000Z",
        to: "2026-08-15T00:00:00.000Z",
      });
      assert.equal(limited.retentionLimited, true);

      await assert.rejects(
        service.getTimeCompare({
          tenantId: "tenant-1",
          from: "2026-08-15T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
        }),
        /from moment to be before/i,
      );
    });
  });
});

describe("baseline export and bundle compare", () => {
  it("exports pinned objects with tenant fields stripped and compares them elsewhere", async () => {
    await withDriftService(async ({ service, store }) => {
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "configurationPolicies",
        label: "Settings catalog policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
        refreshedAt: "2026-08-29T10:00:00.000Z",
        rows: [
          {
            id: "p-1",
            displayName: "Golden policy",
            setting: "A",
            lastModifiedDateTime: "2026-01-01T00:00:00Z",
          },
        ],
      });
      await service.createBaseline({ tenantId: "tenant-1", name: "Golden" });

      const bundle = await service.buildBaselineExport({ tenantId: "tenant-1" });
      assert.equal(bundle.format, "openadminos-baseline-export");
      assert.equal(bundle.baselineName, "Golden");
      assert.equal(bundle.sourceTenantName, "Contoso");
      const objects = bundle.resources.find(
        (entry) => entry.resource === "configurationPolicies",
      )?.objects;
      assert.equal(objects?.length, 1);
      assert.equal(objects?.[0]?.body.setting, "A");
      assert.equal(objects?.[0]?.body.id, undefined);
      assert.equal(objects?.[0]?.body.lastModifiedDateTime, undefined);

      // The second tenant has a same-named but different policy plus an
      // extra one; compare it against the exported bundle.
      store.replaceGraphResources({
        tenantId: "tenant-2",
        resource: "configurationPolicies",
        label: "Settings catalog policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
        refreshedAt: "2026-08-29T11:00:00.000Z",
        rows: [
          { id: "q-1", displayName: "Golden policy", setting: "B" },
          { id: "q-2", displayName: "Extra policy", setting: "C" },
        ],
      });
      const compare = await service.compareTenantToBundle({
        tenantId: "tenant-2",
        bundle,
      });
      assert.equal(compare.tenantHasData, true);
      assert.equal(compare.baselineName, "Golden");
      const counts = compare.resources.find(
        (entry) => entry.resource === "configurationPolicies",
      );
      assert.deepEqual(
        {
          matchedSame: counts?.matchedSame,
          different: counts?.different,
          onlyInA: counts?.onlyInA,
          onlyInB: counts?.onlyInB,
        },
        { matchedSame: 0, different: 1, onlyInA: 1, onlyInB: 0 },
      );
      const different = compare.entries.find((entry) => entry.bucket === "different");
      const settingChange = different?.changes.find(
        (change) => change.path === "setting",
      );
      assert.equal(settingChange?.before, "B");
      assert.equal(settingChange?.after, "A");
    });
  });

  it("rejects files that are not baseline exports", async () => {
    await withDriftService(async ({ service }) => {
      await assert.rejects(
        service.compareTenantToBundle({
          tenantId: "tenant-1",
          bundle: {
            format: "something-else",
          } as never,
        }),
        /not an OpenAdminOS baseline export/,
      );
    });
  });
});

describe("fleet drift status", () => {
  it("reports per-tenant baseline drift counts and no-baseline tenants honestly", async () => {
    await withDriftService(async ({ service, store }) => {
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "configurationPolicies",
        label: "Settings catalog policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
        refreshedAt: "2026-08-29T10:00:00.000Z",
        rows: [{ id: "p-1", displayName: "One", setting: "A" }],
      });
      await service.createBaseline({ tenantId: "tenant-1", name: "Golden" });
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "configurationPolicies",
        label: "Settings catalog policies",
        scopeSet: ["DeviceManagementConfiguration.Read.All"],
        refreshedAt: "2026-08-29T11:00:00.000Z",
        rows: [{ id: "p-1", displayName: "One", setting: "B" }],
      });

      const fleet = await service.getFleetDriftStatus({});
      const first = fleet.tenants.find((entry) => entry.tenantId === "tenant-1");
      const second = fleet.tenants.find((entry) => entry.tenantId === "tenant-2");
      assert.equal(first?.baseline?.name, "Golden");
      assert.deepEqual(
        {
          added: first?.drift?.added,
          removed: first?.drift?.removed,
          modified: first?.drift?.modified,
        },
        { added: 0, removed: 0, modified: 1 },
      );
      assert.ok(first?.lastCaptureAt);
      assert.equal(second?.baseline, undefined);
      assert.equal(second?.drift, undefined);

      await assert.rejects(
        service.getFleetDriftStatus({ groupId: "missing-group" }),
        /Tenant group was not found/,
      );
    });
  });
});

describe("cross-tenant compare", () => {
  const RESOURCE = "configurationPolicies" as const;

  function refreshTenant(
    store: IntelligenceSqliteStore,
    tenantId: string,
    rows: Array<Record<string, unknown>>,
  ): void {
    store.replaceGraphResources({
      tenantId,
      resource: RESOURCE,
      label: "Settings catalog policies",
      scopeSet: ["DeviceManagementConfiguration.Read.All"],
      refreshedAt: "2026-08-29T10:00:00.000Z",
      rows,
    });
  }

  it("matches by unique name, ignores tenant-specific fields, and buckets the rest", async () => {
    await withDriftService(async ({ service, store }) => {
      refreshTenant(store, "tenant-1", [
        {
          id: "a-1",
          displayName: "BitLocker policy",
          setting: "on",
          lastModifiedDateTime: "2026-01-01T00:00:00Z",
          assignments: [{ target: "group-contoso" }],
        },
        { id: "a-2", displayName: "Contoso only", setting: "x" },
        { id: "a-3", displayName: "Firewall policy", setting: "strict" },
      ]);
      refreshTenant(store, "tenant-2", [
        {
          id: "b-1",
          displayName: "BitLocker policy",
          setting: "on",
          lastModifiedDateTime: "2026-05-05T00:00:00Z",
          assignments: [{ target: "group-fabrikam" }],
        },
        { id: "b-2", displayName: "Fabrikam only", setting: "y" },
        { id: "b-3", displayName: "Firewall policy", setting: "loose" },
      ]);

      const compare = await service.getTenantCompare({
        tenantIdA: "tenant-1",
        tenantIdB: "tenant-2",
        resources: [RESOURCE],
      });
      const counts = compare.resources.find((entry) => entry.resource === RESOURCE);
      assert.deepEqual(
        {
          matchedSame: counts?.matchedSame,
          different: counts?.different,
          onlyInA: counts?.onlyInA,
          onlyInB: counts?.onlyInB,
          ambiguous: counts?.ambiguous,
        },
        // BitLocker matches as SAME: id, timestamps, and assignments are
        // tenant-specific and excluded by default.
        { matchedSame: 1, different: 1, onlyInA: 1, onlyInB: 1, ambiguous: 0 },
      );
      const different = compare.entries.find((entry) => entry.bucket === "different");
      assert.equal(different?.displayName, "Firewall policy");
      const settingChange = different?.changes.find((change) => change.path === "setting");
      assert.equal(settingChange?.before, "strict");
      assert.equal(settingChange?.after, "loose");

      // Opting into assignments makes BitLocker different.
      const withAssignments = await service.getTenantCompare({
        tenantIdA: "tenant-1",
        tenantIdB: "tenant-2",
        resources: [RESOURCE],
        includeAssignments: true,
      });
      const countsWith = withAssignments.resources.find(
        (entry) => entry.resource === RESOURCE,
      );
      assert.equal(countsWith?.matchedSame, 0);
      assert.equal(countsWith?.different, 2);
    });
  });

  it("counts duplicate names as ambiguous and reports missing tenant data", async () => {
    await withDriftService(async ({ service, store }) => {
      refreshTenant(store, "tenant-1", [
        { id: "a-1", displayName: "Twin", setting: "1" },
        { id: "a-2", displayName: "Twin", setting: "2" },
        { id: "a-3", displayName: "Unique", setting: "3" },
      ]);

      const compare = await service.getTenantCompare({
        tenantIdA: "tenant-1",
        tenantIdB: "tenant-2",
        resources: [RESOURCE],
      });
      const counts = compare.resources.find((entry) => entry.resource === RESOURCE);
      assert.equal(counts?.ambiguous, 2);
      assert.equal(counts?.onlyInA, 1);
      assert.equal(compare.tenantAHasData, true);
      assert.equal(compare.tenantBHasData, false);

      await assert.rejects(
        service.getTenantCompare({ tenantIdA: "tenant-1", tenantIdB: "tenant-1" }),
        /two different tenants/i,
      );
    });
  });
});

async function withDriftService(
  run: (input: {
    service: DriftService;
    store: IntelligenceSqliteStore;
  }) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-drift-service-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  const persisted: DriftPersistedState = {
    tenants: [tenant, secondTenant],
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
    createDriftBaseline: (input) => store.createDriftBaseline(input),
    listDriftBaselines: (tenantId) => store.listDriftBaselines(tenantId),
    getDriftBaseline: (tenantId, baselineId) =>
      store.getDriftBaseline(tenantId, baselineId),
    getActiveDriftBaseline: (tenantId) => store.getActiveDriftBaseline(tenantId),
    renameDriftBaseline: (tenantId, baselineId, name) =>
      store.renameDriftBaseline(tenantId, baselineId, name),
    retireDriftBaseline: (tenantId, baselineId, now) =>
      store.retireDriftBaseline(tenantId, baselineId, now),
    listDriftBaselineChanges: (input) => store.listDriftBaselineChanges(input),
    readDriftStateAt: (tenantId, resource, atIso) =>
      store.readDriftStateAt(tenantId, resource, atIso),
    getOldestDriftSnapshotAt: (tenantId, resource) =>
      store.getOldestDriftSnapshotAt(tenantId, resource),
    countDriftBaselineChanges: (input) => store.countDriftBaselineChanges(input),
    listTenantGroups: () => store.listTenantGroups(),
    listDriftBaselinePinnedObjects: (input) =>
      store.listDriftBaselinePinnedObjects(input),
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

const secondTenant: TenantRecord = {
  id: "tenant-2",
  displayName: "Fabrikam",
  username: "admin@fabrikam.example",
  homeAccountId: "home-account-2",
  addedAt: "2026-07-05T09:00:00.000Z",
};
