import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compactConditionalAccessPolicy } from "./ca-compact.js";
import { renderTemplate } from "./template-engine.js";

const NOW = Date.parse("2026-11-19T00:00:00Z");

describe("compactConditionalAccessPolicy", () => {
  it("keeps what a review needs and drops ids, nulls and OData annotations", () => {
    const record = compactConditionalAccessPolicy({
      id: "6cb9c14e-af11-4935-99c4-2c5c6d1b0f7a",
      displayName: "Require MFA for administrators",
      state: "enabled",
      createdDateTime: "2024-01-17T12:55:36Z",
      modifiedDateTime: null,
      sessionControls: null,
      conditions: {
        userRiskLevels: [], signInRiskLevels: [], clientAppTypes: ["all"], locations: null, platforms: null,
        applications: { includeApplications: ["All"], excludeApplications: [], includeUserActions: [], includeAuthenticationContextClassReferences: [], applicationFilter: null },
        users: {
          includeUsers: [], excludeUsers: ["a1", "a2"], includeGroups: [], excludeGroups: ["g1"],
          includeRoles: ["62e90394-69f5-4237-9190-012177145e10", "0f0f0f0f-0000-4000-a000-000000000000"], excludeRoles: [],
          includeGuestsOrExternalUsers: null, excludeGuestsOrExternalUsers: null,
        },
      },
      grantControls: {
        operator: "OR", builtInControls: [], customAuthenticationFactors: [], termsOfUse: [],
        "authenticationStrength@odata.context": "https://graph.microsoft.com/beta/$metadata#x",
        authenticationStrength: { id: "00000000-0000-0000-0000-000000000004", displayName: "Phishing-resistant MFA", allowedCombinations: ["fido2"] },
      },
    }, NOW);
    assert.deepEqual(record, {
      name: "Require MFA for administrators",
      state: "enabled",
      modifiedDaysAgo: 1036,
      users: {
        include: { roles: ["Global Administrator", "custom role 0f0f0f0f-0000-4000-a000-000000000000"] },
        exclude: { users: "2 users", groups: 1 },
      },
      apps: { include: "All" },
      grant: { authStrength: "Phishing-resistant MFA" },
    });
  });

  it("summarizes guests, locations, platforms, risk, device filters and session controls", () => {
    const record = compactConditionalAccessPolicy({
      displayName: "Guests and risk",
      state: "enabledForReportingButNotEnforced",
      modifiedDateTime: "2026-11-09T00:00:00Z",
      conditions: {
        clientAppTypes: ["exchangeActiveSync", "other"],
        signInRiskLevels: ["high"], userRiskLevels: ["medium"],
        platforms: { includePlatforms: ["android", "iOS"], excludePlatforms: [] },
        locations: { includeLocations: ["All"], excludeLocations: ["AllTrusted", "loc-1", "loc-2"] },
        devices: { deviceFilter: { mode: "exclude", rule: 'device.model -eq "Kiosk"' } },
        applications: { includeApplications: ["797f4846-ba00-4fd7-ba43-dac1f8f63013", "app-1"], includeUserActions: ["urn:user:registersecurityinfo"] },
        users: { includeGuestsOrExternalUsers: { guestOrExternalUserTypes: "b2bCollaborationGuest", externalTenants: { membershipKind: "all" } } },
      },
      grantControls: { operator: "AND", builtInControls: ["mfa", "passwordChange"], termsOfUse: ["t1"] },
      sessionControls: {
        signInFrequency: { value: 4, type: "hours", frequencyInterval: "timeBased", isEnabled: true },
        persistentBrowser: { mode: "never", isEnabled: true },
        cloudAppSecurity: { cloudAppSecurityType: "monitorOnly", isEnabled: false },
        continuousAccessEvaluation: { mode: "strictEnforcement" },
        applicationEnforcedRestrictions: null,
      },
    }, NOW);
    assert.deepEqual(record, {
      name: "Guests and risk",
      state: "enabledForReportingButNotEnforced",
      modifiedDaysAgo: 10,
      users: { include: { guests: "b2bCollaborationGuest from all tenants" } },
      apps: { include: "Azure Resource Manager (Azure management), 1 app", userActions: ["registersecurityinfo"] },
      clientAppTypes: ["exchangeActiveSync", "other"],
      platforms: { include: "android, iOS" },
      locations: { include: "All", exclude: "AllTrusted, 2 named locations" },
      signInRisk: ["high"],
      userRisk: ["medium"],
      deviceFilter: 'exclude: device.model -eq "Kiosk"',
      grant: { operator: "AND", controls: ["mfa", "passwordChange"], termsOfUse: 1 },
      session: ["sign-in frequency 4 hours", "persistent browser never", "CAE strictEnforcement"],
    });
  });

  it("survives malformed input", () => {
    assert.deepEqual(compactConditionalAccessPolicy(null, NOW), { name: "(unnamed policy)", state: "unknown", users: { include: {} } });
  });
});

describe("counts and top template filters", () => {
  const ctx = {
    grouped: { Windows: [{}, {}, {}], macOS: [{}], __proto__x: [] as unknown[] },
    tally: { a: 5, b: 9, c: 1, d: 3 },
  };

  it("turns grouped records into counts", () => {
    assert.deepEqual(renderTemplate("{{ grouped | counts }}", ctx), { Windows: 3, macOS: 1, __proto__x: 0 });
  });

  it("keeps the largest buckets and sums the rest", () => {
    assert.deepEqual(renderTemplate("{{ tally | top(2) }}", ctx), { b: 9, a: 5, "(other 2 values)": 4 });
    assert.deepEqual(renderTemplate("{{ tally | top(10) }}", ctx), { b: 9, a: 5, d: 3, c: 1 });
    assert.deepEqual(renderTemplate("{{ grouped | top(1) }}", ctx), { Windows: 3, "(other 2 values)": 1 });
  });

  it("keeps a __proto__ bucket as an ordinary key", () => {
    const hostile = JSON.parse('{"__proto__": [1, 2], "x": [1]}') as Record<string, unknown[]>;
    const out = renderTemplate("{{ hostile | counts }}", { hostile }) as Record<string, number>;
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, 2);
  });
});
