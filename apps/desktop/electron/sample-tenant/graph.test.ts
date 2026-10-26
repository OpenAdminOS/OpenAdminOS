import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GRAPH_CACHE_RESOURCES,
  pathForResource,
} from "../intune-chat/planner.js";
import { createSampleGraph, SampleGraphError } from "./graph.js";

describe("sample tenant Graph", () => {
  it("answers every cache and special host path", async () => {
    const graph = createSampleGraph({ now: new Date("2026-10-26T12:00:00.000Z") });
    for (const resource of GRAPH_CACHE_RESOURCES) {
      const request = pathForResource(resource.resource);
      await assert.doesNotReject(() =>
        graph.request({ method: "GET", path: request.path, query: request.query }),
      );
    }

    for (const path of [
      "/subscribedSkus",
      "/me",
      "/me/messages",
      "/applications/microsoft.graph.agentIdentityBlueprint",
      "/groups/group-001/drives",
      "/users/user-001/memberOf",
      "/users/user-001/transitiveMemberOf",
      "/directoryRoles/role-global-admin/members",
      "/directoryRoles/role-intune-admin/members",
      "/groups/group-025/members",
      "/deviceAppManagement/mobileApps/mobile-app-001/assignments",
      "/deviceAppManagement/mobileApps/mobile-app-002/assignments",
      "/deviceManagement/managedDevices/managed-device-008/deviceCompliancePolicyStates",
      "/deviceManagement/managedDevices/managed-device-008/deviceCompliancePolicyStates/sample-compliance-state/settingStates",
    ]) {
      await assert.doesNotReject(() => graph.request({ method: "GET", path }));
    }
  });

  it("serves planted role memberships, group targets, and app assignments", async () => {
    const graph = createSampleGraph({ now: new Date("2026-10-26T12:00:00.000Z") });
    const globalAdmins = (await graph.request({
      method: "GET",
      path: "/directoryRoles/role-global-admin/members",
    })) as { value: unknown[] };
    const emptyGroup = (await graph.request({
      method: "GET",
      path: "/groups/group-025/members",
    })) as { value: unknown[] };
    const assignment = (await graph.request({
      method: "GET",
      path: "/deviceAppManagement/mobileApps/mobile-app-001/assignments",
    })) as { value: Array<Record<string, unknown>> };

    assert.equal(globalAdmins.value.length, 2);
    assert.equal(emptyGroup.value.length, 0);
    assert.equal(assignment.value.length, 1);
    assert.equal(
      (assignment.value[0]!.target as Record<string, unknown>).groupId,
      "group-025",
    );
  });

  it("supports selects, filters, counts, item paths, and paging", async () => {
    const graph = createSampleGraph({ now: new Date("2026-10-26T12:00:00.000Z") });
    const firstPage = (await graph.request({
      method: "GET",
      path: "/deviceManagement/managedDevices",
      query: {
        $filter: "operatingSystem eq 'Windows' and complianceState eq 'noncompliant'",
        $select: "id,deviceName,operatingSystem,complianceState",
        $top: "3",
        $count: "true",
      },
    })) as {
      value: Array<Record<string, unknown>>;
      "@odata.count": number;
      "@odata.nextLink": string;
    };
    assert.equal(firstPage.value.length, 3);
    assert.ok(firstPage["@odata.count"] > 3);
    assert.ok(firstPage.value.every((row) => row.operatingSystem === "Windows"));
    assert.ok(firstPage.value.every((row) => row.complianceState === "noncompliant"));
    assert.deepEqual(Object.keys(firstPage.value[0]!).sort(), [
      "complianceState",
      "deviceName",
      "id",
      "operatingSystem",
    ]);

    const secondPage = (await graph.request({
      method: "GET",
      path: firstPage["@odata.nextLink"],
    })) as { value: Array<Record<string, unknown>> };
    assert.ok(secondPage.value.length > 0);
    assert.notEqual(secondPage.value[0]!.id, firstPage.value[0]!.id);

    const selected = (await graph.request({
      method: "GET",
      path: "/users/user-001",
      query: { $select: "id,displayName" },
    })) as Record<string, unknown>;
    assert.deepEqual(Object.keys(selected).sort(), ["displayName", "id"]);

    const prefixed = (await graph.request({
      method: "GET",
      path: "/users",
      query: { $filter: "startsWith(displayName, 'Alex')" },
    })) as { value: Array<Record<string, unknown>> };
    assert.ok(prefixed.value.length > 0);
    assert.ok(prefixed.value.every((row) => String(row.displayName).startsWith("Alex")));
  });

  it("returns a Graph-shaped error for unknown paths", async () => {
    await assert.rejects(
      () =>
        createSampleGraph().request({
          method: "GET",
          path: "/openAdminOS/not-real",
        }),
      (error: unknown) => {
        assert.ok(error instanceof SampleGraphError);
        assert.equal(error.status, 404);
        assert.equal(error.body.error.code, "Request_ResourceNotFound");
        return true;
      },
    );
  });

  it("keeps simulated writes inside one in-memory graph", async () => {
    const first = createSampleGraph();
    const second = createSampleGraph();
    await first.retireManagedDevice("managed-device-001");
    const firstDevice = (await first.request({
      method: "GET",
      path: "/deviceManagement/managedDevices/managed-device-001",
    })) as Record<string, unknown>;
    const secondDevice = (await second.request({
      method: "GET",
      path: "/deviceManagement/managedDevices/managed-device-001",
    })) as Record<string, unknown>;
    assert.equal(firstDevice.managementState, "retirePending");
    assert.equal(firstDevice.retired, true);
    assert.equal(secondDevice.managementState, "managed");
    assert.equal(secondDevice.retired, false);
    assert.equal((await first.listManagedDevices()).length, 120);
  });
});
