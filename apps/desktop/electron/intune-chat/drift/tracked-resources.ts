import type { GraphCacheResourceKind } from "@openadminos/agent-sdk";

const TRACKED_RESOURCES = [
  "deviceCompliancePolicies",
  "deviceConfigurations",
  "configurationPolicies",
  "conditionalAccessPolicies",
  "mobileApps",
  "managedAppPolicies",
  "iosManagedAppProtections",
  "androidManagedAppProtections",
  "mobileAppConfigurations",
  "deviceHealthScripts",
  "deviceManagementScripts",
  "windowsAutopilotProfiles",
  "deviceEnrollmentConfigurations",
  "windowsQualityUpdateProfiles",
  "windowsFeatureUpdateProfiles",
  "endpointSecurityIntents",
  "groupPolicyConfigurations",
  "assignmentFilters",
  "roleScopeTags",
  // Entra configuration surfaces (v0.5). Defender alert/incident/score
  // resources are event streams, not configuration, and stay untracked.
  "namedLocations",
  "authenticationMethodsPolicy",
  "authorizationPolicy",
  "crossTenantAccessPolicy",
  "directoryRoles",
  "administrativeUnits",
  "applications",
  "servicePrincipals",
  "domains",
] as const satisfies readonly GraphCacheResourceKind[];

export const DRIFT_TRACKED_RESOURCES: ReadonlySet<GraphCacheResourceKind> =
  new Set<GraphCacheResourceKind>(TRACKED_RESOURCES);

export interface DriftIgnoredFields {
  readonly base: readonly string[];
  readonly byResource: Readonly<Partial<Record<GraphCacheResourceKind, readonly string[]>>>;
}

export const DRIFT_IGNORED_FIELDS: DriftIgnoredFields = {
  base: ["@odata.etag", "@odata.context"],
  byResource: {},
};
