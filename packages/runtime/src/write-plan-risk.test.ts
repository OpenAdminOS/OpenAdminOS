import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { WriteAction, WriteHttpMethod, WritePlan } from "@openadminos/agent-sdk";
import { agentTemplateToRegistrySummary, parseAgentTemplate } from "./agent-template.js";
import { assessWritePlan, assessWritePlanSafely } from "./write-plan-risk.js";

function action(path: string, method: WriteHttpMethod = "POST", body?: unknown): WriteAction {
  return { id: path, kind: "graph-write", label: "Proposed change", request: { method, path, body } };
}
function plan(...actions: WriteAction[]): WritePlan {
  return { summary: "Review changes.", confirmationPhrase: "APPLY CHANGES", actions };
}
function ids(...actions: WriteAction[]): string[] {
  return assessWritePlan(plan(...actions)).map((flag) => flag.id);
}

describe("write plan risk rules", () => {
  it("flags only policy creation, update, and deletion in Conditional Access", () => {
    for (const [path, method] of [
      ["/identity/conditionalAccess/policies", "POST"],
      ["/identity/conditionalAccess/policies/policy-1", "PATCH"],
      ["/identity/conditionalAccess/policies/policy-1/", "DELETE"],
    ] as const) assert.deepEqual(ids(action(path, method)), ["conditional-access"]);
    for (const proposed of [
      action("/identity/conditionalAccess/namedLocations", "POST"),
      action("/identity/conditionalAccess/policies/policy-1/conditions", "PATCH"),
      action("/identity/conditionalAccess/policies", "DELETE"),
      action("/identity/conditionalAccess/policiesExtra/policy-1", "PATCH"),
    ]) assert.deepEqual(ids(proposed), []);
  });

  it("flags role assignment and privileged role namespaces with segment boundaries", () => {
    for (const proposed of [
      action("/roleManagement/directory/roleAssignments"),
      action("/roleManagement/directory/roleAssignmentScheduleRequests"),
      action("/roleManagement/directory/roleEligibilityScheduleRequests"),
      action("/directoryRoles/role-1/members/$ref"),
      action("/directoryRoles/role-1/members/user-1/$ref", "DELETE"),
    ]) assert.deepEqual(ids(proposed), ["privileged-role"]);
    assert.deepEqual(ids(action("/roleManagementElse/roleAssignments"), action("/groups/roleManagement", "PATCH")), []);
  });

  it("flags destructive device endpoints, including the legacy retirement action", () => {
    for (const root of ["/deviceManagement/managedDevices", "/deviceManagement/comanagedDevices", "/users/user-1/managedDevices", "/me/managedDevices"]) {
      for (const suffix of ["wipe", "retire", "resetPasscode"]) {
        assert.deepEqual(ids(action(`${root}/device-1/${suffix}`)), ["managed-device-destructive"]);
      }
      assert.deepEqual(ids(action(`${root}/device-1`, "DELETE")), ["managed-device-destructive"]);
    }
    assert.deepEqual(ids({ id: "retire", kind: "retire-managed-device", label: "Retire device", metadata: { deviceId: "one" } }), ["managed-device-destructive"]);
    assert.deepEqual(ids(
      action("/deviceManagement/managedDevices/one/syncDevice"),
      action("/deviceManagement/managedDevices/one", "PATCH"),
      action("/deviceManagement/managedDevices/one/deviceCategory", "DELETE"),
      action("/deviceManagement/managedDevices/one/wipe", "PATCH"),
      action("/deviceManagement/managedDevicesElse/one/wipe"),
    ), []);
  });

  it("flags only deletion of directory objects, including alternate keys", () => {
    for (const root of ["users", "groups", "applications", "servicePrincipals"]) {
      assert.deepEqual(ids(action(`/${root}/one`, "DELETE")), ["directory-object-deletion"]);
      assert.deepEqual(ids(action(`/${root}/one`, "PATCH")), []);
      assert.deepEqual(ids(action(`/${root}/one/owners/other/$ref`, "DELETE")), []);
    }
    assert.deepEqual(ids(action("/applications(appId='app-1')", "DELETE")), ["directory-object-deletion"]);
    assert.deepEqual(ids(action("/groupsElse/one", "DELETE")), []);
  });

  it("flags credential operations, credential properties, and federated credential writes", () => {
    for (const root of ["/applications/app-1", "/servicePrincipals/sp-1", "/applications(appId='app-1')"]) {
      for (const operation of ["addPassword", "addKey", "removePassword", "removeKey"]) {
        assert.deepEqual(ids(action(`${root}/${operation}`)), ["application-credentials"]);
      }
      for (const property of ["keyCredentials", "passwordCredentials"]) {
        assert.deepEqual(ids(action(root, "PATCH", { [property]: [] })), ["application-credentials"]);
      }
    }
    for (const proposed of [
      action("/applications/app-1/federatedIdentityCredentials", "POST", { name: "workload" }),
      action("/applications/app-1/federatedIdentityCredentials/cred-1", "PATCH"),
      action("/applications/app-1/federatedIdentityCredentials/cred-1", "DELETE"),
      action("/applications/app-1/federatedIdentityCredentials(name='workload')", "DELETE"),
    ]) assert.deepEqual(ids(proposed), ["application-credentials"]);
    assert.deepEqual(ids(
      action("/applications/app-1", "PATCH", { displayName: "Renamed" }),
      action("/applications/app-1/addKeyExtra"),
      action("/applications/app-1/owners/owner-1", "PATCH", { keyCredentials: [] }),
      action("/groups/group-1/addPassword"),
    ), []);
  });

  it("recognizes broad assignment target types in replacement and individual bodies", () => {
    for (const type of ["#microsoft.graph.allDevicesAssignmentTarget", "#microsoft.graph.allLicensedUsersAssignmentTarget"]) {
      for (const proposed of [
        action("/deviceManagement/deviceConfigurations/policy-1/assign", "POST", { assignments: [{ target: { "@odata.type": type } }] }),
        action("/deviceAppManagement/mobileApps/app-1/assign", "POST", { mobileAppAssignments: [{ target: { "@odata.type": type } }] }),
        action("/deviceManagement/deviceCompliancePolicies/policy-1/assignments", "POST", { target: { "@odata.type": type } }),
        action("/deviceManagement/deviceCompliancePolicies/policy-1/assignments/assignment-1", "PATCH", { target: { "@odata.type": type } }),
      ]) assert.deepEqual(ids(proposed), ["tenant-wide-assignment"]);
    }
    assert.deepEqual(ids(
      action("/deviceManagement/deviceConfigurations/policy-1/assign", "POST", { assignments: [{ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "group-1", displayName: "All devices" } }] }),
      action("/groups/group-1", "PATCH", { description: "All users", target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }),
      action("/deviceManagement/deviceConfigurations/policy-1/assign", "POST", {}),
      action("/deviceManagement/deviceConfigurations/policy-1/assign", "POST", null),
    ), []);
  });

  it("warns strictly above three times the median, with no flag without valid history", () => {
    const sized = (count: number) => plan(...Array.from({ length: count }, (_, index) => action(`/groups/${index}`, "PATCH")));
    const context = { historicalConfirmedActionCounts: [1, 3, 2] };
    assert.deepEqual(assessWritePlan(sized(6), context), []);
    const flags = assessWritePlan(sized(7), context);
    assert.equal(flags[0]?.id, "unusual-plan-size");
    assert.equal(flags[0]?.severity, "warn");
    assert.equal(flags[0]?.actionIds.length, 7);
    assert.match(flags[0]?.explanation ?? "", /median of 2/);
    assert.deepEqual(assessWritePlan(sized(7), { historicalConfirmedActionCounts: [1, 4] }), []);
    for (const counts of [[], [0, -1, NaN, Infinity, 1.5]]) {
      assert.deepEqual(assessWritePlan(sized(100), { historicalConfirmedActionCounts: counts }), []);
    }
    assert.deepEqual(assessWritePlan(sized(100)), []);
    assert.deepEqual(context.historicalConfirmedActionCounts, [1, 3, 2]);
  });

  it("flags undeclared requests with the broker's method and placeholder matching", () => {
    const proposal = plan(action("/users/user-1", "PATCH"));
    for (const path of ["/users/{id}", "/users/:id", "/users/{{ item.id }}", "/users/user-1/"]) {
      assert.deepEqual(assessWritePlan(proposal, { graphOperations: [{ method: "PATCH", path }] }), []);
    }
    for (const graphOperations of [[], [{ method: "POST" as const, path: "/users/{id}" }], [{ method: "PATCH" as const, path: "/users/{id}/manager" }]]) {
      const flags = assessWritePlan(proposal, { graphOperations });
      assert.equal(flags[0]?.id, "undeclared-request");
      assert.equal(flags[0]?.severity, "danger");
    }
    assert.deepEqual(assessWritePlan(proposal), []);
  });

  it("accepts a bundled write agent's own request and rejects method or path changes", () => {
    const manifest = parseAgentTemplate(readFileSync(
      new URL("../../../agents/stale-guest-cleanup/manifest.yaml", import.meta.url),
      "utf8",
    ));
    const graphOperations = agentTemplateToRegistrySummary(manifest).graphOperations;
    const declared = action("/users/guest-1", "PATCH", { accountEnabled: false });
    assert.equal(
      assessWritePlan(plan(declared), { graphOperations }).some(
        (flag) => flag.id === "undeclared-request",
      ),
      false,
    );

    for (const changed of [
      action("/users/guest-1", "DELETE"),
      action("/groups/guest-1", "PATCH", { accountEnabled: false }),
    ]) {
      assert.equal(
        assessWritePlan(plan(changed), { graphOperations }).some(
          (flag) => flag.id === "undeclared-request",
        ),
        true,
      );
    }
  });

  it("groups matching action ids once per rule without changing the input", () => {
    const proposal = plan(action("/users/one", "DELETE"), action("/users/two", "DELETE"));
    const before = structuredClone(proposal);
    const flags = assessWritePlan(proposal);
    assert.equal(flags.length, 1);
    assert.deepEqual(flags[0]?.actionIds, ["/users/one", "/users/two"]);
    assert.equal(flags[0]?.severity, "danger");
    assert.deepEqual(proposal, before);
    assert.deepEqual(assessWritePlan(proposal), flags);
  });

  it("recognizes encoded paths and query strings, and distinguishes failed assessment", () => {
    assert.deepEqual(ids(action("/users/%75ser-1/?$select=id", "DELETE")), ["directory-object-deletion"]);
    const failed = assessWritePlanSafely(plan(action("/users/%invalid", "DELETE")));
    assert.deepEqual(failed, { status: "failed", reason: "A proposed Graph request path contains invalid encoding" });
    assert.deepEqual(assessWritePlanSafely(plan()), { status: "complete", flags: [] });
  });
});
