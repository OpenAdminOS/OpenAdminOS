import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertAgentPermissions, assertSandboxIdentity } from "./identity.js";
import { SandboxRefusal } from "./refusal.js";
import { appClaims, CLIENT, TENANT, tokenFor } from "./test-support.js";

const expected = { tenantId: TENANT, clientId: CLIENT, allowedRoles: new Set(["DeviceManagementManagedDevices.Read.All", "User.Read.All"]) };

function reasonOf(claims: Record<string, unknown>): string {
  try {
    assertSandboxIdentity(tokenFor(claims), expected);
  } catch (error) {
    assert.ok(error instanceof SandboxRefusal);
    return error.reason;
  }
  return "accepted";
}

describe("assertSandboxIdentity", () => {
  it("accepts an app token with only allowed read roles", () => {
    assert.equal(reasonOf(appClaims(["DeviceManagementManagedDevices.Read.All"])), "accepted");
    assert.equal(reasonOf(appClaims(["User.Read.All"], { appid: undefined, azp: CLIENT })), "accepted");
    // Every app-only token carries this wid, with no directory role assigned.
    assert.equal(reasonOf(appClaims(["User.Read.All"], { wids: ["0997a1d0-0d1d-4acb-b408-d5ca73121e90"] })), "accepted");
  });

  it("refuses each identity problem with its reason", () => {
    assert.equal(reasonOf(appClaims(["User.Read.All"], { idtyp: "user" })), "identity-not-app");
    assert.equal(reasonOf(appClaims(["User.Read.All"], { tid: "33333333-3333-3333-3333-333333333333" })), "identity-tenant-mismatch");
    assert.equal(reasonOf(appClaims(["User.Read.All"], { appid: "44444444-4444-4444-4444-444444444444" })), "identity-client-mismatch");
    assert.equal(reasonOf(appClaims(["User.Read.All"], { aud: "https://management.azure.com" })), "identity-audience-not-graph");
    assert.equal(reasonOf(appClaims(["User.Read.All"], { wids: ["62e90394-69f5-4237-9190-012177145e10"] })), "identity-has-directory-roles");
    assert.equal(reasonOf(appClaims(["User.Read.All"], { wids: ["0997a1d0-0d1d-4acb-b408-d5ca73121e90", "62e90394-69f5-4237-9190-012177145e10"] })), "identity-has-directory-roles");
    assert.equal(reasonOf(appClaims(undefined)), "identity-has-no-roles");
    assert.equal(reasonOf(appClaims(["DeviceLocalCredential.Read.All"])), "identity-holds-secret-permission");
    assert.equal(reasonOf(appClaims(["DeviceManagementManagedDevices.Read.All", "Device.Read.All"])), "identity-holds-unneeded-permission");
  });

  it("lists every role that can change the tenant", () => {
    assert.throws(
      () => assertSandboxIdentity(tokenFor(appClaims(["DeviceManagementManagedDevices.Read.All", "DeviceManagementManagedDevices.PrivilegedOperations.All", "Mail.Send"])), expected),
      (error: unknown) =>
        error instanceof SandboxRefusal &&
        error.reason === "identity-can-change-tenant" &&
        error.message.includes("DeviceManagementManagedDevices.PrivilegedOperations.All, Mail.Send"),
    );
  });
});

describe("assertAgentPermissions", () => {
  it("names the scope the identity does not hold", () => {
    assert.throws(
      () => assertAgentPermissions(["User.Read.All"], "Find inactive devices", ["DeviceManagementManagedDevices.Read.All"]),
      (error: unknown) => error instanceof SandboxRefusal && error.reason === "identity-missing-permission" && error.message.includes("DeviceManagementManagedDevices.Read.All"),
    );
    assertAgentPermissions(["DeviceManagementManagedDevices.Read.All"], "Find inactive devices", ["DeviceManagementManagedDevices.Read.All"]);
  });
});
