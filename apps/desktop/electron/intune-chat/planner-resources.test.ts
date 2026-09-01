import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GRAPH_CACHE_RESOURCE_KINDS } from "@openadminos/agent-sdk";

import {
  DEFAULT_RESOURCE_STALENESS_MS,
  resourceStalenessMs,
} from "../state-helpers.js";
import {
  GRAPH_CACHE_RESOURCES,
  MAX_PLANNED_RESOURCES,
  definitionForResource,
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
