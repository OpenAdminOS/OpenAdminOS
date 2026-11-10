import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  GRAPH_CACHE_RESOURCE_KINDS,
  type AgentSummary,
  type GraphCacheResourceKind,
  type TenantRecord,
} from "@openadminos/agent-sdk";

import {
  DEFAULT_RESOURCE_STALENESS_MS,
  resourceStalenessMs,
} from "../state-helpers.js";
import {
  GRAPH_CACHE_RESOURCES,
  MAX_PLANNED_RESOURCES,
  buildAnswerPack,
  definitionForResource,
  asksHowTo,
  graphCacheResourcesForWrite,
  hasStrongTenantReference,
  hasTenantReference,
  matchAgentsToQuestion,
  pathForResource,
  planChatContext,
  requiredScopesForResources,
} from "./planner.js";

describe("Graph cache resource registry", () => {
  it("defines a label, scope set, and request path for every resource kind", () => {
    for (const resource of GRAPH_CACHE_RESOURCE_KINDS) {
      const definition = definitionForResource(resource);
      assert.ok(definition.label.length > 0, `${resource} needs a label`);
      assert.ok(definition.scopes.length > 0, `${resource} needs at least one scope`);
      const request = pathForResource(resource);
      assert.ok(request.path.startsWith("/"), `${resource} needs a Graph path`);
    }
    assert.equal(GRAPH_CACHE_RESOURCES.length, GRAPH_CACHE_RESOURCE_KINDS.length);
  });

  it("maps write scopes and action paths to cache resources to invalidate", () => {
    assert.deepEqual(
      graphCacheResourcesForWrite({ scopes: ["DeviceManagementManagedDevices.PrivilegedOperations.All"] }).sort(),
      [
        "autopilotEvents",
        "detectedApps",
        "entraDevices",
        "managedDeviceEncryptionStates",
        "managedDeviceOverview",
        "managedDevices",
        "troubleshootingEvents",
      ],
    );
    assert.deepEqual(
      graphCacheResourcesForWrite({ scopes: ["User.ReadWrite.All"] }).sort(),
      ["groups", "users"],
    );
    // Every sibling resource in a scope family is covered, not a
    // hand-picked subset.
    assert.deepEqual(
      graphCacheResourcesForWrite({ scopes: ["DeviceManagementApps.ReadWrite.All"] }).sort(),
      [
        "androidManagedAppProtections",
        "iosManagedAppProtections",
        "managedAppPolicies",
        "mobileAppConfigurations",
        "mobileApps",
      ],
    );
    const configurationWrite = graphCacheResourcesForWrite({
      scopes: ["DeviceManagementConfiguration.ReadWrite.All"],
    });
    for (const expected of [
      "deviceCompliancePolicies",
      "groupPolicyConfigurations",
      "assignmentFilters",
      "windowsQualityUpdateProfiles",
      "windowsFeatureUpdateProfiles",
      "endpointSecurityIntents",
    ] as const) {
      assert.ok(configurationWrite.includes(expected), `expected ${expected} to be invalidated`);
    }
    // A write family no cache resource reads with widens to every
    // resource instead of silently keeping its area fresh.
    assert.equal(
      graphCacheResourcesForWrite({
        scopes: ["DeviceManagementManagedDevices.ReadWrite.All", "Mail.ReadWrite"],
      }).length,
      GRAPH_CACHE_RESOURCES.length,
    );
    assert.deepEqual(
      graphCacheResourcesForWrite({ paths: ["/users/abc/revokeSignInSessions"] }),
      ["users"],
    );
    // One unmapped path in a mixed batch widens to everything: the
    // mapped path must not suppress the conservative fallback.
    assert.equal(
      graphCacheResourcesForWrite({
        paths: ["/users/abc", "/directory/deletedItems/xyz/restore"],
      }).length,
      GRAPH_CACHE_RESOURCES.length,
    );
    assert.equal(
      graphCacheResourcesForWrite({ scopes: ["Mail.ReadWrite"] }).length,
      GRAPH_CACHE_RESOURCE_KINDS.length,
    );
  });

  it("maps the Entra and Defender resources to their delegated read scopes", () => {
    assert.deepEqual(requiredScopesForResources(["directoryRoles"]), [
      "RoleManagement.Read.Directory",
    ]);
    assert.deepEqual(requiredScopesForResources(["administrativeUnits"]), [
      "AdministrativeUnit.Read.All",
    ]);
    assert.deepEqual(requiredScopesForResources(["domains"]), ["Domain.Read.All"]);
    assert.deepEqual(
      requiredScopesForResources(["securityAlerts", "securityIncidents"]),
      ["SecurityAlert.Read.All", "SecurityIncident.Read.All"],
    );
    assert.deepEqual(
      requiredScopesForResources(["secureScores", "secureScoreControlProfiles"]),
      ["SecurityEvents.Read.All"],
    );
    assert.deepEqual(
      requiredScopesForResources(["namedLocations", "authenticationMethodsPolicy"]),
      ["Policy.Read.All"],
    );
  });
});

