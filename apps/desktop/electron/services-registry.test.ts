import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BASELINE_SCOPES,
  BASELINE_SERVICE_SCOPES,
  DEFAULT_GRAPH_READ_SCOPE_NAMES,
  GRAPH_DELEGATED_PERMISSION_IDS,
  SERVICES,
  SERVICE_PARTS,
  grantedParts,
  grantedScopeSet,
  grantsFromTokenScopes,
  mergeGrantedScopes,
  missingPartsForScopes,
  missingServiceCopy,
  missingServicesForAgent,
  agentServiceIds,
  notGrantedServiceForScopes,
  parseScope,
  partIdsFor,
  partLabel,
  qualifyScope,
  requestedScopes,
  serviceForScope,
  serviceStatus,
  toResourceScope,
} from "@openadminos/agent-sdk";

import { GRAPH_CACHE_RESOURCES } from "./intune-chat/planner.js";

// The delegated permission IDs checked with Lokka on 2026-11-04
// (tasks/todo.md, "Lokka verification"). Copied here so a registry edit
// cannot silently change a verified ID.
const LOKKA_VERIFIED_IDS: Record<string, string> = {
  openid: "37f7f235-527c-4136-accd-4a02d197296e",
  profile: "14dad69e-099b-42c9-810b-d002981feec1",
  offline_access: "7427e0e9-2fba-42fe-b0c0-848c9e6a8182",
  "User.Read": "e1fe6dd8-ba31-4d61-89e7-88639da4683d",
  "DeviceManagementManagedDevices.Read.All": "314874da-47d6-4978-88dc-cf0d37f0bb82",
  "DeviceManagementConfiguration.Read.All": "f1493658-876a-4c87-8fa7-edb559b3476a",
  "DeviceManagementApps.Read.All": "4edf5f54-4666-44af-9de9-0144fb4b6e8c",
  "DeviceManagementServiceConfig.Read.All": "8696daa5-bce5-4b2e-83f9-51b6defc4e1e",
  "DeviceManagementScripts.Read.All": "d32381d8-ee89-4220-9c83-b672aa68d404",
  "DeviceManagementRBAC.Read.All": "49f0cc30-024c-4dfd-ab3e-82e137ee5431",
  "Device.Read.All": "951183d1-1a61-466f-a6d1-1fde911bfd95",
  "GroupMember.Read.All": "bc024368-1153-4739-b217-4326f2e966d0",
  "Organization.Read.All": "4908d5b9-3fb2-4b1e-9336-1888b7937185",
  "Directory.Read.All": "06da0dbc-49e2-44d2-8312-53f166ab848a",
  "User.Read.All": "a154be20-db9c-4678-8ab7-66f6cc099a59",
  "User.ReadBasic.All": "b340eb25-3456-403f-be2f-af7a0d370277",
  "Policy.Read.All": "572fea84-0151-49b2-9301-11cb16974376",
  "Application.Read.All": "c79f8feb-a9db-4090-85f9-90d820caa0eb",
  "AuditLog.Read.All": "e4c9e354-4dc5-45b8-9e7c-e1393b0b1a20",
  "IdentityRiskyUser.Read.All": "d04bb851-cb7c-4146-97c7-ca3e71baf56c",
  "SecurityEvents.Read.All": "64733abd-851e-478a-bffb-e47a14b18235",
  "RoleManagement.Read.Directory": "741c54c3-0c1e-44a1-818b-3f97ab4e8c83",
  "AdministrativeUnit.Read.All": "3361d15d-be43-4de6-b441-3c746d05163d",
  "Domain.Read.All": "2f9ee017-59c1-4f1d-9472-bd5529a7b311",
  "SecurityAlert.Read.All": "bc257fb8-46b4-4b15-8713-01e91bfbe4ea",
  "SecurityIncident.Read.All": "b9abcc4f-94fc-4457-9141-d20ce80ec952",
  "ThreatHunting.Read.All": "b152eca8-ea73-4a48-8c98-1a6742673d99",
};

