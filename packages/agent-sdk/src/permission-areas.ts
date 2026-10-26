export const DEFAULT_GRAPH_READ_SCOPE_NAMES = [
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
] as const;

export type DefaultGraphReadScopeName =
  (typeof DEFAULT_GRAPH_READ_SCOPE_NAMES)[number];

export type PermissionAreaId =
  | "devices"
  | "apps"
  | "directory"
  | "identity"
  | "security";

export interface PermissionAreaDefinition {
  id: PermissionAreaId;
  title: string;
  summary: string;
  required: boolean;
  scopes: readonly DefaultGraphReadScopeName[];
}

export const REQUIRED_PERMISSION_AREA_MESSAGE =
  "Required: tenant identity, users, and groups are used by every area.";

export const PERMISSION_AREAS: readonly PermissionAreaDefinition[] = [
  {
    id: "devices",
    title: "Devices and configuration",
    summary: "Intune devices, policies, scripts, Autopilot, and scope tags.",
    required: false,
    scopes: [
      "DeviceManagementManagedDevices.Read.All",
      "DeviceManagementConfiguration.Read.All",
      "DeviceManagementServiceConfig.Read.All",
      "DeviceManagementScripts.Read.All",
      "DeviceManagementRBAC.Read.All",
      "Device.Read.All",
    ],
  },
  {
    id: "apps",
    title: "Apps",
    summary: "Intune app deployments and Entra app registrations.",
    required: false,
    scopes: [
      "DeviceManagementApps.Read.All",
      "Application.Read.All",
    ],
  },
  {
    id: "directory",
    title: "Users, groups, and directory",
    summary: REQUIRED_PERMISSION_AREA_MESSAGE,
    required: true,
    scopes: [
      "User.Read.All",
      "GroupMember.Read.All",
      "Directory.Read.All",
      "Organization.Read.All",
    ],
  },
  {
    id: "identity",
    title: "Identity and access",
    summary: "Entra directory roles, administrative units, and verified domains.",
    required: false,
    scopes: [
      "RoleManagement.Read.Directory",
      "AdministrativeUnit.Read.All",
      "Domain.Read.All",
    ],
  },
  {
    id: "security",
    title: "Security and sign-ins",
    summary:
      "Conditional Access, sign-in logs, risk signals, Defender alerts and incidents, and Secure Score.",
    required: false,
    scopes: [
      "Policy.Read.All",
      "AuditLog.Read.All",
      "IdentityRiskyUser.Read.All",
      "SecurityEvents.Read.All",
      "SecurityAlert.Read.All",
      "SecurityIncident.Read.All",
    ],
  },
] as const;

const AREA_BY_ID = new Map(PERMISSION_AREAS.map((area) => [area.id, area]));
const AREA_BY_SCOPE = new Map(
  PERMISSION_AREAS.flatMap((area) => area.scopes.map((scope) => [scope, area] as const)),
);

const ADDITIONAL_SCOPE_AREAS: Readonly<Record<string, PermissionAreaId>> = {
  "DeviceManagementManagedDevices.ReadWrite.All": "devices",
  "DeviceManagementManagedDevices.PrivilegedOperations.All": "devices",
  "DeviceManagementConfiguration.ReadWrite.All": "devices",
  "DeviceManagementServiceConfig.ReadWrite.All": "devices",
  "DeviceManagementScripts.ReadWrite.All": "devices",
  "DeviceManagementRBAC.ReadWrite.All": "devices",
  "DeviceManagementApps.ReadWrite.All": "apps",
  "Application.ReadWrite.All": "apps",
  "User.ReadWrite.All": "directory",
  "Group.ReadWrite.All": "directory",
  "Directory.ReadWrite.All": "directory",
  "RoleManagement.ReadWrite.Directory": "identity",
  "AdministrativeUnit.ReadWrite.All": "identity",
  "Domain.ReadWrite.All": "identity",
  "Policy.ReadWrite.ConditionalAccess": "security",
  "SecurityEvents.ReadWrite.All": "security",
};

