import type { ManagedDeviceRecord, RunGraphApi } from "@openagents/agent-sdk";

const MS_PER_DAY = 86_400_000;

interface SyntheticDeviceSpec {
  id: string;
  deviceName: string;
  userPrincipalName: string;
  operatingSystem: string;
  osVersion: string;
  lastSyncDaysAgo: number;
  enrolledDaysAgo: number;
  complianceState: ManagedDeviceRecord["complianceState"];
}

const SYNTHETIC_DEVICES: SyntheticDeviceSpec[] = [
  // Active (< 30 days)
  { id: "d-001", deviceName: "LAPTOP-AB12CD", userPrincipalName: "anna@contoso.com", operatingSystem: "Windows", osVersion: "11.23H2", lastSyncDaysAgo: 0, enrolledDaysAgo: 412, complianceState: "compliant" },
  { id: "d-002", deviceName: "LAPTOP-CD34EF", userPrincipalName: "ben@contoso.com", operatingSystem: "Windows", osVersion: "11.23H2", lastSyncDaysAgo: 1, enrolledDaysAgo: 290, complianceState: "compliant" },
  { id: "d-003", deviceName: "MAC-MBP-001", userPrincipalName: "chris@contoso.com", operatingSystem: "macOS", osVersion: "14.4", lastSyncDaysAgo: 2, enrolledDaysAgo: 180, complianceState: "compliant" },
  { id: "d-004", deviceName: "LAPTOP-EF56GH", userPrincipalName: "dana@contoso.com", operatingSystem: "Windows", osVersion: "11.23H2", lastSyncDaysAgo: 5, enrolledDaysAgo: 540, complianceState: "compliant" },
  { id: "d-005", deviceName: "IPAD-001", userPrincipalName: "elena@contoso.com", operatingSystem: "iOS", osVersion: "17.4", lastSyncDaysAgo: 6, enrolledDaysAgo: 200, complianceState: "compliant" },
  { id: "d-006", deviceName: "LAPTOP-GH78IJ", userPrincipalName: "frank@contoso.com", operatingSystem: "Windows", osVersion: "10.22H2", lastSyncDaysAgo: 12, enrolledDaysAgo: 720, complianceState: "noncompliant" },
  { id: "d-007", deviceName: "MAC-MBP-002", userPrincipalName: "gina@contoso.com", operatingSystem: "macOS", osVersion: "14.4", lastSyncDaysAgo: 14, enrolledDaysAgo: 130, complianceState: "compliant" },
  { id: "d-008", deviceName: "LAPTOP-IJ90KL", userPrincipalName: "henry@contoso.com", operatingSystem: "Windows", osVersion: "11.23H2", lastSyncDaysAgo: 19, enrolledDaysAgo: 400, complianceState: "compliant" },
  { id: "d-009", deviceName: "LAPTOP-KL12MN", userPrincipalName: "irina@contoso.com", operatingSystem: "Windows", osVersion: "11.23H2", lastSyncDaysAgo: 24, enrolledDaysAgo: 365, complianceState: "compliant" },
  { id: "d-010", deviceName: "PIXEL-001", userPrincipalName: "jonas@contoso.com", operatingSystem: "Android", osVersion: "14", lastSyncDaysAgo: 28, enrolledDaysAgo: 95, complianceState: "compliant" },

  // Warn band (30-89 days)
  { id: "d-011", deviceName: "LAPTOP-MN34OP", userPrincipalName: "kira@contoso.com", operatingSystem: "Windows", osVersion: "11.23H2", lastSyncDaysAgo: 35, enrolledDaysAgo: 480, complianceState: "compliant" },
  { id: "d-012", deviceName: "LAPTOP-OP56QR", userPrincipalName: "lukas@contoso.com", operatingSystem: "Windows", osVersion: "10.22H2", lastSyncDaysAgo: 47, enrolledDaysAgo: 660, complianceState: "noncompliant" },
  { id: "d-013", deviceName: "MAC-MBP-003", userPrincipalName: "maya@contoso.com", operatingSystem: "macOS", osVersion: "13.6", lastSyncDaysAgo: 61, enrolledDaysAgo: 820, complianceState: "compliant" },
  { id: "d-014", deviceName: "IPHONE-001", userPrincipalName: "nadia@contoso.com", operatingSystem: "iOS", osVersion: "17.2", lastSyncDaysAgo: 78, enrolledDaysAgo: 240, complianceState: "compliant" },

  // Stale band (90-179 days)
  { id: "d-015", deviceName: "LAPTOP-QR78ST", userPrincipalName: "omar@contoso.com", operatingSystem: "Windows", osVersion: "10.22H2", lastSyncDaysAgo: 96, enrolledDaysAgo: 910, complianceState: "noncompliant" },
  { id: "d-016", deviceName: "LAPTOP-ST90UV", userPrincipalName: "petra@contoso.com", operatingSystem: "Windows", osVersion: "11.22H2", lastSyncDaysAgo: 121, enrolledDaysAgo: 1020, complianceState: "noncompliant" },
  { id: "d-017", deviceName: "MAC-MBP-004", userPrincipalName: "quentin@contoso.com", operatingSystem: "macOS", osVersion: "12.7", lastSyncDaysAgo: 145, enrolledDaysAgo: 1180, complianceState: "unknown" },
  { id: "d-018", deviceName: "LAPTOP-UV12WX", userPrincipalName: "rosa@contoso.com", operatingSystem: "Windows", osVersion: "10.22H2", lastSyncDaysAgo: 168, enrolledDaysAgo: 1300, complianceState: "noncompliant" },

  // Retire band (>= 180 days)
  { id: "d-019", deviceName: "LAPTOP-WX34YZ", userPrincipalName: "sven@contoso.com", operatingSystem: "Windows", osVersion: "10.21H2", lastSyncDaysAgo: 193, enrolledDaysAgo: 1420, complianceState: "noncompliant" },
  { id: "d-020", deviceName: "LAPTOP-YZ56AB", userPrincipalName: "tara@contoso.com", operatingSystem: "Windows", osVersion: "10.21H2", lastSyncDaysAgo: 240, enrolledDaysAgo: 1510, complianceState: "noncompliant" },
  { id: "d-021", deviceName: "MAC-MBP-005", userPrincipalName: "uri@contoso.com", operatingSystem: "macOS", osVersion: "12.6", lastSyncDaysAgo: 305, enrolledDaysAgo: 1610, complianceState: "unknown" },
  { id: "d-022", deviceName: "IPHONE-002", userPrincipalName: "vera@contoso.com", operatingSystem: "iOS", osVersion: "16.5", lastSyncDaysAgo: 360, enrolledDaysAgo: 720, complianceState: "unknown" },
];

function buildInventory(nowMs: number): ManagedDeviceRecord[] {
  return SYNTHETIC_DEVICES.map((spec) => ({
    id: spec.id,
    deviceName: spec.deviceName,
    userPrincipalName: spec.userPrincipalName,
    operatingSystem: spec.operatingSystem,
    osVersion: spec.osVersion,
    complianceState: spec.complianceState,
    lastSyncDateTime: new Date(nowMs - spec.lastSyncDaysAgo * MS_PER_DAY).toISOString(),
    enrolledDateTime: new Date(nowMs - spec.enrolledDaysAgo * MS_PER_DAY).toISOString(),
  }));
}

export function createSyntheticGraph(): RunGraphApi {
  return {
    async listManagedDevices(): Promise<ManagedDeviceRecord[]> {
      return buildInventory(Date.now());
    },
  };
}

export function getSyntheticInventorySize(): number {
  return SYNTHETIC_DEVICES.length;
}