describe("planner prefetch hints for Entra and Defender questions", () => {
  const planned = (question: string) => planChatContext(question).resources;

  it("prefetches Defender alerts and incidents for incident questions", () => {
    const resources = planned("Any high-severity Defender incidents this week?");
    assert.ok(resources.includes("securityAlerts"));
    assert.ok(resources.includes("securityIncidents"));
  });

  it("prefetches Secure Score resources for posture questions", () => {
    const resources = planned("How has our secure score changed recently?");
    assert.ok(resources.includes("secureScores"));
    assert.ok(resources.includes("secureScoreControlProfiles"));
  });

  it("prefetches app credentials for expiry questions", () => {
    const resources = planned("Which app registration secrets expire in 30 days?");
    assert.ok(resources.includes("applications"));
    assert.ok(resources.includes("servicePrincipals"));
  });

  it("prefetches named locations for trusted-location questions", () => {
    const resources = planned(
      "Which Conditional Access policies rely on a trusted location?",
    );
    assert.ok(resources.includes("namedLocations"));
    assert.ok(resources.includes("conditionalAccessPolicies"));
  });

  it("prefetches directory roles for privileged-access questions", () => {
    const resources = planned("Which users hold privileged directory roles?");
    assert.ok(resources.includes("directoryRoles"));
    assert.ok(resources.includes("users"));
  });

  it("prefetches cross-tenant access policy for B2B questions", () => {
    const resources = planned("What does our cross-tenant B2B collaboration policy allow?");
    assert.ok(resources.includes("crossTenantAccessPolicy"));
  });
});

describe("planner keyword matching is anchored to word boundaries", () => {
  const planned = (question: string) => planChatContext(question).resources;

  it("does not match a keyword inside an unrelated word", () => {
    // "esp" used to match "respond" and pull in the whole Autopilot
    // group; "app" used to match "happened"; "os" used to match "cost".
    const respond = planned("Please respond with a list of our conditional access policies");
    assert.ok(
      !respond.includes("windowsAutopilotDevices"),
      `"respond" must not plan Autopilot resources; planned ${respond.join(", ")}`,
    );

    const happened = planned("Summarize what happened in the tenant this week");
    assert.ok(
      !happened.includes("detectedApps"),
      `"happened" must not plan app inventory; planned ${happened.join(", ")}`,
    );

    const cost = planned("What is the cost of our licenses?");
    assert.ok(
      !cost.includes("entraDevices"),
      `"cost" must not match the "os" keyword; planned ${cost.join(", ")}`,
    );
  });

  it("still matches plural and inflected forms of a keyword", () => {
    assert.ok(planned("Show me sign-ins that failed").includes("signIns"));
    assert.ok(planned("How many devices do we have?").includes("managedDevices"));
    assert.ok(
      planned("Why did a newly enrolled device get local admin?").includes(
        "windowsAutopilotProfiles",
      ),
      "'enrolled' must match the 'enroll' keyword",
    );
    assert.ok(
      planned("Which platforms have the highest noncompliance rate?").includes(
        "deviceCompliancePolicies",
      ),
      "'noncompliance' must match the compliance rule",
    );
  });

  it("routes a change question to audit history rather than app inventory", () => {
    const resources = planned("Summarize what happened in the tenant this week");
    assert.ok(resources.includes("directoryAudits"));
    assert.ok(resources.includes("intuneAuditEvents"));
  });

  it("plans no Graph refresh for small talk", () => {
    for (const greeting of ["hi", "Hello", "thanks!", "ok"]) {
      assert.deepEqual(
        planChatContext(greeting).resources,
        [],
        `${greeting} must not trigger a tenant refresh`,
      );
    }
    // A real question that merely starts politely still plans context.
    assert.ok(planChatContext("Hello, how many devices do we have?").resources.length > 0);
  });

  it("never plans more resources than the runaway guard allows", () => {
    const noisy = planned(
      "policy compliance app autopilot update remediation sign-in audit assignment group user device defender secure score domain",
    );
    assert.ok(noisy.length <= MAX_PLANNED_RESOURCES);
  });
});

