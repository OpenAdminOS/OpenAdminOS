import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphCacheResourceStatus } from "@openadminos/agent-sdk";
import {
  attributeDriftChange,
  type CachedAuditRow,
  type DriftAuditCache,
} from "./attribution.js";

describe("drift audit attribution", () => {
  it("matches an Intune audit event by resourceId inside the snapshot window", () => {
    const result = attributeDriftChange({
      resource: "configurationPolicies",
      graphId: "policy-1",
      previousCapturedAt: "2026-07-05T10:00:00.000Z",
      capturedAt: "2026-07-05T10:10:00.000Z",
      auditCache: auditCache({
        intune: [
          intuneAuditRow({
            resourceId: "policy-1",
            activityDateTime: "2026-07-05T10:04:00.000Z",
            displayName: "Update device configuration policy",
            userPrincipalName: "admin@contoso.example",
          }),
        ],
      }),
    });

    assert.deepEqual(result, {
      status: "matched",
      source: "intuneAudit",
      activity: "Update device configuration policy",
      activityDateTime: "2026-07-05T10:04:00.000Z",
      actor: {
        userPrincipalName: "admin@contoso.example",
        appDisplayName: "Microsoft Intune admin center",
        actorType: "User",
      },
    });
  });

  it("chooses the closest Intune match and counts additional matches", () => {
    const result = attributeDriftChange({
      resource: "deviceCompliancePolicies",
      graphId: "policy-1",
      previousCapturedAt: "2026-07-05T10:00:00.000Z",
      capturedAt: "2026-07-05T10:10:00.000Z",
      auditCache: auditCache({
        intune: [
          intuneAuditRow({
            resourceId: "policy-1",
            activityDateTime: "2026-07-05T10:01:00.000Z",
            displayName: "Older policy update",
          }),
          intuneAuditRow({
            resourceId: "policy-1",
            activityDateTime: "2026-07-05T10:09:00.000Z",
            displayName: "Closest policy update",
          }),
        ],
      }),
    });

    assert.equal(result.status, "matched");
    assert.equal(result.source, "intuneAudit");
    assert.equal(result.activity, "Closest policy update");
    assert.equal(result.alsoMatched, 1);
  });

  it("uses directory audit fallback only when no Intune audit event matches", () => {
    const fallback = attributeDriftChange({
      resource: "conditionalAccessPolicies",
      graphId: "ca-1",
      previousCapturedAt: "2026-07-05T10:00:00.000Z",
      capturedAt: "2026-07-05T10:10:00.000Z",
      auditCache: auditCache({
        intune: [
          intuneAuditRow({
            resourceId: "other-policy",
            activityDateTime: "2026-07-05T10:08:00.000Z",
            displayName: "Unrelated Intune event",
          }),
        ],
        directory: [
          directoryAuditRow({
            targetId: "ca-1",
            activityDateTime: "2026-07-05T10:06:00.000Z",
            activityDisplayName: "Update conditional access policy",
          }),
        ],
      }),
    });

    assert.equal(fallback.status, "matched");
    assert.equal(fallback.source, "directoryAudit");
    assert.equal(fallback.activity, "Update conditional access policy");

    const priority = attributeDriftChange({
      resource: "conditionalAccessPolicies",
      graphId: "ca-1",
      previousCapturedAt: "2026-07-05T10:00:00.000Z",
      capturedAt: "2026-07-05T10:10:00.000Z",
      auditCache: auditCache({
        intune: [
          intuneAuditRow({
            resourceId: "ca-1",
            activityDateTime: "2026-07-05T10:01:00.000Z",
            displayName: "Intune priority match",
          }),
        ],
        directory: [
          directoryAuditRow({
            targetId: "ca-1",
            activityDateTime: "2026-07-05T10:09:00.000Z",
            activityDisplayName: "Directory closer match",
          }),
        ],
      }),
    });

    assert.equal(priority.source, "intuneAudit");
    assert.equal(priority.activity, "Intune priority match");
  });

  it("returns unknown when fresh audit caches have no matching event", () => {
    const result = attributeDriftChange({
      resource: "assignmentFilters",
      graphId: "filter-1",
      previousCapturedAt: "2026-07-05T10:00:00.000Z",
      capturedAt: "2026-07-05T10:10:00.000Z",
      auditCache: auditCache({
        intune: [
          intuneAuditRow({
            resourceId: "other-filter",
            activityDateTime: "2026-07-05T10:09:00.000Z",
          }),
        ],
      }),
    });

    assert.deepEqual(result, { status: "unknown" });
  });

  it("returns audit-cache-stale when both audit caches are older than the window", () => {
    const result = attributeDriftChange({
      resource: "roleScopeTags",
      graphId: "tag-1",
      previousCapturedAt: "2026-07-05T10:00:00.000Z",
      capturedAt: "2026-07-05T10:10:00.000Z",
      auditCache: auditCache({
        intune: [
          intuneAuditRow({
            resourceId: "tag-1",
            activityDateTime: "2026-07-05T09:00:00.000Z",
          }),
        ],
        directory: [
          directoryAuditRow({
            targetId: "tag-1",
            activityDateTime: "2026-07-05T09:05:00.000Z",
          }),
        ],
        intuneRefreshedAt: "2026-07-05T09:05:00.000Z",
        directoryRefreshedAt: "2026-07-05T09:05:00.000Z",
      }),
    });

    assert.deepEqual(result, { status: "unknown", reason: "audit-cache-stale" });
  });

  it("pads the window start by five minutes for clock skew", () => {
    const result = attributeDriftChange({
      resource: "mobileApps",
      graphId: "app-1",
      previousCapturedAt: "2026-07-05T10:00:00.000Z",
      capturedAt: "2026-07-05T10:10:00.000Z",
      auditCache: auditCache({
        intune: [
          intuneAuditRow({
            resourceId: "app-1",
            activityDateTime: "2026-07-05T09:56:00.000Z",
            displayName: "Clock-skewed app update",
          }),
        ],
      }),
    });

    assert.equal(result.status, "matched");
    assert.equal(result.activity, "Clock-skewed app update");
  });
});

