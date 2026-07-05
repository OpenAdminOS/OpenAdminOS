import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentStatsSummary {
  agentCount: number;
  totalInstalls: number;
  topAgents: { slug: string; installs: number }[];
}

export interface AgentDisplay {
  name: string;
  description: string;
  mode: "read" | "write";
  scopes: string[];
}

export const AGENT_DISPLAY: Record<string, AgentDisplay> = {
  "conditional-access-explainer": {
    name: "Conditional Access explainer",
    mode: "read",
    scopes: ["Policy.Read.All"],
    description:
      "Reviews Conditional Access policies for coverage, exclusions, report-only controls, overlaps, and common Zero Trust gaps.",
  },
  "compliance-overview": {
    name: "Compliance overview",
    mode: "read",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
    description:
      "Reviews Intune compliance by state, operating system, ownership, enrollment, and stale inventory signals.",
  },
  "tenant-health-report": {
    name: "Tenant health report",
    mode: "read",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
    description:
      "Summarizes Intune tenant health from compliance, OS, ownership, and stale inventory signals for scheduled or manual review.",
  },
  "find-inactive-devices": {
    name: "Find inactive devices",
    mode: "read",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
    description:
      "Reviews Intune-managed device inactivity by sync age, compliance, OS, ownership, and enrollment signals with review-first cleanup guidance.",
  },
  "user-license-overview": {
    name: "User license overview",
    mode: "read",
    scopes: ["User.Read.All"],
    description:
      "Reviews tenant user licensing hygiene by usage location, account state, and assigned-license presence.",
  },
  "dormant-app-registrations": {
    name: "Dormant app registrations",
    mode: "read",
    scopes: ["Application.Read.All"],
    description:
      "Reviews app registrations for stale experiments, risky exposure, credentials, and cleanup candidates with evidence-backed recommendations.",
  },
};

export function getTopDisplayAgents(
  summary: AgentStatsSummary,
  limit = 5,
): Array<
  {
    slug: string;
    installs: number;
  } & AgentDisplay
> {
  return summary.topAgents
    .flatMap((agent) => {
      const display = AGENT_DISPLAY[agent.slug];
      if (!display) return [];

      return [{ slug: agent.slug, installs: agent.installs, ...display }];
    })
    .slice(0, limit);
}

export async function getAgentStatsSummary(): Promise<AgentStatsSummary | null> {
  try {
    const content = await readAgentStatsFile();
    if (!content) return null;

    const parsed = JSON.parse(content) as unknown;

    if (!isRecord(parsed) || !isRecord(parsed.agents)) return null;

    const topAgents = Object.entries(parsed.agents).map(([slug, value]) => {
      if (!isRecord(value)) return null;

      const installs = value.installs;
      if (typeof installs !== "number" || !Number.isFinite(installs)) {
        return null;
      }

      return { slug, installs };
    });

    if (topAgents.some((agent) => agent === null)) return null;

    const agents = topAgents as { slug: string; installs: number }[];
    agents.sort((a, b) => b.installs - a.installs);

    return {
      agentCount: agents.length,
      totalInstalls: agents.reduce((total, agent) => total + agent.installs, 0),
      topAgents: agents,
    };
  } catch {
    return null;
  }
}

async function readAgentStatsFile(): Promise<string | null> {
  const candidates = [
    join(process.cwd(), "public", "stats", "agents.json"),
    join(process.cwd(), "web", "public", "stats", "agents.json"),
  ];

  for (const filePath of candidates) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      continue;
    }
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
