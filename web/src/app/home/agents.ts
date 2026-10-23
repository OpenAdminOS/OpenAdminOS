// Display metadata for the public registry, mirrored from the repo-root
// agents/index.json. That file is not available inside the web/ Vercel
// build, so keep this list in step when agents are added or renamed.

export interface RegistryAgent {
  name: string;
  mode: "read" | "write";
  scopes: readonly string[];
}

export const REGISTRY_AGENTS: readonly RegistryAgent[] = [
  { name: "Compliance overview", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"] },
  { name: "Conditional Access explainer", mode: "read", scopes: ["Policy.Read.All"] },
  { name: "Dormant app registrations", mode: "read", scopes: ["Application.Read.All"] },
  { name: "Find inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"] },
  { name: "Intune Device Posture Auditor", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"] },
  {
    name: "Offboarding agent",
    mode: "write",
    scopes: [
      "DeviceManagementManagedDevices.Read.All",
      "Device.Read.All",
      "DeviceManagementManagedDevices.PrivilegedOperations.All",
    ],
  },
  { name: "OS update posture", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"] },
  { name: "Risky user triage", mode: "read", scopes: ["IdentityRiskyUser.Read.All"] },
  { name: "Secure Score prioritizer", mode: "read", scopes: ["SecurityEvents.Read.All"] },
  { name: "Sign-in failure explainer", mode: "read", scopes: ["AuditLog.Read.All"] },
  {
    name: "Stale guest cleanup",
    mode: "write",
    scopes: ["User.Read.All", "AuditLog.Read.All", "User.ReadWrite.All"],
  },
  { name: "Team evidence review", mode: "read", scopes: [] },
  { name: "Team PowerShell draft", mode: "read", scopes: [] },
  { name: "Tenant change audit", mode: "read", scopes: ["AuditLog.Read.All", "Directory.Read.All"] },
  { name: "Tenant health report", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"] },
  { name: "User license overview", mode: "read", scopes: ["User.Read.All"] },
];
