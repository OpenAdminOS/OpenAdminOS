import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

import type { CheckResult } from "./checks.js";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function runRegistryIndexChecks(): CheckResult[] {
  const agentsRoot = findAgentsRoot();
  const indexPath = join(agentsRoot, "index.json");
  const results: CheckResult[] = [];

  if (!existsSync(indexPath)) {
    return [
      {
        name: "registry-index-present",
        severity: "fail",
        message: "agents/index.json is missing. Run `npm run registry:index`.",
      },
    ];
  }

  const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
    schemaVersion?: unknown;
    agents?: unknown;
  };
  const entries = Array.isArray(index.agents)
    ? (index.agents as Record<string, unknown>[])
    : [];
  results.push({
    name: "registry-index-present",
    severity: "pass",
    message: `agents/index.json contains ${entries.length} entries.`,
  });

  const manifestDirs = readdirSync(agentsRoot)
    .map((entry) => join(agentsRoot, entry))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .filter((agentDir) => existsSync(join(agentDir, "manifest.yaml")));

  const duplicateSlugs = findDuplicates(entries.map((entry) => String(entry.slug ?? "")));
  results.push({
    name: "unique-slugs",
    severity: duplicateSlugs.length > 0 ? "fail" : "pass",
    message:
      duplicateSlugs.length > 0
        ? `Duplicate registry slugs: ${duplicateSlugs.join(", ")}.`
        : "Registry slugs are unique.",
    ...(duplicateSlugs.length > 0 ? { details: duplicateSlugs } : {}),
  });

  const entrySlugs = new Set(entries.map((entry) => String(entry.slug ?? "")));
  const missingFromIndex: string[] = [];
  const missingReadme: string[] = [];
  const invalidVersions: string[] = [];

  for (const agentDir of manifestDirs) {
    const manifestPath = join(agentDir, "manifest.yaml");
    const raw = parseYaml(readFileSync(manifestPath, "utf8")) as {
      descriptor?: Record<string, unknown>;
    };
    const slug = String(raw?.descriptor?.id ?? "");
    if (!entrySlugs.has(slug)) missingFromIndex.push(slug || manifestPath);
    if (!existsSync(join(agentDir, "README.md"))) missingReadme.push(slug || manifestPath);

    const version = String(raw?.descriptor?.version ?? "");
    const minAppVersion = String(raw?.descriptor?.minAppVersion ?? "");
    if (!SEMVER_RE.test(version)) invalidVersions.push(`${slug}: version ${version}`);
    if (!SEMVER_RE.test(minAppVersion)) {
      invalidVersions.push(`${slug}: minAppVersion ${minAppVersion || "missing"}`);
    }
  }

  results.push({
    name: "index-covers-manifests",
    severity: missingFromIndex.length > 0 ? "fail" : "pass",
    message:
      missingFromIndex.length > 0
        ? "Some manifests are missing from agents/index.json."
        : "agents/index.json covers every manifest.",
    ...(missingFromIndex.length > 0 ? { details: missingFromIndex } : {}),
  });

  results.push({
    name: "readmes-present",
    severity: missingReadme.length > 0 ? "fail" : "pass",
    message:
      missingReadme.length > 0
        ? "Every registry agent needs README.md."
        : "Every registry agent has README.md.",
    ...(missingReadme.length > 0 ? { details: missingReadme } : {}),
  });

  results.push({
    name: "semver-valid",
    severity: invalidVersions.length > 0 ? "fail" : "pass",
    message:
      invalidVersions.length > 0
        ? "Registry versions must use semver."
        : "Registry versions use semver.",
    ...(invalidVersions.length > 0 ? { details: invalidVersions } : {}),
  });

  return results;
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function findAgentsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.cwd(), here];
  for (const start of candidates) {
    let current = resolve(start);
    while (true) {
      const candidate = join(current, "agents");
      try {
        if (statSync(candidate).isDirectory()) return candidate;
      } catch {
        // keep walking
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("Unable to locate the root agents folder.");
}
