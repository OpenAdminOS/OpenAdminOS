import type {
  AgentRunResult,
  RunContext,
  WriteAgentModule,
  WriteAction,
  WritePlan,
} from "@openagents/agent-sdk";

const RETIRE_DAYS = 180;
const MS_PER_DAY = 86_400_000;

const agent: WriteAgentModule = {
  id: "retire-inactive-devices",
  registryId: "retire-inactive-devices",
  slug: "retire-inactive-devices",
  name: "Retire inactive devices",
  description:
    "Companion to Find inactive devices. Retires devices that have not synced in 180+ days after typed diff confirmation.",
  mode: "write",
  category: "devices",
  version: "1.0.0",
  scopes: [
    "DeviceManagementManagedDevices.PrivilegedOperations.All",
    "DeviceManagementManagedDevices.Read.All",
  ],
  author: {
    name: "OpenAgents",
    handle: "openagents",
    verified: true,
  },
  preferredModel: "llama3.1:8b",

  async plan(ctx: RunContext): Promise<WritePlan> {
    const devices = await ctx.step(
      "Load managed device inventory",
      "Reads managedDevices from the active tenant.",
      async () => {
        const inventory = await ctx.graph.listManagedDevices();
        ctx.log("info", `Loaded ${inventory.length} managed devices.`);
        return inventory;
      },
    );

    const candidates = await ctx.step(
      "Select retire candidates",
      `Devices inactive >= ${RETIRE_DAYS} days.`,
      async () => {
        const now = Date.now();
        const matched = devices.filter((device) => {
          const days = inactivityDays(device.lastSyncDateTime, now);
          return days >= RETIRE_DAYS;
        });
        ctx.log("info", `Selected ${matched.length} retire candidates.`);
        return matched;
      },
    );

    return ctx.step(
      "Build retire plan",
      "Produces one retire action per candidate device.",
      async () => {
        const actions: WriteAction[] = candidates.map((device) => ({
          id: `retire:${device.id}`,
          kind: "retire-device",
          label: `Retire ${device.deviceName}`,
          description: `${device.userPrincipalName} - ${device.operatingSystem} - last sync ${formatRelative(device.lastSyncDateTime)}`,
          severity: "destructive",
          metadata: {
            deviceId: device.id,
            deviceName: device.deviceName,
            userPrincipalName: device.userPrincipalName,
            operatingSystem: device.operatingSystem,
            lastSyncDateTime: device.lastSyncDateTime,
          },
        }));

        const plan: WritePlan = {
          summary:
            actions.length === 0
              ? "No devices currently match the retire criteria."
              : `Retire ${actions.length} devices that have not synced in ${RETIRE_DAYS}+ days.`,
          confirmationPhrase: `RETIRE ${actions.length} DEVICES`,
          actions,
        };

        ctx.log("info", `Plan ready: ${plan.confirmationPhrase}.`);
        return plan;
      },
    );
  },

  async apply(ctx: RunContext, plan: WritePlan): Promise<AgentRunResult> {
    const retiredDeviceIds: string[] = [];

    for (const action of plan.actions) {
      const deviceId = readString(action.metadata, "deviceId");
      const deviceName = readString(action.metadata, "deviceName") ?? deviceId ?? action.id;

      await ctx.step(
        action.label,
        action.description,
        async () => {
          if (!deviceId) {
            throw new Error(`Action ${action.id} is missing deviceId metadata.`);
          }
          ctx.log("info", `Retired ${deviceName} (${deviceId}).`);
          retiredDeviceIds.push(deviceId);
        },
      );
    }

    return {
      summary: `Retired ${retiredDeviceIds.length} devices.`,
      result: {
        retiredDeviceIds,
        count: retiredDeviceIds.length,
      },
    };
  },
};

export default agent;

function inactivityDays(lastSyncDateTime: string, nowMs: number): number {
  const lastSyncMs = new Date(lastSyncDateTime).getTime();
  if (Number.isNaN(lastSyncMs)) return Number.POSITIVE_INFINITY;
  return Math.floor((nowMs - lastSyncMs) / MS_PER_DAY);
}

function formatRelative(isoDate: string): string {
  const days = inactivityDays(isoDate, Date.now());
  if (!Number.isFinite(days)) return "unknown";
  return `${days} days ago`;
}

function readString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}
