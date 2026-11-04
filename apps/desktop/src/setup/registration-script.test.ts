/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { grantedScopeSet, partIdsFor } from "../shared/openAdminOS";
import {
  CONSENT_GRANT_ATTEMPTS,
  CONSENT_GRANT_RETRY_SECONDS,
  escapePowerShellSingleQuoted,
  generateRegistrationSetup,
  powerShellStringLiteral,
  generateRequiredResourceAccessSnippet,
  validateRegistrationDisplayName,
} from "./registration-script";

describe("granted scope set", () => {
  it("treats an absent granted set as every requestable part scope", () => {
    expect(grantedScopeSet({}).size).toBe(20);
    expect(grantedScopeSet({ grantedScopes: ["User.Read.All"] })).toEqual(
      new Set(["User.Read.All"]),
    );
  });
});

describe("registration setup generator", () => {
  it("uses the chosen part scopes plus sign-in and resolves permission ids at run time", () => {
    const output = generateRegistrationSetup({
      mode: "create",
      displayName: "Admin's OpenAdminOS",
      partIds: ["intune.apps", "entra.apps"],
    });
    expect(output.scopeNames).toEqual([
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "DeviceManagementApps.Read.All",
      "Application.Read.All",
    ]);
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
    // Every cmdlet module must be checked before the first change is made.
    for (const module of [
      "Microsoft.Graph.Authentication",
      "Microsoft.Graph.Applications",
      "Microsoft.Graph.Identity.SignIns",
    ]) {
      expect(output.script).toContain(`'${module}'`);
    }
    expect(output.script.indexOf("$missingModules.Count -gt 0")).toBeLessThan(
      output.script.indexOf("New-MgApplication"),
    );
    expect(output.script).toContain("Remove-MgApplication -ApplicationId $application.Id");
    expect(output.script).toContain("ConsentType = 'AllPrincipals'");
    expect(output.script).toContain("'openid'");
    expect(output.script).toContain("'profile'");
    expect(output.script).toContain("'offline_access'");
    expect(output.serviceTitles).toEqual(["Intune", "Entra"]);
    expect(output.message).toContain("these services: Intune, Entra.");
    expect(output.message).toContain(
      "https://docs.openadminos.com/trust-model/authentication",
    );
  });

  it("contains no credential creation commands or properties", () => {
    const script = generateRegistrationSetup({
      mode: "create",
      displayName: "OpenAdminOS",
      partIds: partIdsFor(["intune", "entra", "defender"]),
    }).script;
    expect(script).not.toMatch(/addPassword|PasswordCredentials|KeyCredentials/i);
  });

  it("refuses an empty service selection", () => {
    expect(() =>
      generateRegistrationSetup({ mode: "create", displayName: "OpenAdminOS", partIds: [] }),
    ).toThrow("Select at least one service.");
  });

  it("escapes PowerShell single-quoted strings", () => {
    expect(escapePowerShellSingleQuoted("Ugur's app")).toBe("Ugur''s app");
    expect(validateRegistrationDisplayName("Unsafe #> name")).toMatch(
      /comment delimiters/,
    );
  });
});

const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

