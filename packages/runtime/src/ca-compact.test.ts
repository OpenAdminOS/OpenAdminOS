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
        authenticationStrength: { id: "00000000-0000-0000-0000-000000000004", displayName: "Phishing-resistant MFA", policyType: "builtIn", requirementsSatisfied: "mfa", allowedCombinations: ["fido2"] },
      },
    }, NOW);
    assert.deepEqual(record, {
      name: "Require MFA for administrators",
      state: "enabled",
      modifiedDaysAgo: 1036,
      users: {
        include: { roles: ["Global Administrator", "1 other role"] },
        exclude: { users: "2 users", groups: 1 },
      },
      apps: { include: "All" },
      grant: { authStrength: { name: "Phishing-resistant MFA", type: "builtIn", satisfies: "mfa" } },
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

  it("keeps the grant operator whenever a policy has more than one requirement", () => {
    const policy = (operator: string) => compactConditionalAccessPolicy({
      displayName: "MFA or terms", state: "enabled",
      grantControls: { operator, builtInControls: ["mfa"], termsOfUse: ["t1"], customAuthenticationFactors: [] },
    }, NOW);
    assert.deepEqual(policy("OR").grant, { operator: "OR", controls: ["mfa"], termsOfUse: 1 });
    assert.deepEqual(policy("AND").grant, { operator: "AND", controls: ["mfa"], termsOfUse: 1 });
    const strength = compactConditionalAccessPolicy({
      displayName: "Strength or compliant", state: "enabled",
      grantControls: { operator: "OR", builtInControls: ["compliantDevice"], authenticationStrength: { displayName: "Multifactor authentication" } },
    }, NOW);
    assert.equal(strength.grant && (strength.grant as { operator?: string }).operator, "OR");
    const custom = compactConditionalAccessPolicy({
      displayName: "Admin strength", state: "enabled",
      grantControls: { operator: "OR", builtInControls: [], authenticationStrength: { displayName: "Admin MFA", policyType: "custom", requirementsSatisfied: "none" } },
    }, NOW);
    assert.deepEqual(custom.grant, { authStrength: { name: "Admin MFA", type: "custom", satisfies: "none" } });
        const single = compactConditionalAccessPolicy({
      displayName: "Block", state: "enabled", grantControls: { operator: "OR", builtInControls: ["block"] },
    }, NOW);
    assert.deepEqual(single.grant, { controls: ["block"] });
  });

    it("shows workload identity, insider risk and any other set condition", () => {
    const record = compactConditionalAccessPolicy({
      displayName: "Workload identities", state: "enabled",
      conditions: {
        users: { includeUsers: ["None"] },
        clientApplications: { includeServicePrincipals: ["sp-1", "sp-2"], excludeServicePrincipals: [], servicePrincipalFilter: null },
        insiderRiskLevels: "elevated,moderate",
        times: null,
        deviceStates: { includeStates: ["All"], excludeStates: ["Compliant"] },
        agents: null,
      },
      grantControls: { operator: "OR", builtInControls: ["block"] },
    }, NOW);
    assert.deepEqual(record.workloadIdentities, { include: "2 service principals" });
    const agentOnly = compactConditionalAccessPolicy({
      displayName: "Agent actions", state: "enabled",
      conditions: { applications: { includeApplications: [], includeAgentActions: ["action-1", "action-2"] } },
    }, NOW);
    assert.deepEqual(agentOnly.apps, { agentActions: 2 });
    assert.deepEqual(record.insiderRisk, ["elevated", "moderate"]);
    assert.deepEqual(record.otherConditions, ["deviceStates"]);
    assert.deepEqual(record.users, { include: { users: "None" } });
  });

  it("tells two workload identity policies with null users apart", () => {
    const policy = (ids: string[]) => compactConditionalAccessPolicy({
      displayName: "Block service principals", state: "enabled",
      conditions: { users: null, clientApplications: { includeServicePrincipals: ids } },
      grantControls: { operator: "OR", builtInControls: ["block"] },
    }, NOW);
    const one = policy(["sp-1"]);
    const all = policy(["ServicePrincipalsInMyTenant"]);
    assert.equal(one.users, undefined);
    assert.deepEqual(one.workloadIdentities, { include: "1 service principal" });
    assert.deepEqual(all.workloadIdentities, { include: "ServicePrincipalsInMyTenant" });
  });

    it("keeps device states set without a filter, current and deprecated names", () => {
    const current = compactConditionalAccessPolicy({
      displayName: "Exclude compliant", state: "enabled",
      conditions: { devices: { includeDevices: ["All"], excludeDevices: ["Compliant", "DomainJoined"], deviceFilter: null } },
    }, NOW);
    assert.deepEqual(current.deviceStates, { include: "All", exclude: "Compliant, DomainJoined" });
    const legacy = compactConditionalAccessPolicy({
      displayName: "Legacy", state: "enabled",
      conditions: { devices: { includeDeviceStates: ["All"], excludeDeviceStates: ["Compliant"] } },
    }, NOW);
    assert.deepEqual(legacy.deviceStates, { include: "All", exclude: "Compliant" });
  });

    it("survives malformed input", () => {
    assert.deepEqual(compactConditionalAccessPolicy(null, NOW), { name: "(unnamed policy)", state: "unknown" });
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
    assert.deepEqual(renderTemplate("{{ tally | top(2) }}", ctx), { top: { b: 9, a: 5 }, otherValues: 2, otherCount: 4 });
    assert.deepEqual(renderTemplate("{{ tally | top(10) }}", ctx), { b: 9, a: 5, d: 3, c: 1 });
    assert.deepEqual(renderTemplate("{{ grouped | top(1) }}", ctx), { top: { Windows: 3 }, otherValues: 2, otherCount: 1 });
  });

  it("keeps a tenant bucket that looks like the summary", () => {
    const tally = { "(other 2 values)": 10, x: 2, y: 1 };
    assert.deepEqual(renderTemplate("{{ tally | top(1) }}", { tally }), { top: { "(other 2 values)": 10 }, otherValues: 2, otherCount: 3 });
  });

  it("keeps a __proto__ bucket as an ordinary key", () => {
    const hostile = JSON.parse('{"__proto__": [1, 2], "x": [1]}') as Record<string, unknown[]>;
    const out = renderTemplate("{{ hostile | counts }}", { hostile }) as Record<string, number>;
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(out, "__proto__")?.value, 2);
  });
});

