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

// Synthetic-mode device inventory. Intentionally empty: agents still run
// end-to-end against this graph (so the pipeline is exercised), they just
// operate on zero records. Connect a real tenant to see real data.
const SYNTHETIC_DEVICES: SyntheticDeviceSpec[] = [];

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
    async retireManagedDevice(_deviceId: string): Promise<void> {
      // Synthetic graph is read-only by design — the device list is
      // regenerated each call from a fixed spec. The runtime gates real
      // writes via RunContext.realWrites, and agents branch on that
      // flag before calling this method, so a synthetic call here is
      // unexpected. Return successfully but make this a no-op rather
      // than throwing — it makes accidental calls during tests harmless.
      return;
    },
  };
}

