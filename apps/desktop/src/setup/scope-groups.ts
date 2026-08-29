import type { RequestedScope } from "../shared/openAdminOS";

export interface ScopeGroup {
  id: "devices" | "apps" | "directory" | "identity" | "security" | "other";
  title: string;
  summary: string;
  scopes: RequestedScope[];
}

const GROUPS: readonly Omit<ScopeGroup, "scopes">[] = [
  {
    id: "devices",
    title: "Devices and configuration",
    summary: "Intune devices, policies, scripts, Autopilot, and scope tags.",
  },
  {
    id: "apps",
    title: "Apps",
    summary: "Intune app deployments and Entra app registrations.",
  },
  {
    id: "directory",
    title: "Users, groups, and directory",
    summary: "Users, groups, directory names, and license tiers.",
  },
  {
    id: "identity",
    title: "Identity and access",
    summary: "Entra directory roles, administrative units, and verified domains.",
  },
  {
    id: "security",
    title: "Security and sign-ins",
    summary:
      "Conditional Access, sign-in logs, risk signals, Defender alerts and incidents, and Secure Score.",
  },
];

export const SCOPE_GROUP_BY_NAME: Readonly<Record<string, ScopeGroup["id"]>> = {
  "DeviceManagementManagedDevices.Read.All": "devices",
  "DeviceManagementConfiguration.Read.All": "devices",
  "DeviceManagementServiceConfig.Read.All": "devices",
  "DeviceManagementScripts.Read.All": "devices",
  "DeviceManagementRBAC.Read.All": "devices",
  "Device.Read.All": "devices",
  "DeviceManagementApps.Read.All": "apps",
  "Application.Read.All": "apps",
  "User.Read.All": "directory",
  "GroupMember.Read.All": "directory",
  "Directory.Read.All": "directory",
  "Organization.Read.All": "directory",
  "RoleManagement.Read.Directory": "identity",
  "AdministrativeUnit.Read.All": "identity",
  "Domain.Read.All": "identity",
  "Policy.Read.All": "security",
  "AuditLog.Read.All": "security",
  "IdentityRiskyUser.Read.All": "security",
  "SecurityEvents.Read.All": "security",
  "SecurityAlert.Read.All": "security",
  "SecurityIncident.Read.All": "security",
};

export function groupRequestedScopes(scopes: RequestedScope[]): ScopeGroup[] {
  const grouped = new Map<ScopeGroup["id"], RequestedScope[]>();
  for (const scope of scopes) {
    const id = SCOPE_GROUP_BY_NAME[scope.name] ?? "other";
    grouped.set(id, [...(grouped.get(id) ?? []), scope]);
  }

  const result = GROUPS.map((group) => ({
    ...group,
    scopes: grouped.get(group.id) ?? [],
  })).filter((group) => group.scopes.length > 0);
  const other = grouped.get("other");
  if (other?.length) {
    result.push({
      id: "other",
      title: "Other requested access",
      summary: "Additional read scopes declared by this OpenAdminOS version.",
      scopes: other,
    });
  }
  return result;
}
