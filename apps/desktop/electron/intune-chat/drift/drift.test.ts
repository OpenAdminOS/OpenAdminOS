import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { IntelligenceSqliteStore } from "../sqlite-store.js";
import { canonicalDriftJson, driftContentHash } from "./canonical.js";
import {
  diffDriftObjects,
  isTimestampOnlyChange,
  summarizeDriftChanges,
  type DriftFieldChange,
} from "./diff.js";
import { DRIFT_TRACKED_RESOURCES } from "./tracked-resources.js";

describe("tenant drift tracking", () => {
  it("canonicalizes drift JSON with stable key order and ignored OData volatility", () => {
    const resource = "deviceCompliancePolicies";
    const first = canonicalDriftJson(
      {
        b: 2,
        "@odata.etag": "etag-1",
        nested: {
          z: 1,
          "@odata.context": "context",
          "@odata.nextLink": "next",
          "@odata.type": "#microsoft.graph.deviceCompliancePolicy",
        },
        a: 1,
      },
      resource,
    );
    const second = canonicalDriftJson(
      {
        a: 1,
        nested: {
          "@odata.type": "#microsoft.graph.deviceCompliancePolicy",
          z: 1,
          "@odata.etag": "etag-2",
        },
        b: 2,
      },
      resource,
    );

    assert.equal(
      first,
      '{"a":1,"b":2,"nested":{"@odata.type":"#microsoft.graph.deviceCompliancePolicy","z":1}}',
    );
    assert.equal(first, second);
  });

  it("hashes drift content stably while keeping @odata.type sensitive", () => {
    const resource = "configurationPolicies";
    const base = {
      id: "policy-1",
      displayName: "Baseline",
      "@odata.etag": "etag-1",
      "@odata.type": "#microsoft.graph.deviceManagementConfigurationPolicy",
    };

    assert.equal(
      driftContentHash(base, resource),
      driftContentHash({ ...base, "@odata.etag": "etag-2" }, resource),
    );
    assert.notEqual(
      driftContentHash(base, resource),
      driftContentHash({ ...base, displayName: "Changed" }, resource),
    );
    assert.notEqual(
      driftContentHash(base, resource),
      driftContentHash(
        { ...base, "@odata.type": "#microsoft.graph.otherPolicy" },
        resource,
      ),
    );
  });

  it("diffs field, nested, array, added, and removed changes deterministically", () => {
    const resource = "conditionalAccessPolicies";
    const changes = diffDriftObjects(
      {
        displayName: "Require MFA",
        isEnabled: true,
        assignments: [
          { target: { groupId: "group-1" } },
          { target: { groupId: "group-2" } },
        ],
        conditions: { users: { includeUsers: ["all"], excludeUsers: ["break-glass"] } },
      },
      {
        displayName: "Require MFA for admins",
        isEnabled: false,
        assignments: [
          { target: { groupId: "group-1" } },
          { target: { groupId: "group-3" } },
          { target: { groupId: "group-4" } },
        ],
        conditions: { users: { includeUsers: ["all"] } },
        sessionControls: { signInFrequency: "8h" },
      },
      resource,
    );

    assert.deepEqual(changes, [
      {
        path: "assignments[1].target.groupId",
        kind: "changed",
        before: "group-2",
        after: "group-3",
      },
      {
        path: "assignments[2]",
        kind: "added",
        after: { target: { groupId: "group-4" } },
      },
      {
        path: "conditions.users.excludeUsers",
        kind: "removed",
        before: ["break-glass"],
      },
      {
        path: "displayName",
        kind: "changed",
        before: "Require MFA",
        after: "Require MFA for admins",
      },
      { path: "isEnabled", kind: "changed", before: true, after: false },
      {
        path: "sessionControls",
        kind: "added",
        after: { signInFrequency: "8h" },
      },
    ]);
  });

  it("detects timestamp-only changes and summarizes field paths", () => {
    const resource = "deviceConfigurations";
    const timestampChanges = diffDriftObjects(
      { id: "profile-1", modifiedDateTime: "2026-06-01T00:00:00.000Z" },
      { id: "profile-1", modifiedDateTime: "2026-06-02T00:00:00.000Z" },
      resource,
    );
    assert.equal(isTimestampOnlyChange(timestampChanges), true);
    assert.equal(
      isTimestampOnlyChange([
        ...timestampChanges,
        { path: "displayName", kind: "changed", before: "A", after: "B" },
      ]),
      false,
    );

    const summaryChanges: DriftFieldChange[] = [
      { path: "displayName", kind: "changed", before: "A", after: "B" },
      { path: "assignments[1].target", kind: "changed", before: "old", after: "new" },
      { path: "isEnabled", kind: "changed", before: true, after: false },
    ];
    assert.equal(
      summarizeDriftChanges(summaryChanges),
      "3 fields changed: displayName, assignments[1].target, isEnabled",
    );
  });

  it("captures baseline, modified, removed, reappeared, and zero-change refreshes", async () => {
    await withStore(async (store) => {
      assert.equal(DRIFT_TRACKED_RESOURCES.has("deviceCompliancePolicies"), true);
      const tenantId = "tenant-drift";
      const scopeSet = ["DeviceManagementConfiguration.Read.All"];
      const baselineAt = "2026-06-01T10:00:00.000Z";
      const baselineRows = [
        { id: "policy-1", displayName: "Policy One", setting: { value: "A" } },
        { id: "policy-2", displayName: "Policy Two", setting: { value: "B" } },
      ];

      store.replaceGraphResources({
        tenantId,
        resource: "deviceCompliancePolicies",
        label: "Device compliance policies",
        scopeSet,
        refreshedAt: baselineAt,
        rows: baselineRows,
      });

      let snapshots = store.listDriftSnapshots(tenantId, {
        resource: "deviceCompliancePolicies",
      });
      assert.equal(snapshots.length, 1);
      assert.deepEqual(
        {
          rowCount: snapshots[0]?.rowCount,
          added: snapshots[0]?.changesAdded,
          removed: snapshots[0]?.changesRemoved,
          modified: snapshots[0]?.changesModified,
        },
        { rowCount: 2, added: 0, removed: 0, modified: 0 },
      );
      assert.deepEqual(store.listDriftChangesForSnapshot(tenantId, snapshots[0]?.id ?? ""), []);
      assert.deepEqual(
        store
          .getDriftObjectHistory(tenantId, "deviceCompliancePolicies", "policy-1")
          .map((version) => version.version),
        [1],
      );

      store.replaceGraphResources({
        tenantId,
        resource: "deviceCompliancePolicies",
        label: "Device compliance policies",
        scopeSet,
        refreshedAt: "2026-06-01T10:05:00.000Z",
        rows: baselineRows,
      });
      assert.equal(
        store.listDriftSnapshots(tenantId, { resource: "deviceCompliancePolicies" }).length,
        1,
      );

      store.replaceGraphResources({
        tenantId,
        resource: "deviceCompliancePolicies",
        label: "Device compliance policies",
        scopeSet,
        refreshedAt: "2026-06-01T10:10:00.000Z",
        rows: [
          { id: "policy-1", displayName: "Policy One", setting: { value: "changed" } },
          baselineRows[1],
        ],
      });
      snapshots = store.listDriftSnapshots(tenantId, {
        resource: "deviceCompliancePolicies",
      });
      const modifiedSnapshot = snapshots[0];
      assert.ok(modifiedSnapshot);
      assert.deepEqual(
        {
          added: modifiedSnapshot.changesAdded,
          removed: modifiedSnapshot.changesRemoved,
          modified: modifiedSnapshot.changesModified,
        },
        { added: 0, removed: 0, modified: 1 },
      );
      assert.deepEqual(
        store
          .getDriftObjectHistory(tenantId, "deviceCompliancePolicies", "policy-1")
          .map((version) => version.version),
        [2, 1],
      );
      const modifiedChanges = store.listDriftChangesForSnapshot(
        tenantId,
        modifiedSnapshot.id,
      );
      assert.equal(modifiedChanges.length, 1);
      assert.equal(modifiedChanges[0]?.kind, "modified");
      assert.equal(
        parseRaw(modifiedChanges[0]?.currentRawJson).setting.value,
        "changed",
      );

      store.replaceGraphResources({
        tenantId,
        resource: "deviceCompliancePolicies",
        label: "Device compliance policies",
        scopeSet,
        refreshedAt: "2026-06-01T10:20:00.000Z",
        rows: [
          { id: "policy-1", displayName: "Policy One", setting: { value: "changed" } },
        ],
      });
      snapshots = store.listDriftSnapshots(tenantId, {
        resource: "deviceCompliancePolicies",
      });
      const removedSnapshot = snapshots[0];
      assert.ok(removedSnapshot);
      assert.deepEqual(
        {
          added: removedSnapshot.changesAdded,
          removed: removedSnapshot.changesRemoved,
          modified: removedSnapshot.changesModified,
        },
        { added: 0, removed: 1, modified: 0 },
      );
      const policyTwoRemoved = store.getDriftObjectHistory(
        tenantId,
        "deviceCompliancePolicies",
        "policy-2",
      );
      assert.equal(policyTwoRemoved[0]?.removedAt, "2026-06-01T10:20:00.000Z");
      assert.equal(
        store.listDriftChangesForSnapshot(tenantId, removedSnapshot.id)[0]?.kind,
        "removed",
      );

      store.replaceGraphResources({
        tenantId,
        resource: "deviceCompliancePolicies",
        label: "Device compliance policies",
        scopeSet,
        refreshedAt: "2026-06-01T10:30:00.000Z",
        rows: [
          { id: "policy-1", displayName: "Policy One", setting: { value: "changed" } },
          { id: "policy-2", displayName: "Policy Two Returned", setting: { value: "C" } },
        ],
      });
      snapshots = store.listDriftSnapshots(tenantId, {
        resource: "deviceCompliancePolicies",
      });
      const reappearedSnapshot = snapshots[0];
      assert.ok(reappearedSnapshot);
      assert.deepEqual(
        {
          added: reappearedSnapshot.changesAdded,
          removed: reappearedSnapshot.changesRemoved,
          modified: reappearedSnapshot.changesModified,
        },
        { added: 1, removed: 0, modified: 0 },
      );
      assert.deepEqual(
        store
          .getDriftObjectHistory(tenantId, "deviceCompliancePolicies", "policy-2")
          .map((version) => version.version),
        [2, 1],
      );
      assert.equal(
        store.listDriftChangesForSnapshot(tenantId, reappearedSnapshot.id)[0]?.kind,
        "added",
      );
    });
  });

  it("prunes old snapshots and stale versions while preserving live current versions", async () => {
    await withStore(async (store) => {
      const tenantId = "tenant-retention";
      const resource = "configurationPolicies";
      const scopeSet = ["DeviceManagementConfiguration.Read.All"];

      store.replaceGraphResources({
        tenantId,
        resource,
        label: "Settings catalog policies",
        scopeSet,
        refreshedAt: "2000-01-01T00:00:00.000Z",
        rows: [
          { id: "live", displayName: "Live policy", value: "same" },
          { id: "modified", displayName: "Modified policy", value: "old" },
          { id: "removed", displayName: "Removed policy", value: "gone" },
        ],
      });
      store.replaceGraphResources({
        tenantId,
        resource,
        label: "Settings catalog policies",
        scopeSet,
        refreshedAt: "2000-01-02T00:00:00.000Z",
        rows: [
          { id: "live", displayName: "Live policy", value: "same" },
          { id: "modified", displayName: "Modified policy", value: "new" },
        ],
      });

      const result = store.pruneDriftHistory(tenantId, 1);
      assert.deepEqual(result, { snapshotsDeleted: 2, versionsDeleted: 2 });
      assert.equal(store.listDriftSnapshots(tenantId, { resource }).length, 0);
      assert.deepEqual(
        store.getDriftObjectHistory(tenantId, resource, "live").map((row) => row.version),
        [1],
      );
      assert.deepEqual(
        store
          .getDriftObjectHistory(tenantId, resource, "modified")
          .map((row) => row.version),
        [2],
      );
      assert.deepEqual(store.getDriftObjectHistory(tenantId, resource, "removed"), []);
    });
  });

  it("does not write drift rows for untracked high-churn resources", async () => {
    await withStore(async (store) => {
      store.replaceGraphResources({
        tenantId: "tenant-inventory",
        resource: "managedDevices",
        label: "Intune managed devices",
        scopeSet: ["DeviceManagementManagedDevices.Read.All"],
        refreshedAt: "2026-06-01T10:00:00.000Z",
        rows: [{ id: "device-1", deviceName: "WIN-01" }],
      });

      assert.equal(store.listDriftSnapshots("tenant-inventory").length, 0);
      assert.deepEqual(
        store.getDriftObjectHistory(
          "tenant-inventory",
          "managedDevices",
          "device-1",
        ),
        [],
      );
    });
  });
});

async function withStore(
  run: (store: IntelligenceSqliteStore) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-drift-"));
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  try {
    await run(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function parseRaw(raw: string | undefined): {
  setting: { value: string };
} {
  if (typeof raw !== "string") {
    throw new Error("Expected drift raw JSON.");
  }
  return JSON.parse(raw) as { setting: { value: string } };
}
