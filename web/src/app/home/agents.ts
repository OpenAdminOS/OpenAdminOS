// Registry display data, read from the repo-root agents/index.json. The file
// sits outside the web/ Vercel build, so scripts/sync-stats.mjs copies (or, on
// Vercel, fetches) it into src/generated/ before dev, build, and typecheck.
import registryIndex from "~/generated/registry-index.json";

export interface RegistryAgent {
  name: string;
  mode: "read" | "write";
  scopes: readonly string[];
}

export const REGISTRY_AGENTS: readonly RegistryAgent[] = registryIndex.agents.map(
  (agent) => ({
    name: agent.name,
    mode: agent.mode === "write" ? "write" : "read",
    scopes: agent.scopes,
  }),
);