// The read set every tenant consented to before services existed.
const PRE_SERVICES_DEFAULT_SCOPES = [
  "DeviceManagementManagedDevices.Read.All",
  "DeviceManagementConfiguration.Read.All",
  "DeviceManagementApps.Read.All",
  "DeviceManagementServiceConfig.Read.All",
  "DeviceManagementScripts.Read.All",
  "DeviceManagementRBAC.Read.All",
  "Device.Read.All",
  "GroupMember.Read.All",
  "Organization.Read.All",
  "Directory.Read.All",
  "User.Read.All",
  "Policy.Read.All",
  "Application.Read.All",
  "AuditLog.Read.All",
  "IdentityRiskyUser.Read.All",
  "SecurityEvents.Read.All",
  "RoleManagement.Read.Directory",
  "AdministrativeUnit.Read.All",
  "Domain.Read.All",
  "SecurityAlert.Read.All",
  "SecurityIncident.Read.All",
];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const allScopes = () => [
  ...BASELINE_SERVICE_SCOPES,
  ...SERVICES.flatMap((service) => service.parts.flatMap((part) => part.scopes)),
];

describe("service registry", () => {
  it("keeps the baseline to exactly the four sign-in scopes", () => {
    assert.deepEqual([...BASELINE_SCOPES], ["openid", "profile", "offline_access", "User.Read"]);
    assert.deepEqual(BASELINE_SERVICE_SCOPES.map((scope) => scope.name), [...BASELINE_SCOPES]);
    assert.deepEqual(
      requestedScopes([]).map((scope) => scope.name),
      [...BASELINE_SCOPES],
    );
  });

  it("covers every pre-services default read scope except Directory.Read.All", () => {
    const partScopes = new Set(SERVICE_PARTS.flatMap((part) => part.scopes.map((scope) => scope.name)));
    for (const scope of PRE_SERVICES_DEFAULT_SCOPES) {
      if (scope === "Directory.Read.All") continue;
      assert.ok(partScopes.has(scope), `${scope} must belong to a part`);
    }
    assert.equal(partScopes.has("Directory.Read.All"), false);
    for (const service of SERVICES) {
      for (const part of service.parts) {
        assert.equal(
          part.scopes.some((scope) => scope.name === "Directory.Read.All"),
          false,
          `${part.id} must not request Directory.Read.All`,
        );
      }
    }
  });

  it("never lists a scope twice within a part", () => {
    for (const service of SERVICES) {
      for (const part of service.parts) {
        const names = part.scopes.map((scope) => scope.name);
        assert.equal(new Set(names).size, names.length, `${part.id} lists a scope twice`);
        assert.equal(part.service, service.id);
        assert.ok(part.id.startsWith(`${service.id}.`));
      }
    }
  });

  it("owns every Graph cache resource with a part that covers its scopes", () => {
    for (const definition of GRAPH_CACHE_RESOURCES) {
      const owners = SERVICE_PARTS.filter((part) => part.cacheResources.includes(definition.resource));
      assert.ok(owners.length > 0, `${definition.resource} has no owning part`);
      for (const owner of owners) {
        const scopes = new Set(owner.scopes.map((scope) => scope.name));
        for (const scope of definition.scopes) {
          assert.ok(scopes.has(scope), `${owner.id} owns ${definition.resource} but lacks ${scope}`);
        }
      }
    }
  });

  it("pins every permission ID to the Lokka verified table", () => {
    assert.deepEqual({ ...GRAPH_DELEGATED_PERMISSION_IDS }, LOKKA_VERIFIED_IDS);
    const idsByName = new Map<string, string>();
    for (const scope of allScopes()) {
      assert.match(scope.permissionId, GUID, `${scope.name} has no GUID`);
      assert.equal(scope.permissionId, LOKKA_VERIFIED_IDS[scope.name], `${scope.name} ID differs from Lokka`);
      const known = idsByName.get(scope.name);
      if (known) assert.equal(known, scope.permissionId);
      idsByName.set(scope.name, scope.permissionId);
    }
    const ids = [...idsByName.values()];
    assert.equal(new Set(ids).size, ids.length, "permission IDs must be unique per scope");
  });

  it("requests nothing planned and nothing for planned services", () => {
    const planned = SERVICES.flatMap((service) =>
      service.status === "planned" ? [service.id] : service.parts.filter((part) => part.planned).map((part) => part.id),
    );
    assert.deepEqual(planned, ["defender.hunting", "exchange", "teams", "sharepoint"]);
    for (const service of SERVICES.filter((entry) => entry.status === "planned")) {
      assert.equal(service.parts.length, 0);
    }
    assert.equal(
      requestedScopes(["defender.hunting"]).some((scope) => scope.name === "ThreatHunting.Read.All"),
      false,
    );
    assert.deepEqual(partIdsFor(["exchange", "teams", "sharepoint"]), []);
  });

  it("deduplicates shared scopes across services", () => {
    const names = requestedScopes(partIdsFor(["intune", "entra", "defender"])).map((scope) => scope.name);
    assert.equal(new Set(names).size, names.length);
    assert.deepEqual(
      new Set(names),
      new Set([...BASELINE_SCOPES, ...PRE_SERVICES_DEFAULT_SCOPES.filter((scope) => scope !== "Directory.Read.All")]),
    );
  });
});

