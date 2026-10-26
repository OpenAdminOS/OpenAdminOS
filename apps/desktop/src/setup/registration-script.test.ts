import { describe, expect, it } from "vitest";

import {
  PERMISSION_AREAS,
  REQUIRED_PERMISSION_AREA_MESSAGE,
  grantedScopeSet,
  scopesForPermissionAreas,
} from "../shared/openAdminOS";
import {
  escapePowerShellSingleQuoted,
  generateRegistrationSetup,
  validateRegistrationDisplayName,
} from "./registration-script";

describe("permission areas", () => {
  it("keeps the required directory area and maps every default scope once", () => {
    expect(PERMISSION_AREAS.find((area) => area.id === "directory")).toMatchObject({
      required: true,
      summary: REQUIRED_PERMISSION_AREA_MESSAGE,
    });
    expect(new Set(PERMISSION_AREAS.flatMap((area) => area.scopes)).size).toBe(
      PERMISSION_AREAS.flatMap((area) => area.scopes).length,
    );
    expect(scopesForPermissionAreas(["devices", "identity"])).toHaveLength(13);
  });

  it("treats an absent granted set as the legacy full default", () => {
    expect(grantedScopeSet({}).size).toBe(21);
    expect(grantedScopeSet({ grantedScopes: ["User.Read.All"] })).toEqual(
      new Set(["User.Read.All"]),
    );
  });
});

describe("registration setup generator", () => {
  it("uses the chosen area scopes and resolves permission ids at run time", () => {
    const output = generateRegistrationSetup("Admin's OpenAdminOS", [
      "apps",
      "directory",
    ]);
    expect(output.scopeNames).toEqual(
      scopesForPermissionAreas(["apps", "directory"]),
    );
    for (const scope of output.scopeNames) expect(output.script).toContain(`'${scope}'`);
    expect(output.script).not.toContain("'DeviceManagementManagedDevices.Read.All'");
    expect(output.script).not.toContain("'Policy.Read.All'");
    expect(output.script).toContain("$displayName = 'Admin''s OpenAdminOS'");
    expect(output.script).toContain("Oauth2PermissionScopes");
    expect(output.script).toContain("Where-Object { $_.Value -eq $scopeValue }");
    expect(output.script).toContain("SignInAudience = 'AzureADMyOrg'");
    expect(output.script).toContain("IsFallbackPublicClient = $true");
    expect(output.script).toContain("RedirectUris = @('http://localhost')");
    expect(output.script).toContain("New-MgOauth2PermissionGrant");
    expect(output.script).toContain("ConsentType = 'AllPrincipals'");
    expect(output.script).toContain("'openid'");
    expect(output.script).toContain("'profile'");
    expect(output.script).toContain("'offline_access'");
    expect(output.message).toContain("Apps, Users, groups, and directory");
    expect(output.message).toContain(
      "https://docs.openadminos.com/trust-model/authentication",
    );
  });

  it("contains no credential creation commands or properties", () => {
    const script = generateRegistrationSetup("OpenAdminOS", [
      "devices",
      "apps",
      "directory",
      "identity",
      "security",
    ]).script;
    expect(script).not.toMatch(/addPassword|PasswordCredentials|KeyCredentials/i);
  });

  it("escapes PowerShell single-quoted strings", () => {
    expect(escapePowerShellSingleQuoted("Ugur's app")).toBe("Ugur''s app");
    expect(validateRegistrationDisplayName("Unsafe #> name")).toMatch(
      /comment delimiters/,
    );
  });
});