describe("agent matcher probe table (real registry)", () => {
  // The executed probe from tasks/chat-full-test-2026-10-24.md F7,
  // kept as a maintained test against the shipped registry index so
  // matcher regressions fail CI instead of surfacing as noisy cards.
  async function registryAgents(): Promise<AgentSummary[]> {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = await readFile(join(here, "../../../../agents/index.json"), "utf8");
    const index = JSON.parse(raw) as { agents: Array<Record<string, unknown>> };
    return index.agents.map(
      (agent) => ({ ...agent, installedAt: "2026-06-01T10:00:00.000Z" }) as unknown as AgentSummary,
    );
  }

  const slugs = (suggestions: ReturnType<typeof matchAgentsToQuestion>) =>
    suggestions.map((suggestion) => suggestion.agentSlug);

  it("routes the probe prompts to the expected agents", async () => {
    const agents = await registryAgents();
    assert.equal(agents.length, 16);

    const inactive = matchAgentsToQuestion("Which devices have not synced in 45 days?", agents);
    assert.equal(inactive[0]?.agentSlug, "find-inactive-devices");
    assert.ok(!slugs(inactive).includes("team-script-draft"), "script helper must not ride a device question");

    const guests = matchAgentsToQuestion("Disable stale guest accounts that have not signed in", agents);
    assert.equal(guests[0]?.agentSlug, "stale-guest-cleanup");
    assert.ok(!slugs(guests).includes("offboarding-agent"), "device offboarder must not match a guest-account request");

    const guestsRead = matchAgentsToQuestion("Show stale guest accounts that have not signed in", agents);
    assert.ok(!slugs(guestsRead).includes("offboarding-agent"));
    assert.ok(guestsRead.every((suggestion) => suggestion.mode === "read"));

    const signIns = matchAgentsToQuestion("Why are sign-ins failing for finance users?", agents);
    assert.equal(signIns[0]?.agentSlug, "sign-in-failure-explainer");

    const retire = matchAgentsToQuestion("Retire the 47 devices that are not encrypted", agents);
    assert.equal(retire[0]?.agentSlug, "offboarding-agent");
    assert.equal(retire[0]?.mode, "write");

    assert.equal(planChatContext("Grant the finance group access to the VPN app").hasWriteIntent, true);
    assert.equal(planChatContext("Update the compliance policy to require encryption").hasWriteIntent, true);

    const updatePolicy = matchAgentsToQuestion("Update the compliance policy to require encryption", agents);
    assert.equal(updatePolicy[0]?.agentSlug, "compliance-overview");
    assert.ok(!slugs(updatePolicy).includes("os-update-posture"), "imperative update is an action, not the OS-update topic");

    const complianceCount = matchAgentsToQuestion("How many of my devices are noncompliant?", agents);
    assert.ok(slugs(complianceCount).includes("compliance-overview"));
    assert.ok(!slugs(complianceCount).includes("team-script-draft"));

    const compliancePolicies = matchAgentsToQuestion("Which device compliance policies exist?", agents);
    assert.equal(compliancePolicies[0]?.agentSlug, "compliance-overview");
  });

  it("suggests no agent on generic device words alone, and at most one agent", async () => {
    const agents = await registryAgents();
    // A Defender follow-up shares only "devices", "macOS" and "Intune" with the device agents.
    assert.deepEqual(slugs(matchAgentsToQuestion("Check our 5 macOS devices for Defender in Intune", agents)), []);
    assert.deepEqual(slugs(matchAgentsToQuestion("Show our Intune devices", agents)), []);
    for (const question of ["Which devices have not synced in 45 days?", "How many of my devices are noncompliant?", "Why are sign-ins failing for finance users?"]) {
      assert.equal(matchAgentsToQuestion(question, agents).length, 1, question);
    }
  });

  it("suggests no agent on the word app alone, and keeps the agent its own topic names", async () => {
    const agents = await registryAgents();
    // A how-to about packaging an installer shares only "app" with "Dormant app registrations".
    assert.deepEqual(slugs(matchAgentsToQuestion("how do I upload my first app?", agents)), []);
    assert.deepEqual(slugs(matchAgentsToQuestion("How do I deploy an application?", agents)), []);
    const dormant = matchAgentsToQuestion("Which app registrations are dormant?", agents);
    assert.deepEqual(slugs(dormant), ["dormant-app-registrations"]);
    assert.equal(dormant[0]!.reason, "This installed read agent matched app terms from the investigation.");
  });
});

