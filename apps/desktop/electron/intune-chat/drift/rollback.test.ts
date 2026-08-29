import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { DriftBaselineChangeRecord } from "../sqlite-store.js";
import { buildRollbackPlan, type RollbackEndpointResolver } from "./rollback.js";

const LABELS: Record<string, string> = {
  deviceCompliancePolicies: "Device compliance policies",
  authenticationMethodsPolicy: "Authentication methods policy",
  directoryRoles: "Directory roles",
  applications: "App registrations",
  configurationPolicies: "Settings catalog policies",
};

function label(resource: string): string {
  return LABELS[resource] ?? resource;
}

const acceptAll: RollbackEndpointResolver = () => ({
  scopesDelegated: ["DeviceManagementConfiguration.ReadWrite.All", "Policy.Read.All"],
});

function change(input: Partial<DriftBaselineChangeRecord>): DriftBaselineChangeRecord {
  return {
    resource: "deviceCompliancePolicies",
    graphId: "object-1",
    kind: "modified",
    ...input,
  } as DriftBaselineChangeRecord;
}

describe("rollback plan builder", () => {
  it("maps modified, added, and removed changes onto PATCH, DELETE, and POST", () => {
    const plan = buildRollbackPlan({
      changes: [
        change({
          kind: "modified",
          graphId: "policy-1",
          displayName: "BitLocker",
          pinnedRawJson: JSON.stringify({
            id: "policy-1",
            displayName: "BitLocker",
            createdDateTime: "2026-01-01T00:00:00Z",
            lastModifiedDateTime: "2026-02-02T00:00:00Z",
            "@odata.etag": "abc",
            setting: "on",
          }),
          currentRawJson: JSON.stringify({ id: "policy-1", setting: "off" }),
        }),
        change({ kind: "added", graphId: "policy-2", displayName: "Rogue policy" }),
        change({
          kind: "removed",
          graphId: "policy-3",
          displayName: "Deleted policy",
          pinnedRawJson: JSON.stringify({
            id: "policy-3",
            "@odata.type": "#microsoft.graph.windows10CompliancePolicy",
            displayName: "Deleted policy",
          }),
        }),
      ],
      labelForResource: label,
      resolveEndpoint: acceptAll,
    });

    assert.equal(plan.actions.length, 3);
    assert.equal(plan.confirmationPhrase, "ROLLBACK 3 OBJECTS");
    assert.deepEqual(plan.manual, []);
    assert.deepEqual(plan.requiredScopes, ["DeviceManagementConfiguration.ReadWrite.All"]);

    const patch = plan.actions.find((action) => action.request?.method === "PATCH");
    assert.equal(
      patch?.request?.path,
      "/deviceManagement/deviceCompliancePolicies/policy-1",
    );
    const body = patch?.request?.body as Record<string, unknown>;
    assert.equal(body.setting, "on");
    assert.equal(body.id, undefined);
    assert.equal(body.createdDateTime, undefined);
    assert.equal(body.lastModifiedDateTime, undefined);
    assert.equal(body["@odata.etag"], undefined);

    const del = plan.actions.find((action) => action.request?.method === "DELETE");
    assert.equal(del?.severity, "destructive");
    assert.equal(
      del?.request?.path,
      "/deviceManagement/deviceCompliancePolicies/policy-2",
    );

    const post = plan.actions.find((action) => action.request?.method === "POST");
    assert.equal(post?.request?.path, "/deviceManagement/deviceCompliancePolicies");
    const postBody = post?.request?.body as Record<string, unknown>;
    assert.equal(postBody["@odata.type"], "#microsoft.graph.windows10CompliancePolicy");
  });

  it("patches singletons at their base path and never deletes or recreates them", () => {
    const plan = buildRollbackPlan({
      changes: [
        change({
          resource: "authenticationMethodsPolicy",
          kind: "modified",
          graphId: "authenticationMethodsPolicy",
          pinnedRawJson: JSON.stringify({ registrationEnforcement: {} }),
        }),
        change({
          resource: "authenticationMethodsPolicy",
          kind: "added",
          graphId: "phantom",
        }),
      ],
      labelForResource: label,
      resolveEndpoint: acceptAll,
    });
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.actions[0]?.request?.method, "PATCH");
    assert.equal(plan.actions[0]?.request?.path, "/policies/authenticationMethodsPolicy");
    assert.equal(plan.manual.length, 1);
  });

  it("keeps report-only resources out of the plan with their reasons", () => {
    const plan = buildRollbackPlan({
      changes: [
        change({ resource: "directoryRoles", kind: "modified", graphId: "role-1" }),
        change({ resource: "applications", kind: "modified", graphId: "app-1" }),
      ],
      labelForResource: label,
      resolveEndpoint: acceptAll,
    });
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.confirmationPhrase, "ROLLBACK 0 OBJECTS");
    assert.equal(plan.manual.length, 2);
    assert.match(plan.manual[0]?.reason ?? "", /not writable/i);
    assert.match(plan.manual[1]?.reason ?? "", /credential/i);
  });

  it("downgrades to manual when the catalog does not document the endpoint", () => {
    const plan = buildRollbackPlan({
      changes: [
        change({
          kind: "modified",
          graphId: "policy-1",
          pinnedRawJson: JSON.stringify({ displayName: "X" }),
        }),
      ],
      labelForResource: label,
      resolveEndpoint: () => null,
    });
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.manual.length, 1);
    assert.match(plan.manual[0]?.reason ?? "", /manually/i);
  });

  it("honors an explicit selection subset", () => {
    const plan = buildRollbackPlan({
      changes: [
        change({
          kind: "modified",
          graphId: "policy-1",
          pinnedRawJson: JSON.stringify({ displayName: "One" }),
        }),
        change({
          kind: "modified",
          graphId: "policy-2",
          pinnedRawJson: JSON.stringify({ displayName: "Two" }),
        }),
      ],
      labelForResource: label,
      resolveEndpoint: acceptAll,
      selections: [{ resource: "deviceCompliancePolicies", graphId: "policy-2" }],
    });
    assert.equal(plan.actions.length, 1);
    assert.equal(plan.confirmationPhrase, "ROLLBACK 1 OBJECT");
    assert.equal(
      plan.actions[0]?.request?.path,
      "/deviceManagement/deviceCompliancePolicies/policy-2",
    );
  });
});