describe("count-by-field with array values", () => {
  it("puts empty arrays in the missing bucket only when one is named", async () => {
    const { parseAgentTemplate, runAgentTemplate } = await import("./agent-template.js");
    const rows = [{ levels: [] }, { levels: ["high"] }, { levels: ["high", "medium"] }, { levels: [] }];
    const manifest = (missing: string) => parseAgentTemplate(JSON.stringify({
      descriptor: { id: "count-test", name: "Count", description: "Count", version: "1.0.0", category: "policies", mode: "read" },
      skills: [
        { id: "rows", format: "graph", label: "Read", settings: { method: "GET", path: "/identity/conditionalAccess/policies" } },
        { id: "by_level", format: "transform", label: "Count", settings: { kind: "count-by-field", source: "{{ rows.output }}", field: "levels", ...(missing ? { missingBucket: missing } : {}) } },
      ],
      definition: { triggers: [{ id: "manual", kind: "manual" }], result: { summary: "done", data: { counts: "{{ by_level.output }}" } } },
    }));
    const ctx = {
      agent: { id: "count-test" }, providerId: "ollama",
      graph: { request: async () => ({ value: rows }) },
      llm: { available: false }, log: () => {},
      step: async (_label: string, _detail: string, fn: () => Promise<unknown>) => fn(),
    } as never;
    const named = await runAgentTemplate(manifest("(none)"), ctx);
    assert.deepEqual((named.result as { counts: unknown }).counts, { "(none)": 2, high: 1, "high,medium": 1 });
    const unnamed = await runAgentTemplate(manifest(""), ctx);
    assert.deepEqual((unnamed.result as { counts: unknown }).counts, { "": 2, high: 1, "high,medium": 1 });
  });

  it("keeps the largest buckets with the top setting and leaves smaller maps as they are", async () => {
    const { parseAgentTemplate, runAgentTemplate } = await import("./agent-template.js");
    const rows = ["a", "a", "a", "b", "b", "c", "d"].map((user) => ({ user }));
    const run = async (top: number) => runAgentTemplate(parseAgentTemplate(JSON.stringify({
      descriptor: { id: "top-test", name: "Top", description: "Top", version: "1.0.0", category: "policies", mode: "read" },
      skills: [
        { id: "rows", format: "graph", label: "Read", settings: { method: "GET", path: "/auditLogs/signIns" } },
        { id: "by_user", format: "transform", label: "Count", settings: { kind: "count-by-field", source: "{{ rows.output }}", field: "user", top } },
      ],
      definition: { triggers: [{ id: "manual", kind: "manual" }], result: { summary: "done", data: { counts: "{{ by_user.output }}" } } },
    })), {
      agent: { id: "top-test" }, providerId: "ollama", graph: { request: async () => ({ value: rows }) },
      llm: { available: false }, log: () => {}, step: async (_l: string, _d: string, fn: () => Promise<unknown>) => fn(),
    } as never);
    assert.deepEqual(((await run(2)).result as { counts: unknown }).counts, { top: { a: 3, b: 2 }, otherValues: 2, otherCount: 2 });
    assert.deepEqual(((await run(10)).result as { counts: unknown }).counts, { a: 3, b: 2, c: 1, d: 1 });
  });
});

describe("bucket lookups", () => {
  it("reads a parenthesized bucket exactly, and zero when it is absent", () => {
    assert.equal(renderTemplate("{{ g.output.(unset) | size }}", { g: { output: { "(unset)": [1, 2, 3], US: [1] } } }), 3);
    assert.equal(renderTemplate("{{ g.output.(unset) | size }}", { g: { output: { US: [1] } } }), 0);
  });
});