function auditCache(input: {
  intune?: CachedAuditRow[];
  directory?: CachedAuditRow[];
  intuneRefreshedAt?: string;
  directoryRefreshedAt?: string;
}): DriftAuditCache {
  const intune = input.intune ?? [];
  const directory = input.directory ?? [];
  return {
    intuneAuditEvents: intune,
    directoryAudits: directory,
    statuses: {
      intuneAuditEvents: status(
        "intuneAuditEvents",
        "Intune audit events",
        intune.length,
        input.intuneRefreshedAt ?? "2026-07-05T10:11:00.000Z",
      ),
      directoryAudits: status(
        "directoryAudits",
        "Directory audit logs",
        directory.length,
        input.directoryRefreshedAt ?? "2026-07-05T10:11:00.000Z",
      ),
    },
  };
}

function status(
  resource: "intuneAuditEvents" | "directoryAudits",
  label: string,
  rows: number,
  refreshedAt: string,
): GraphCacheResourceStatus {
  return {
    resource: resource as GraphCacheResourceStatus["resource"],
    label,
    rows,
    refreshedAt,
    scopeSet: [],
  };
}

function intuneAuditRow(input: {
  resourceId: string;
  activityDateTime: string;
  displayName?: string;
  userPrincipalName?: string;
}): CachedAuditRow {
  return {
    row: {
      id: `intune-${input.resourceId}-${input.activityDateTime}`,
      displayName: input.displayName ?? "Update Intune resource",
      activityDateTime: input.activityDateTime,
      actor: {
        userPrincipalName: input.userPrincipalName,
        applicationDisplayName: "Microsoft Intune admin center",
        auditActorType: "User",
      },
      resources: [{ resourceId: input.resourceId }],
    },
  };
}

function directoryAuditRow(input: {
  targetId: string;
  activityDateTime: string;
  activityDisplayName?: string;
}): CachedAuditRow {
  return {
    row: {
      id: `directory-${input.targetId}-${input.activityDateTime}`,
      activityDisplayName: input.activityDisplayName ?? "Update directory resource",
      activityDateTime: input.activityDateTime,
      initiatedBy: {
        user: { userPrincipalName: "admin@contoso.example" },
      },
      targetResources: [{ id: input.targetId }],
    },
  };
}
