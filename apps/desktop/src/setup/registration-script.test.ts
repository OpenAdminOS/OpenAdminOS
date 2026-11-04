/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PERMISSION_AREAS,
  REQUIRED_PERMISSION_AREA_MESSAGE,
  grantedScopeSet,
  scopesForPermissionAreas,
} from "../shared/openAdminOS";
import {
  CONSENT_GRANT_ATTEMPTS,
  CONSENT_GRANT_RETRY_SECONDS,
  escapePowerShellSingleQuoted,
  generateRegistrationSetup,
  powerShellStringLiteral,
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

describe("registration display name quoting", () => {
  const injection = "; Write-Output INJECTED; #";

  it("rejects every PowerShell single-quote variant", () => {
    for (const quote of ["\u2018", "\u2019", "\u201A", "\u201B"]) {
      const name = `Ops${quote}${injection}`;
      expect(validateRegistrationDisplayName(name)).toBe(
        "Display name cannot contain typographic single quotes. Use a straight apostrophe (') instead.",
      );
      expect(() => generateRegistrationSetup(name, ["directory"])).toThrow(
        /typographic single quotes/,
      );
    }
  });

  it("still accepts and escapes the ASCII apostrophe", () => {
    expect(validateRegistrationDisplayName(`Ops'${injection}`)).toBeNull();
    expect(generateRegistrationSetup(`Ops'${injection}`, ["directory"]).script).toContain(
      `$displayName = 'Ops''${injection}'`,
    );
  });

  it.skipIf(!HAS_PWSH)("parses the escaped name as one string in PowerShell", () => {
    const name = `Ops'${injection}`;
    const output = parsedDisplayName(generateRegistrationSetup(name, ["directory"]).script);
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
    const script = generateRegistrationSetup("\u00DCber Ops", ["directory"]).script;
    expect(script).toMatch(printableAscii);
    expect(script).toContain("$displayName = -join @([char]0x00DC, 'ber Ops')");
    expect(script).toContain("app registration with the display name set in $displayName below");
  });

  // U+00C2 is C3 82 in UTF-8, and Windows-1252 reads 0x82 as U+201A.
  it("leaves no byte that Windows-1252 reads as a quote", () => {
    const script = generateRegistrationSetup(
      "\u00C2; Write-Output INJECTED; #",
      ["directory"],
    ).script;
    const bytes = new TextEncoder().encode(script);
    expect(new TextDecoder("windows-1252").decode(bytes)).toBe(script);
    expect(script).toMatch(printableAscii);
  });

  it.skipIf(!HAS_PWSH)("round-trips non-ASCII names through PowerShell", () => {
    for (const name of ["\u00DCber Ops", "Ops \u{20BB7} team", "\u00C2'; Write-Output INJECTED; #"]) {
      const output = parsedDisplayName(generateRegistrationSetup(name, ["directory"]).script);
      expect(output).toBe(`NAME=${name}`);
    }
  });
});

describe("admin consent grant retry", () => {
  const script = generateRegistrationSetup("OpenAdminOS", ["directory"]).script;
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