describe("qualified scopes", () => {
  it("parses stored, resource and bare forms as Graph and qualifies idempotently", () => {
    for (const form of ["graph:User.Read.All", "https://graph.microsoft.com/User.Read.All", " User.Read.All "]) {
      assert.deepEqual(parseScope(form), { audience: "graph", name: "User.Read.All" });
      assert.equal(qualifyScope(form), "graph:User.Read.All");
      assert.equal(qualifyScope(qualifyScope(form)), "graph:User.Read.All");
    }
    assert.equal(toResourceScope("graph:AuditLog.Read.All"), "https://graph.microsoft.com/AuditLog.Read.All");
    assert.equal(toResourceScope("offline_access"), "offline_access");
  });

  it("returns bare names per audience and all defaults when grants are unknown", () => {
    assert.deepEqual(grantedScopeSet({ grantedScopes: ["graph:User.Read.All", "Policy.Read.All"] }), new Set(["User.Read.All", "Policy.Read.All"]));
    assert.deepEqual(grantedScopeSet({}), new Set(DEFAULT_GRAPH_READ_SCOPE_NAMES));
    assert.deepEqual(grantedScopeSet({ kind: "sample", grantedScopes: [] }), new Set(DEFAULT_GRAPH_READ_SCOPE_NAMES));
    assert.equal(DEFAULT_GRAPH_READ_SCOPE_NAMES.length, 20);
  });

  it("merges into qualified grants without duplicates", () => {
    assert.deepEqual(
      mergeGrantedScopes({ grantedScopes: ["User.Read.All"] }, ["graph:User.Read.All", "https://graph.microsoft.com/Directory.Read.All"]),
      ["graph:User.Read.All", "graph:Directory.Read.All"],
    );
    assert.equal(mergeGrantedScopes({}, []).length, 20);
    assert.ok(mergeGrantedScopes({}, []).every((scope) => scope.startsWith("graph:")));
  });

  it("never records .default or OIDC scopes from a token", () => {
    assert.deepEqual(
      grantsFromTokenScopes(["openid", "profile", "offline_access", "https://graph.microsoft.com/.default", "User.Read", "DeviceManagementApps.Read.All"]),
      ["graph:User.Read", "graph:DeviceManagementApps.Read.All"],
    );
    assert.deepEqual(grantsFromTokenScopes(undefined), []);
  });
});

