import type { Agent, Author } from "../types";

const ugur: Author = { name: "Ugur Koc", handle: "ugurkoc", verified: true };

export const installedAgents: Agent[] = [
  {
    id: "ag-001",
    slug: "find-inactive-devices",
    name: "Find inactive devices",
    description:
      "Surfaces Intune-managed devices that haven't synced in 90+ days, with a remediation summary.",
    mode: "read",
    category: "devices",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
    author: ugur,
    version: "1.2.0",
    installed: true,
    lastRunAt: "2026-05-08T14:22:00Z",
    preferredModel: "llama3.1:8b",
  },
  {
    id: "ag-002",
    slug: "compliance-overview",
    name: "Compliance overview",
    description:
      "Summarises device compliance posture across configuration profiles and policies, grouped by OS and platform.",
    mode: "read",
    category: "compliance",
    scopes: [
      "DeviceManagementConfiguration.Read.All",
      "DeviceManagementManagedDevices.Read.All",
    ],
    author: ugur,
    version: "2.0.0",
    installed: true,
    lastRunAt: "2026-05-09T09:11:00Z",
    preferredModel: "llama3.1:8b",
  },
  {
    id: "ag-003",
    slug: "encryption-status-audit",
    name: "Encryption status audit",
    description:
      "Reports BitLocker and FileVault encryption status across managed devices. Flags devices where encryption silently failed.",
    mode: "read",
    category: "devices",
    scopes: [
      "DeviceManagementManagedDevices.Read.All",
      "DeviceManagementConfiguration.Read.All",
    ],
    author: ugur,
    version: "0.9.1",
    installed: true,
    lastRunAt: "2026-05-07T18:40:00Z",
    preferredModel: "llama3.1:8b",
  },
  {
    id: "ag-004",
    slug: "retire-inactive-devices",
    name: "Retire inactive devices",
    description:
      "Companion to Find inactive devices. Retires the surfaced devices after diff confirmation.",
    mode: "write",
    category: "devices",
    scopes: ["DeviceManagementManagedDevices.PrivilegedOperations.All"],
    author: ugur,
    version: "0.6.0",
    installed: true,
    lastRunAt: undefined,
    preferredModel: "llama3.1:8b",
  },
];

export const hubAgents: Agent[] = [
  {
    id: "hub-001",
    slug: "app-deployment-health",
    name: "App deployment health",
    description:
      "Audits required Win32 and Microsoft Store app deployments. Surfaces devices where install state silently regressed to failed.",
    mode: "read",
    category: "apps",
    scopes: [
      "DeviceManagementApps.Read.All",
      "DeviceManagementManagedDevices.Read.All",
    ],
    author: ugur,
    version: "1.4.2",
    installed: false,
    installs: 1240,
    rating: 4.8,
  },
  {
    id: "hub-002",
    slug: "configuration-drift-detector",
    name: "Configuration drift detector",
    description:
      "Detects devices where assigned configuration profiles never reached 'success'. Groups by policy, OS, and root cause.",
    mode: "read",
    category: "policies",
    scopes: [
      "DeviceManagementConfiguration.Read.All",
      "DeviceManagementManagedDevices.Read.All",
    ],
    author: ugur,
    version: "2.1.0",
    installed: false,
    installs: 3104,
    rating: 4.9,
  },
  {
    id: "hub-003",
    slug: "update-ring-health",
    name: "Update ring health",
    description:
      "Surfaces Windows devices stuck behind their assigned update ring. Highlights deployment lag and reboots pending 14+ days.",
    mode: "read",
    category: "updates",
    scopes: [
      "DeviceManagementConfiguration.Read.All",
      "DeviceManagementManagedDevices.Read.All",
    ],
    author: ugur,
    version: "1.0.3",
    installed: false,
    installs: 892,
    rating: 4.7,
  },
  {
    id: "hub-004",
    slug: "ios-apn-cert-expiry",
    name: "iOS APN & DEP cert expiry",
    description:
      "Checks Apple Push and DEP token expiry across the iOS/iPadOS estate. Warns 60 days out so renewals never lapse silently.",
    mode: "read",
    category: "devices",
    scopes: ["DeviceManagementServiceConfig.Read.All"],
    author: ugur,
    version: "0.8.0",
    installed: false,
    installs: 412,
    rating: 4.6,
  },
  {
    id: "hub-005",
    slug: "win32-app-failure-scanner",
    name: "Win32 app failure scanner",
    description:
      "Scans Win32 LOB app deployments for repeat install failures. Returns ranked failure modes with affected device counts.",
    mode: "read",
    category: "apps",
    scopes: [
      "DeviceManagementApps.Read.All",
      "DeviceManagementManagedDevices.Read.All",
    ],
    author: ugur,
    version: "1.1.7",
    installed: false,
    installs: 2876,
    rating: 4.9,
  },
  {
    id: "hub-006",
    slug: "lost-device-locator",
    name: "Lost device locator",
    description:
      "Locates devices that haven't checked in for 30+ days. Optionally triggers a remote wipe — paused for typed confirmation.",
    mode: "write",
    category: "devices",
    scopes: [
      "DeviceManagementManagedDevices.Read.All",
      "DeviceManagementManagedDevices.PrivilegedOperations.All",
    ],
    author: ugur,
    version: "0.5.2",
    installed: false,
    installs: 218,
    rating: 4.4,
  },
];
