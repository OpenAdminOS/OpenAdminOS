/**
 * Generates agents/index.json from agents/*\/manifest.yaml.
 *
 * Usage: node scripts/generate-registry-index.mjs [--base-url <url>]
 *
 * The base URL is the raw-content prefix used to build per-agent
 * manifestUrls. Defaults to the canonical GitHub raw URL for this repo.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

const DEFAULT_BASE =
  "https://raw.githubusercontent.com/ugurkocde/OpenAgents/main";

const args = process.argv.slice(2);
const baseUrlIdx = args.indexOf("--base-url");
const baseUrl =
  baseUrlIdx >= 0 && args[baseUrlIdx + 1]
    ? args[baseUrlIdx + 1].replace(/\/$/, "")
    : DEFAULT_BASE;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const agentsRoot = join(repoRoot, "agents");
const outPath = join(agentsRoot, "index.json");

function parseManifest(manifestPath) {
  const raw = parseYaml(readFileSync(manifestPath, "utf8"));
  const descriptor = raw?.descriptor ?? {};
  const skills = Array.isArray(raw?.skills) ? raw.skills : [];

  const scopes = new Set();
  for (const skill of skills) {
    const s = skill?.settings?.scopes;
    if (Array.isArray(s)) s.forEach((scope) => typeof scope === "string" && scopes.add(scope));
    if (skill?.format === "write") {
      const ws = skill?.settings?.scopes;
      if (Array.isArray(ws)) ws.forEach((scope) => typeof scope === "string" && scopes.add(scope));
    }
  }

  return {
    id: descriptor.id ?? "",
    slug: descriptor.id ?? "",
    name: descriptor.name ?? "",
    description: descriptor.description ?? "",
    version: descriptor.version ?? "1.0.0",
    mode: descriptor.mode ?? "read",
    category: descriptor.category ?? "devices",
    tier: descriptor.tier ?? "agent",
    author: {
      name: descriptor.author?.name ?? "unknown",
      handle: descriptor.author?.handle,
      verified: descriptor.author?.verified ?? false,
    },
    scopes: [...scopes],
    minAppVersion: descriptor.minAppVersion ?? "0.1.0",
  };
}

const entries = readdirSync(agentsRoot)
  .map((entry) => join(agentsRoot, entry))
  .filter((p) => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  })
  .filter((agentDir) => {
    try { return statSync(join(agentDir, "manifest.yaml")).isFile(); } catch { return false; }
  })
  .map((agentDir) => {
    const slug = agentDir.split(/[\\/]/).pop();
    const manifest = parseManifest(join(agentDir, "manifest.yaml"));
    return {
      ...manifest,
      manifestUrl: `${baseUrl}/agents/${slug}/manifest.yaml`,
    };
  })
  .filter((e) => e.id.length > 0)
  .sort((a, b) => a.slug.localeCompare(b.slug));

const index = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  agents: entries,
};

writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n");
console.log(`Generated ${outPath} with ${entries.length} agent(s).`);
for (const e of entries) {
  console.log(`  ${e.tier === "dashboard" ? "dashboard" : "agent    "} ${e.mode === "write" ? "write" : "read "} ${e.slug}`);
}
