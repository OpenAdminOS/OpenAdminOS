import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentStatsSummary {
  agentCount: number;
  totalInstalls: number;
  topAgents: { slug: string; installs: number }[];
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
  try {
    return await readFile(
      join(process.cwd(), "public", "stats", "agents.json"),
      "utf8",
    );
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
