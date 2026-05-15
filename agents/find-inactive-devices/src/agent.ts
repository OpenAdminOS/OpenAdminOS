import type { AgentModule, AgentRunResult, RunContext } from "@openagents/agent-sdk";

const INACTIVITY_WARN_DAYS = 30;
const INACTIVITY_STALE_DAYS = 90;
const INACTIVITY_RETIRE_DAYS = 180;

const MS_PER_DAY = 86_400_000;

const agent: AgentModule = {
  id: "find-inactive-devices",
  registryId: "find-inactive-devices",
  slug: "find-inactive-devices",
  name: "Find inactive devices",
  description:
    "Surfaces Intune-managed devices that have not synced recently, grouped by inactivity bucket with a remediation summary.",
  mode: "read",
  category: "devices",
  version: "1.0.0",
  scopes: ["DeviceManagementManagedDevices.Read.All"],
  author: {
    name: "OpenAgents",
    handle: "openagents",
    verified: true,
  },
  preferredModel: "llama3.1:8b",

  async run(ctx: RunContext): Promise<AgentRunResult> {
    const devices = await ctx.step(
      "Load managed device inventory",
      "Reads managedDevices from the active tenant.",
      async () => {
        const inventory = await ctx.graph.listManagedDevices();
        ctx.log("info", `Loaded ${inventory.length} managed devices.`);
        return inventory;
      },
    );

    const buckets = await ctx.step(
      "Bucket devices by inactivity window",
      `Thresholds: ${INACTIVITY_WARN_DAYS}d, ${INACTIVITY_STALE_DAYS}d, ${INACTIVITY_RETIRE_DAYS}d.`,
      async () => {
        const now = Date.now();
        const warn: typeof devices = [];
        const stale: typeof devices = [];
        const retire: typeof devices = [];

        for (const device of devices) {
          const days = inactivityDays(device.lastSyncDateTime, now);
          if (days >= INACTIVITY_RETIRE_DAYS) {
            retire.push(device);
          } else if (days >= INACTIVITY_STALE_DAYS) {
            stale.push(device);
          } else if (days >= INACTIVITY_WARN_DAYS) {
            warn.push(device);
          }
        }

        ctx.log(
          "info",
          `Found ${warn.length} warn, ${stale.length} stale, ${retire.length} retire candidates.`,
        );
        return { warn, stale, retire };
      },
    );

    const deterministic = await ctx.step(
      "Summarize findings",
      "Builds the structured result payload.",
      async () => {
        const totalInactive = buckets.warn.length + buckets.stale.length + buckets.retire.length;
        const summary =
          totalInactive === 0
            ? "All managed devices have synced within the active windows."
            : `Found ${totalInactive} inactive devices (${buckets.retire.length} ready to retire, ${buckets.stale.length} stale, ${buckets.warn.length} warning).`;

        ctx.log("info", summary);

        return {
          summary,
          result: {
            totalDevices: devices.length,
            totalInactive,
            buckets: {
              warn: buckets.warn.map(deviceDigest),
              stale: buckets.stale.map(deviceDigest),
              retire: buckets.retire.map(deviceDigest),
            },
            recommendations: buildRecommendations(buckets),
            thresholds: {
              warnDays: INACTIVITY_WARN_DAYS,
              staleDays: INACTIVITY_STALE_DAYS,
              retireDays: INACTIVITY_RETIRE_DAYS,
            },
          } as Record<string, unknown>,
        };
      },
    );

    if (!ctx.llm.available) {
      ctx.log("info", "LLM provider not available, skipping summary polish.");
      return deterministic;
    }

    type LlmEnhanced = AgentRunResult & {
      result: Record<string, unknown>;
    };

    const enhanced: LlmEnhanced = await ctx.step(
      "Summarize findings with local LLM",
      "Generates an executive summary from the bucketed findings.",
      async () => {
        const prompt = buildSummaryPrompt(devices.length, buckets);
        const system =
          "You are a Microsoft 365 administrator's assistant. Be concise, factual, and skip filler. Return at most three sentences followed by two short prioritized recommendations.";
        const completion = await ctx.llm.complete({
          prompt,
          system,
          temperature: 0.2,
          maxTokens: 220,
        });
        ctx.log("info", `LLM summary ready (${completion.model}).`);
        return {
          summary: deterministic.summary,
          result: {
            ...(deterministic.result as Record<string, unknown>),
            llmSummary: completion.text.trim(),
            llmModel: completion.model,
          },
        };
      },
    );

    return enhanced;
  },
};

export default agent;

function inactivityDays(lastSyncDateTime: string, nowMs: number): number {
  const lastSyncMs = new Date(lastSyncDateTime).getTime();
  if (Number.isNaN(lastSyncMs)) return Number.POSITIVE_INFINITY;
  return Math.floor((nowMs - lastSyncMs) / MS_PER_DAY);
}

function deviceDigest(device: {
  id: string;
  deviceName: string;
  userPrincipalName: string;
  operatingSystem: string;
  lastSyncDateTime: string;
}) {
  return {
    id: device.id,
    deviceName: device.deviceName,
    userPrincipalName: device.userPrincipalName,
    operatingSystem: device.operatingSystem,
    lastSyncDateTime: device.lastSyncDateTime,
  };
}

function buildSummaryPrompt(
  totalDevices: number,
  buckets: {
    warn: { deviceName: string }[];
    stale: { deviceName: string }[];
    retire: { deviceName: string }[];
  },
): string {
  const sample = (devices: { deviceName: string }[], limit = 3) =>
    devices.slice(0, limit).map((device) => device.deviceName).join(", ") || "none";
  return [
    `Total managed devices: ${totalDevices}.`,
    `Warn band (>= ${INACTIVITY_WARN_DAYS} days): ${buckets.warn.length} devices. Examples: ${sample(buckets.warn)}.`,
    `Stale band (>= ${INACTIVITY_STALE_DAYS} days): ${buckets.stale.length} devices. Examples: ${sample(buckets.stale)}.`,
    `Retire band (>= ${INACTIVITY_RETIRE_DAYS} days): ${buckets.retire.length} devices. Examples: ${sample(buckets.retire)}.`,
    "",
    "Write an executive summary an Intune admin can paste into a ticket. Lead with the most important bucket, then two short prioritized recommendations.",
  ].join("\n");
}

function buildRecommendations(buckets: {
  warn: unknown[];
  stale: unknown[];
  retire: unknown[];
}): string[] {
  const recs: string[] = [];
  if (buckets.retire.length > 0) {
    recs.push(
      `Review the ${buckets.retire.length} devices inactive >= ${INACTIVITY_RETIRE_DAYS} days for retirement.`,
    );
  }
  if (buckets.stale.length > 0) {
    recs.push(
      `Contact owners of the ${buckets.stale.length} stale devices (>= ${INACTIVITY_STALE_DAYS} days) before action.`,
    );
  }
  if (buckets.warn.length > 0) {
    recs.push(
      `Schedule a check-in for the ${buckets.warn.length} warning-band devices (>= ${INACTIVITY_WARN_DAYS} days).`,
    );
  }
  if (recs.length === 0) {
    recs.push("No remediation needed — all devices are within the active window.");
  }
  return recs;
}
