import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GraphOperation } from "@openagents/agent-sdk";

export interface AgentManifest {
  id: string;
  slug: string;
  name: string;
  scopes: string[];
  mode: "read" | "write";
  graphOperations: GraphOperation[];
  manifestPath: string;
}

export function loadAgentManifests(): AgentManifest[] {
  const agentsRoot = findAgentsRoot();
  return readdirSync(agentsRoot)
    .map((entry) => join(agentsRoot, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .map((agentDir) => parseManifest(join(agentDir, "manifest.json")))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

function parseManifest(manifestPath: string): AgentManifest {
  const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const operations = Array.isArray(raw.graphOperations)
    ? (raw.graphOperations as GraphOperation[])
    : [];

  return {
    id: String(raw.id),
    slug: String(raw.slug),
    name: String(raw.name),
    scopes: Array.isArray(raw.scopes) ? (raw.scopes as string[]) : [],
    mode: raw.mode === "write" ? "write" : "read",
    graphOperations: operations,
    manifestPath,
  };
}

function findAgentsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), here];
  for (const start of candidates) {
    let current = resolve(start);
    while (true) {
      const candidate = join(current, "agents");
      try {
        if (statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // not a directory; keep walking
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("Unable to locate the root agents folder.");
}