describe("grant status", () => {
  const intuneOnly = {
    grantedScopes: requestedScopes(partIdsFor(["intune"])).map((scope) => qualifyScope(scope.name)),
  };

  it("switches a part on only when all of its scopes are granted", () => {
    assert.deepEqual(grantedParts(intuneOnly).map((part) => part.id), ["intune.people", "intune.devices", "intune.apps", "entra.people", "entra.devices"]);
    assert.equal(serviceStatus(intuneOnly, "intune"), "connected");
    assert.equal(serviceStatus(intuneOnly, "entra"), "partial");
    assert.equal(serviceStatus(intuneOnly, "defender"), "missing");
    assert.equal(serviceStatus({}, "defender"), "connected");
  });

  it("names the missing part, preferring the caller's services for shared scopes", () => {
    const missing = missingPartsForScopes(["AuditLog.Read.All", "User.Read.All"], new Set<string>());
    assert.deepEqual(missing.map((part) => part.id), ["intune.people", "entra.signins"]);
    assert.deepEqual(
      missingPartsForScopes(["User.Read.All"], new Set<string>(), ["entra"]).map((part) => part.id),
      ["entra.people"],
    );
    assert.equal(partLabel(missing[1]!), "Entra sign-in logs");
    assert.equal(partLabel(SERVICE_PARTS.find((part) => part.id === "defender.score")!), "Defender Secure Score");
    assert.equal(serviceForScope("User.ReadWrite.All")?.id, "entra");
    assert.equal(serviceForScope("Directory.Read.All")?.id, "entra");
  });
});

describe("missing service copy", () => {
  const peopleOnly = {
    displayName: "Contoso",
    grantedScopes: ["graph:User.Read.All", "graph:GroupMember.Read.All", "graph:Organization.Read.All"],
  };

  it("names a service that has no part granted as not connected", () => {
    assert.equal(
      missingServiceCopy(peopleOnly, ["SecurityIncident.Read.All"]),
      "Defender is not connected for this tenant. Add it in Settings, Tenants.",
    );
    assert.equal(
      missingServiceCopy({ grantedScopes: [] }, ["SecurityIncident.Read.All", "DeviceManagementApps.Read.All"]),
      "Intune and Defender are not connected for this tenant. Add them in Settings, Tenants.",
    );
  });

  it("names the missing part of a partly connected service with the tenant", () => {
    assert.equal(
      missingServiceCopy(peopleOnly, ["AuditLog.Read.All"]),
      "This needs Entra sign-in logs, which is not granted for Contoso. Add it in Settings, Tenants.",
    );
  });

  it("is silent when everything is granted, for the sample tenant and for agent-only scopes", () => {
    assert.equal(missingServiceCopy(peopleOnly, ["User.Read.All"]), undefined);
    assert.equal(missingServiceCopy({ kind: "sample", grantedScopes: [] }, ["SecurityIncident.Read.All"]), undefined);
    assert.equal(missingServiceCopy(peopleOnly, ["Directory.Read.All"]), undefined);
  });

  it("describes the part a cache resource needs", () => {
    assert.deepEqual(notGrantedServiceForScopes(peopleOnly, ["SecurityAlert.Read.All"]), {
      serviceId: "defender",
      service: "Defender",
      partId: "defender.incidents",
      part: "Defender alerts and incidents",
      serviceMissing: true,
    });
    assert.equal(notGrantedServiceForScopes(peopleOnly, ["User.Read.All"]), undefined);
  });
});

describe("agent services", () => {
  it("uses the declaration or derives services from scopes", () => {
    assert.deepEqual(agentServiceIds({ services: ["defender"], scopes: [] }), ["defender"]);
    assert.deepEqual(agentServiceIds({ scopes: ["AuditLog.Read.All"] }), ["entra"]);
  });

  it("lists only declared services with no part granted", () => {
    const tenant = { grantedScopes: ["graph:User.Read.All", "graph:GroupMember.Read.All", "graph:Organization.Read.All"] };
    assert.deepEqual(
      missingServicesForAgent(tenant, ["intune", "entra", "defender"]).map((service) => service.id),
      ["defender"],
    );
    assert.deepEqual(missingServicesForAgent({}, ["defender"]), []);
    assert.deepEqual(missingServicesForAgent({ kind: "sample", grantedScopes: [] }, ["defender"]), []);
  });
});