// Runs the script header and the display name assignment, then prints the
// value PowerShell parsed. Nothing after the assignment runs.
function parsedDisplayName(script: string): string {
  const cut = script.indexOf("\n$microsoftGraphAppId");
  expect(cut).toBeGreaterThan(0);
  const directory = mkdtempSync(join(tmpdir(), "openadminos-ps-"));
  try {
    const path = join(directory, "prefix.ps1");
    writeFileSync(
      path,
      `${script.slice(0, cut)}\nWrite-Output "NAME=$displayName"\n`,
      "utf8",
    );
    const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createSetup(displayName: string) {
  return generateRegistrationSetup({ mode: "create", displayName, partIds: ["entra.people"] });
}

describe("registration display name quoting", () => {
  const injection = "; Write-Output INJECTED; #";

  it("rejects every PowerShell single-quote variant", () => {
    for (const quote of ["\u2018", "\u2019", "\u201A", "\u201B"]) {
      const name = `Ops${quote}${injection}`;
      expect(validateRegistrationDisplayName(name)).toBe(
        "Display name cannot contain typographic single quotes. Use a straight apostrophe (') instead.",
      );
      expect(() => createSetup(name)).toThrow(
        /typographic single quotes/,
      );
    }
  });

  it("still accepts and escapes the ASCII apostrophe", () => {
    expect(validateRegistrationDisplayName(`Ops'${injection}`)).toBeNull();
    expect(createSetup(`Ops'${injection}`).script).toContain(
      `$displayName = 'Ops''${injection}'`,
    );
  });

  it.skipIf(!HAS_PWSH)("parses the escaped name as one string in PowerShell", () => {
    const name = `Ops'${injection}`;
    const output = parsedDisplayName(createSetup(name).script);
    expect(output).toBe(`NAME=${name}`);
    expect(output.split("\n")).not.toContain("INJECTED");
  });

  it.skipIf(!HAS_PWSH)("confirms PowerShell ends a single-quoted string at U+2019", () => {
    const script = "$displayName = 'Ops\u2019; Write-Output INJECTED; #'\n$microsoftGraphAppId = ''";
    expect(parsedDisplayName(script).split("\n")).toContain("INJECTED");
  });
});

describe("registration script encoding", () => {
  const printableAscii = /^[\t\n\r\x20-\x7E]*$/;

  it("writes non-ASCII display names as [char] codes", () => {
    expect(powerShellStringLiteral("Ugur's app")).toBe("'Ugur''s app'");
    expect(powerShellStringLiteral("\u00DCber Ops")).toBe("-join @([char]0x00DC, 'ber Ops')");
    const script = createSetup("\u00DCber Ops").script;
    expect(script).toMatch(printableAscii);
    expect(script).toContain("$displayName = -join @([char]0x00DC, 'ber Ops')");
    expect(script).toContain("app registration with the display name set in $displayName below");
  });

  // U+00C2 is C3 82 in UTF-8, and Windows-1252 reads 0x82 as U+201A.
  it("leaves no byte that Windows-1252 reads as a quote", () => {
    const script = createSetup("\u00C2; Write-Output INJECTED; #").script;
    const bytes = new TextEncoder().encode(script);
    expect(new TextDecoder("windows-1252").decode(bytes)).toBe(script);
    expect(script).toMatch(printableAscii);
  });

  it.skipIf(!HAS_PWSH)("round-trips non-ASCII names through PowerShell", () => {
    for (const name of ["\u00DCber Ops", "Ops \u{20BB7} team", "\u00C2'; Write-Output INJECTED; #"]) {
      const output = parsedDisplayName(createSetup(name).script);
      expect(output).toBe(`NAME=${name}`);
    }
  });

  it("keeps the existing-app script ASCII-only", () => {
    const script = generateRegistrationSetup({
      mode: "extend",
      clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      partIds: ["intune.devices", "entra.people", "defender.incidents"],
    }).script;
    expect(script).toMatch(printableAscii);
  });
});

describe("existing app registration script", () => {
  const clientId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const output = generateRegistrationSetup({
    mode: "extend",
    clientId: ` ${clientId} `,
    partIds: ["defender.incidents", "defender.score"],
  });

  it("finds the app by client ID and stops when it does not exist", () => {
    expect(output.mode).toBe("extend");
    expect(output.script).toContain(`$clientId = '${clientId}'`);
    expect(output.script).toContain(`Get-MgApplication -Filter "appId eq '$clientId'"`);
    expect(output.script).toContain("No application with client ID $clientId was found in this tenant. No changes were made.");
    expect(output.script.indexOf("$applications.Count -ne 1")).toBeLessThan(output.script.indexOf("Update-MgApplication"));
    expect(output.scopeNames).toEqual([
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "SecurityAlert.Read.All",
      "SecurityIncident.Read.All",
      "SecurityEvents.Read.All",
    ]);
  });

  it("resolves permission IDs at run time and never removes an existing requiredResourceAccess entry", () => {
    expect(output.script).toContain("Where-Object { $_.Value -eq $scopeValue }");
    // Every existing resource entry and every existing permission is sent back.
    expect(output.script).toContain("foreach ($resource in @($application.RequiredResourceAccess))");
    expect(output.script).toContain("ResourceAppId = $resource.ResourceAppId");
    expect(output.script).toContain("$existingAccess = @($existingAccess + $addedPermissions)");
    expect(output.script).toContain("$existingScopeIds -notcontains $_.Id");
    expect(output.script).toContain("RequiredResourceAccess = $requiredResourceAccess");
    expect(output.script).not.toMatch(/Remove-Mg|\.Remove\(|-ne \$_\.Id/);
    expect(output.script).not.toContain("New-MgApplication");
  });

  it("unions an existing AllPrincipals grant and creates one only when none exists", () => {
    expect(output.script).toContain("$_.ConsentType -eq 'AllPrincipals' -and $_.ResourceId -eq $graphServicePrincipal.Id");
    expect(output.script).toContain("Update-MgOauth2PermissionGrant -OAuth2PermissionGrantId $existingGrant.Id");
    expect(output.script).toContain("Scope = (@($grantedScopes + $addedConsent) -join ' ')");
    expect(output.script).toContain("New-MgOauth2PermissionGrant");
    expect(output.script.indexOf("if ($existingGrant)")).toBeLessThan(output.script.indexOf("New-MgOauth2PermissionGrant"));
    expect(output.script).toContain("New-MgServicePrincipal");
    expect(output.script).toContain("Return to OpenAdminOS and choose Check again.");
    expect(output.script).not.toMatch(/addPassword|PasswordCredentials|KeyCredentials/i);
  });

  it("retries a new grant while a new enterprise application replicates, and only a new grant", () => {
    // The retry loop from `$grantAttempts` through its closing brace.
    const grantLoop = (script: string, from: number): string => {
      const start = script.indexOf("    $grantAttempts = ", from);
      const end = script.indexOf("\n    }\n", script.indexOf("Start-Sleep -Seconds", start)) + "\n    }".length;
      return script.slice(start, end);
    };
    const script = output.script;
    const newGrant = script.indexOf("$addedConsent = @($requestedScopeValues)");
    expect(newGrant).toBeGreaterThan(script.indexOf("} else {", script.indexOf("if ($existingGrant)")));
    expect(script.indexOf("$grantAttempts")).toBeGreaterThan(newGrant);
    expect(script.match(/New-MgOauth2PermissionGrant/g)).toHaveLength(1);
    // The same bounded loop the create script runs, so its tests cover this one.
    const createScript = generateRegistrationSetup({
      mode: "create",
      displayName: "OpenAdminOS",
      partIds: ["defender.incidents"],
    }).script;
    const loop = grantLoop(script, newGrant);
    expect(loop).toContain("if (-not $notReplicatedYet -or $attempt -eq $grantAttempts) { throw }");
    expect(loop).toBe(grantLoop(createScript, 0));
    expect(script).toContain(
      `A new grant is retried up to ${CONSENT_GRANT_ATTEMPTS} times, ${CONSENT_GRANT_RETRY_SECONDS} seconds apart`,
    );
  });

  it("names the services and the client ID in the admin message", () => {
    expect(output.message).toContain(`existing app registration with client ID ${clientId}: Defender.`);
    expect(output.message).toContain("keeps every permission the app already has");
  });

  it("rejects a client ID that is not a GUID", () => {
    expect(() =>
      generateRegistrationSetup({ mode: "extend", clientId: "contoso'; Remove-MgApplication", partIds: ["defender.score"] }),
    ).toThrow("The Application (client) ID must be a GUID");
  });
});

describe("requiredResourceAccess snippet", () => {
  it("lists the registry permission IDs for Graph only, with merge and consent notes", () => {
    const snippet = generateRequiredResourceAccessSnippet(["entra.signins", "entra.people"]);
    const parsed = JSON.parse(snippet.json) as Array<{ resourceAppId: string; resourceAccess: Array<{ id: string; type: string }> }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.resourceAppId).toBe("00000003-0000-0000-c000-000000000000");
    expect(parsed[0]?.resourceAccess).toEqual(
      [
        "37f7f235-527c-4136-accd-4a02d197296e",
        "14dad69e-099b-42c9-810b-d002981feec1",
        "7427e0e9-2fba-42fe-b0c0-848c9e6a8182",
        "e1fe6dd8-ba31-4d61-89e7-88639da4683d",
        "a154be20-db9c-4678-8ab7-66f6cc099a59",
        "bc024368-1153-4739-b217-4326f2e966d0",
        "4908d5b9-3fb2-4b1e-9336-1888b7937185",
        "e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20",
        "d04bb851-cb7c-4146-97c7-ca3e71baf56c",
      ].map((id) => ({ id, type: "Scope" })),
    );
    expect(snippet.notes.join(" ")).toMatch(/Do not replace the array/);
    expect(snippet.notes.join(" ")).toMatch(/Admin consent is still required/);
  });
});

describe("admin consent grant retry", () => {
  const script = generateRegistrationSetup({
    mode: "create",
    displayName: "OpenAdminOS",
    partIds: ["entra.people"],
  }).script;
  const loopStart = script.indexOf("    $grantAttempts = ");
  const loopEnd = script.indexOf("} catch {\n    $setupError");

  it("retries only a not found error, a bounded number of times, inside the rollback", () => {
    expect(CONSENT_GRANT_ATTEMPTS).toBe(6);
    expect(CONSENT_GRANT_RETRY_SECONDS).toBe(5);
    expect(script).toContain(`$grantAttempts = ${CONSENT_GRANT_ATTEMPTS}`);
    expect(script).toContain(`Start-Sleep -Seconds ${CONSENT_GRANT_RETRY_SECONDS}`);
    expect(script).toContain("Request_ResourceNotFound");
    expect(script).toContain("if (-not $notReplicatedYet -or $attempt -eq $grantAttempts) { throw }");
    expect(loopStart).toBeGreaterThan(script.indexOf("New-MgServicePrincipal"));
    expect(loopEnd).toBeGreaterThan(loopStart);
    expect(script.indexOf("Remove-MgApplication -ApplicationId $application.Id")).toBeGreaterThan(loopEnd);
    expect(script).toMatch(/^[\t\n\r\x20-\x7E]*$/);
  });

  // Runs the generated retry loop with the Graph cmdlet and Start-Sleep
  // replaced by functions, so no tenant is contacted and nothing waits.
  function runGrantLoop(failures: number, message: string): string {
    const directory = mkdtempSync(join(tmpdir(), "openadminos-ps-"));
    try {
      const path = join(directory, "grant.ps1");
      writeFileSync(
        path,
        [
          "$ErrorActionPreference = 'Stop'",
          "$servicePrincipal = @{ Id = 'sp' }",
          "$graphServicePrincipal = @{ Id = 'graph' }",
          "$requestedScopeValues = @('User.Read')",
          "$script:calls = 0",
          "$script:slept = 0",
          `function New-MgOauth2PermissionGrant { param($BodyParameter) $script:calls++; if ($script:calls -le ${failures}) { throw '${message}' }; [pscustomobject]@{ Id = 'grant' } }`,
          "function Start-Sleep { param($Seconds) $script:slept += $Seconds }",
          "try {",
          "    $scopeString = $requestedScopeValues -join ' '",
          script.slice(loopStart, loopEnd),
          "    Write-Output \"GRANTED\"",
          "} catch {",
          "    Write-Output \"FAILED=$($_.Exception.Message)\"",
          "}",
          "Write-Output \"CALLS=$script:calls SLEPT=$script:slept\"",
        ].join("\n"),
        "utf8",
      );
      const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", path], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  const notFound =
    "Resource sp does not exist or one of its queried reference-property objects are not present. Status: 404 (NotFound) ErrorCode: Request_ResourceNotFound";

  it.skipIf(!HAS_PWSH)("grants consent once the service principal has replicated", () => {
    const output = runGrantLoop(2, notFound);
    expect(output).toContain("GRANTED");
    expect(output).toContain("CALLS=3 SLEPT=10");
  });

  it.skipIf(!HAS_PWSH)("gives up after the last attempt so the rollback runs", () => {
    const output = runGrantLoop(99, notFound);
    expect(output).toContain(`FAILED=${notFound}`);
    expect(output).toContain(`CALLS=${CONSENT_GRANT_ATTEMPTS} SLEPT=${(CONSENT_GRANT_ATTEMPTS - 1) * CONSENT_GRANT_RETRY_SECONDS}`);
  });

  it.skipIf(!HAS_PWSH)("does not retry other errors", () => {
    const output = runGrantLoop(99, "Insufficient privileges to complete the operation.");
    expect(output).toContain("FAILED=Insufficient privileges to complete the operation.");
    expect(output).toContain("CALLS=1 SLEPT=0");
  });
});