describe("tenant references that overrule a docs label", () => {
  it("leaves first-person wording in a how-to to the model", () => {
    for (const question of ["how do I upload my first app?", "How do we set up our first deployment template?", "How can I connect my Intune to it?", "How should we roll this out to us first?", "How do I upload My first app?"]) {
      assert.equal(asksHowTo(question), true, question);
      assert.equal(hasTenantReference(question), true, question);
      assert.equal(hasStrongTenantReference(question), false, question);
    }
  });

  it("keeps state words, tenant values and other question forms as tenant references", () => {
    for (const question of [
      "How do I list my noncompliant devices?",
      "How do I see which of my devices are encrypted?",
      "How do I fix HR-LAPTOP-07?",
      "How do I reset the password of anna@contoso.com?",
      // Looking at the admin's own things asks for tenant facts.
      "How do I see my noncompliant devices?",
      "How do I view our failed sign-ins?",
      "How do I check if our devices are compliant?",
      "How do I verify our devices are encrypted?",
      "How do I know if we have stale devices?",
      "How can we tell if we are compliant with the CIS baseline?",
      "How do we do on secure score?",
      "How do we actually stand on Secure Score?",
      "How do we compare?",
      "How do I find our noncompliant devices?",
      "How do I quickly see my noncompliant devices?",
      "How do I look up my tenant ID?",
      "How do I tell if ours are compliant?",
      "How do I find out why our laptops keep failing enrollment?",
      "How do we do with secure score?",
      // A first-person word inside a tenant value is part of the value.
      "How do I reset the password for us@contoso.com?",
      "How do I unlock my@contoso.com?",
      "How do I rename US-LAPTOP-07?",
      "How does our tenant handle guest access?",
      // Not how-tos: they ask where the tenant stands or how something of ours behaves.
      "How do we compare to the CIS baseline?",
      "How does our compliance look?",
      "How do my devices stay compliant?",
      "How would we score on the secure score?",
      "How do I fix all my devices?",
      "How many of my devices are noncompliant?",
      "What do the docs say about our devices?",
      "Why does my device fail compliance?",
      "Can I see my noncompliant devices?",
      "Show our Intune devices",
    ]) {
      assert.equal(hasStrongTenantReference(question), true, question);
    }
    assert.equal(hasStrongTenantReference("How do I enroll macOS devices?"), false);
    // Looking at something general stays with the model, and so does doing something.
    assert.equal(hasStrongTenantReference("How do I check a policy setting in the portal?"), false);
    // A verb that also describes standing or looking is a procedure with a plain object.
    for (const question of [
      "How do we do a remote wipe?",
      "How do we perform an unattended installation?",
      "How do I perform my first app deployment?",
      "How do we look up an application ID?",
      "How do we perform in-place upgrades?",
      "How do we compare two policies?",
      "How do we stand up a new distribution point?",
      // The look is a purpose further on, not what the admin asks to do.
      "How do I configure Intune to monitor our devices?",
      "How do I set up a report to check our compliance?",
      "How do I tell my users to enroll?",
      "How do I tell my team about the new enrollment flow?",
      // Another clause, or something of the admin's that no tenant holds.
      "How do I check a policy setting before we deploy it?",
      "How do I set up a compliance policy that will check our devices daily?",
      "How do I make a report to review with my manager?",
      "How do I see my options in the enrollment wizard?",
      "How do I check my work before I assign the profile?",
      // A tenant word in a later phrase does not make the admin's "options" or "work" a tenant thing.
      "How do I see my options for device enrollment?",
      "How do I view my options for app protection?",
      "How do I check my work before deploying apps?",
      "How do we perform a remote wipe?",
    ]) {
      assert.equal(asksHowTo(question), true, question);
      assert.equal(hasStrongTenantReference(question), false, question);
    }
    assert.equal(asksHowTo("How does Agentic Packr package an installer?"), false);
    // Names are read as the pattern before the linear scan read them, at any length.
    const nameBefore = /\b[A-Z][A-Z0-9]*-[A-Z0-9-]*\d/;
    for (const [value, expected] of [
      ["HR-LAPTOP-07", true], ["CORPORATEWINDOWSAUTOPILOTENROLLMENTWORKSTATION-07", true], [`${"LONG".repeat(40)}-${"PART-".repeat(30)}7`, true],
      ["foo-BAR-1", true], ["A-1-B", true], ["CVE-2024-1234", true], ["KIOSK-0042.", true], ["(HR-LAPTOP-07)", true],
      ["fooBAR-1", false], ["HR7-X", false], ["M365", false], ["E5-", false], ["7A-B1", false], ["A-B", false], ["x_HR-07", false], ["-07", false],
    ] as Array<[string, boolean]>) {
      assert.equal(nameBefore.test(value), expected, `the earlier pattern on ${value}`);
      assert.equal(hasTenantReference(`Rename ${value}`), expected, value);
      assert.equal(hasStrongTenantReference(`How do I rename ${value}?`), expected, value);
    }
    // A question at the length limit still finds its tenant value, and one without any has none.
    assert.equal(hasStrongTenantReference(`How do we upload ${"a".repeat(19900)}?`), false);
    assert.equal(hasStrongTenantReference(`How do we rename ${"A-".repeat(9900)}x?`), false);
    assert.equal(hasStrongTenantReference(`How do we upload ${"a".repeat(19800)} for b@contoso.com?`), true);
    assert.equal(asksHowTo("How to package an installer"), true);
  });
});

