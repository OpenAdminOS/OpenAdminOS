import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { grantsFromTokenScopes } from "@openadminos/agent-sdk";

import { scopesFromAuthenticationResult } from "./token-scopes.js";

function token(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.signature`;
}

describe("scopes from a .default sign-in", () => {
  it("uses MSAL's scopes when they name real permissions", () => {
    const scopes = scopesFromAuthenticationResult({
      scopes: ["User.Read", "DeviceManagementApps.Read.All", "openid"],
      accessToken: token({ scp: "Ignored.Read.All" }),
    });
    assert.deepEqual(grantsFromTokenScopes(scopes), ["graph:User.Read", "graph:DeviceManagementApps.Read.All"]);
  });

  it("falls back to the scp claim when MSAL returns only .default", () => {
    const scopes = scopesFromAuthenticationResult({
      scopes: ["https://graph.microsoft.com/.default", "openid", "profile", "offline_access"],
      accessToken: token({ scp: "User.Read SecurityAlert.Read.All SecurityIncident.Read.All" }),
    });
    assert.deepEqual(grantsFromTokenScopes(scopes), [
      "graph:User.Read",
      "graph:SecurityAlert.Read.All",
      "graph:SecurityIncident.Read.All",
    ]);
  });

  it("falls back to the scp claim when MSAL returns no scopes", () => {
    const scopes = scopesFromAuthenticationResult({ scopes: [], accessToken: token({ scp: "Policy.Read.All" }) });
    assert.deepEqual(grantsFromTokenScopes(scopes), ["graph:Policy.Read.All"]);
  });

  it("records nothing, and never .default, when the token carries no scp", () => {
    const scopes = scopesFromAuthenticationResult({
      scopes: ["https://graph.microsoft.com/.default"],
      accessToken: "not-a-jwt",
    });
    assert.deepEqual(grantsFromTokenScopes(scopes), []);
  });
});
