import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GRAPH_CACHE_RESOURCE_KINDS } from "@openadminos/agent-sdk";

import {
  GRAPH_CACHE_RESOURCES,
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