describe("answer pack fallback breakdowns", () => {
  it("counts common filtered dimensions and array values", () => {
    const rows = Object.fromEntries(
      GRAPH_CACHE_RESOURCE_KINDS.map((resource) => [resource, []]),
    ) as unknown as Record<GraphCacheResourceKind, unknown[]>;
    rows.conditionalAccessPolicies = [
      { id: "ca-1", state: "enabledForReportingButNotEnforced" },
      { id: "ca-2", state: "enabled" },
    ];
    rows.configurationPolicies = [
      { id: "cp-1", platforms: ["windows10", "macOS"] },
      { id: "cp-2", platforms: ["macOS"] },
      { id: "cp-3", platforms: "windows10,macOS" },
    ];
    rows.groups = [
      { id: "g-1", securityEnabled: true, groupTypes: ["DynamicMembership"] },
      { id: "g-2", securityEnabled: false, groupTypes: ["Unified"] },
    ];
    rows.signIns = [
      {
        id: "si-1",
        conditionalAccessStatus: "failure",
        status: { errorCode: 50126, failureReason: "Invalid username or password" },
      },
    ];
    const tenant: TenantRecord = {
      id: "tenant-1",
      displayName: "Tenant",
      username: "admin@example.com",
      homeAccountId: "home-1",
      addedAt: "2026-06-01T00:00:00.000Z",
    };
    const status = (resource: GraphCacheResourceKind, count: number) => ({
      resource,
      label: resource,
      rows: count,
      scopeSet: ["Read.All"],
      refreshedAt: "2026-06-01T10:00:00.000Z",
    });
    const pack = JSON.parse(
      buildAnswerPack({
        question: "How many report-only Conditional Access policies?",
        tenant,
        cacheStatus: [
          status("conditionalAccessPolicies", 2),
          status("configurationPolicies", 3),
          status("groups", 2),
          status("signIns", 1),
        ],
        rows,
        hasWriteIntent: false,
        agentSuggestions: [],
      }),
    ) as {
      resources: Array<{
        resource: string;
        breakdowns: Record<string, Record<string, number>>;
      }>;
    };
    const byResource = new Map(pack.resources.map((entry) => [entry.resource, entry.breakdowns]));
    assert.equal(
      byResource.get("conditionalAccessPolicies")?.state?.enabledForReportingButNotEnforced,
      1,
    );
    assert.equal(byResource.get("configurationPolicies")?.platforms?.macOS, 3);
    assert.equal(byResource.get("configurationPolicies")?.platforms?.windows10, 2);
    assert.equal(byResource.get("groups")?.groupTypes?.DynamicMembership, 1);
    assert.equal(byResource.get("groups")?.securityEnabled?.true, 1);
    assert.equal(byResource.get("signIns")?.["status.errorCode"]?.["50126"], 1);
    assert.equal(byResource.get("conditionalAccessPolicies")?.severity, undefined);
  });
});

describe("per-resource cache freshness", () => {
  it("expires fast-moving signal sooner than slow-moving configuration", () => {
    assert.ok(
      resourceStalenessMs("signIns") < resourceStalenessMs("managedDevices"),
      "sign-in data must go stale sooner than device inventory",
    );
    assert.ok(
      resourceStalenessMs("managedDevices") <
        resourceStalenessMs("windowsAutopilotProfiles"),
      "device inventory must go stale sooner than Autopilot profiles",
    );
    assert.equal(resourceStalenessMs("directoryAudits"), 15 * 60 * 1000);
    assert.equal(
      resourceStalenessMs("windowsAutopilotProfiles"),
      DEFAULT_RESOURCE_STALENESS_MS,
    );
  });
});
