import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

import type { GraphHttpMethod, GraphOperation } from "@openagents/agent-sdk";

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
    .filter((agentDir) => {
      try {
        return statSync(join(agentDir, "manifest.yaml")).isFile();
      } catch {
        return false;
      }
    })
    .map((agentDir) => parseManifest(join(agentDir, "manifest.yaml")))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

interface ParsedSkill {
  format?: string;
  settings?: {
    method?: string;
    path?: string;
    select?: unknown;
    scopes?: unknown;
  };
  detail?: string;
}

interface ParsedManifest {
  descriptor?: {
    id?: string;
    name?: string;
    mode?: string;
  };
  skills?: ParsedSkill[];
}

function parseManifest(manifestPath: string): AgentManifest {
  const raw = parseYaml(readFileSync(manifestPath, "utf8")) as ParsedManifest;
  const descriptor = raw?.descriptor ?? {};
  const skills = Array.isArray(raw?.skills) ? raw.skills : [];

  const scopes = new Set<string>();
  const graphOperations: GraphOperation[] = [];
  for (const skill of skills) {
    const skillScopes = skill?.settings?.scopes;
    if (Array.isArray(skillScopes)) {
      for (const scope of skillScopes) {
        if (typeof scope === "string") scopes.add(scope);
      }
    }
    if (skill?.format === "graph" && skill.settings) {
      const method = skill.settings.method;
      const path = skill.settings.path;
      if (!isGraphMethod(method) || typeof path !== "string") continue;
      const op: GraphOperation = { method, path };
      const select = skill.settings.select;
      if (Array.isArray(select)) {
        const stringSelect = select.filter((item): item is string => typeof item === "string");
        if (stringSelect.length > 0) op.select = stringSelect;
      }
      if (typeof skill.detail === "string" && skill.detail.length > 0) {
        op.notes = skill.detail;
      }
      graphOperations.push(op);
    }
  }

  const id = typeof descriptor.id === "string" ? descriptor.id : "";
  return {
    id,
    slug: id,
    name: typeof descriptor.name === "string" ? descriptor.name : id,
    scopes: [...scopes],
    mode: descriptor.mode === "write" ? "write" : "read",
    graphOperations,
    manifestPath,
  };
}

function isGraphMethod(value: unknown): value is GraphHttpMethod {
  return (
    value === "GET" ||
    value === "POST" ||
    value === "PATCH" ||
    value === "PUT" ||
    value === "DELETE"
  );
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