export function normalizePermissionAreaIds(
  ids?: readonly PermissionAreaId[],
): PermissionAreaId[] {
  const selected = new Set<PermissionAreaId>(
    ids === undefined ? PERMISSION_AREAS.map((area) => area.id) : ids,
  );
  for (const area of PERMISSION_AREAS) {
    if (area.required) selected.add(area.id);
  }
  return PERMISSION_AREAS.filter((area) => selected.has(area.id)).map(
    (area) => area.id,
  );
}

export function scopesForPermissionAreas(
  ids?: readonly PermissionAreaId[],
): string[] {
  const selected = new Set(normalizePermissionAreaIds(ids));
  return PERMISSION_AREAS.filter((area) => selected.has(area.id)).flatMap(
    (area) => [...area.scopes],
  );
}

export function permissionAreaById(
  id: PermissionAreaId,
): PermissionAreaDefinition {
  const area = AREA_BY_ID.get(id);
  if (!area) throw new Error(`Unknown permission area: ${id}`);
  return area;
}

export function permissionAreaForScope(
  scope: string,
): PermissionAreaDefinition | undefined {
  const normalized = normalizeGraphScopeName(scope);
  const direct = AREA_BY_SCOPE.get(normalized as DefaultGraphReadScopeName);
  if (direct) return direct;
  const additionalArea = ADDITIONAL_SCOPE_AREAS[normalized];
  return additionalArea ? AREA_BY_ID.get(additionalArea) : undefined;
}

export function grantedScopeSet(input: {
  kind?: "sample";
  grantedScopes?: readonly string[];
}): Set<string> {
  if (input.kind === "sample" || input.grantedScopes === undefined) {
    return new Set(DEFAULT_GRAPH_READ_SCOPE_NAMES);
  }
  return new Set(input.grantedScopes.map(normalizeGraphScopeName));
}

export function grantedPermissionAreas(input: {
  kind?: "sample";
  grantedScopes?: readonly string[];
}): PermissionAreaDefinition[] {
  const granted = grantedScopeSet(input);
  return PERMISSION_AREAS.filter((area) =>
    area.scopes.every((scope) => granted.has(scope)),
  );
}

export function missingPermissionAreasForScopes(
  scopes: readonly string[],
  grantedScopes: ReadonlySet<string>,
): PermissionAreaDefinition[] {
  const missing = new Set<PermissionAreaId>();
  for (const scope of scopes) {
    const normalized = normalizeGraphScopeName(scope);
    if (grantedScopes.has(normalized)) continue;
    const area = permissionAreaForScope(normalized);
    if (area) missing.add(area.id);
  }
  return PERMISSION_AREAS.filter((area) => missing.has(area.id));
}

export function intersectGrantedScopes(
  resultScopes: readonly string[] | null | undefined,
  requestedScopes: readonly string[],
): string[] {
  const requested = new Map(
    requestedScopes.map((scope) => [normalizeGraphScopeName(scope).toLowerCase(), normalizeGraphScopeName(scope)]),
  );
  if (!resultScopes || resultScopes.length === 0) return [...requested.values()];
  const granted = new Set(
    resultScopes.map((scope) => normalizeGraphScopeName(scope).toLowerCase()),
  );
  return [...requested.entries()]
    .filter(([key]) => granted.has(key))
    .map(([, scope]) => scope);
}

export function mergeGrantedScopes(
  current: { kind?: "sample"; grantedScopes?: readonly string[] },
  additions: readonly string[],
): string[] {
  const merged = grantedScopeSet(current);
  for (const scope of additions) merged.add(normalizeGraphScopeName(scope));
  const defaults = DEFAULT_GRAPH_READ_SCOPE_NAMES.filter((scope) => merged.delete(scope));
  return [...defaults, ...[...merged].sort((left, right) => left.localeCompare(right))];
}

export function normalizeGraphScopeName(scope: string): string {
  const trimmed = scope.trim();
  const prefix = "https://graph.microsoft.com/";
  return trimmed.toLowerCase().startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : trimmed;
}
