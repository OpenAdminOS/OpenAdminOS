import { verify } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

import type { CheckResult } from "./checks.js";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function runRegistryIndexChecks(): CheckResult[] {
  const agentsRoot = findAgentsRoot();
  const indexPath = join(agentsRoot, "index.json");
  const signaturePath = join(agentsRoot, "index.sig");
  const publicKeyPath = join(agentsRoot, "registry-public-key.pem");
  const revisionPath = join(agentsRoot, "registry-revision.txt");
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
    revision?: unknown;
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

  const declaredRevision = Number.parseInt(
    existsSync(revisionPath) ? readFileSync(revisionPath, "utf8").trim() : "",
    10,
  );
  const revisionValid =
    Number.isSafeInteger(declaredRevision) &&
    declaredRevision > 0 &&
    index.revision === declaredRevision;
  results.push({
    name: "registry-revision-valid",
    severity: revisionValid ? "pass" : "fail",
    message: revisionValid
      ? `Registry revision ${declaredRevision} matches the signed index.`
      : "agents/registry-revision.txt must contain the positive integer written to index.json.",
  });

  let signatureValid = false;
  try {
    const signature = Buffer.from(readFileSync(signaturePath, "utf8").trim(), "base64");
    signatureValid =
      signature.length === 64 &&
      verify(
        null,
        readFileSync(indexPath),
        readFileSync(publicKeyPath),
        signature,
      );
  } catch {
    signatureValid = false;
  }
  results.push({
    name: "registry-signature-valid",
    severity: signatureValid ? "pass" : "fail",
    message: signatureValid
      ? "agents/index.json has a valid detached Ed25519 signature."
      : "agents/index.sig is missing or does not verify against registry-public-key.pem.",
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
  const invalidManifestHashes: string[] = [];

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

  for (const entry of entries) {
    const hash = String(entry.manifestSha256 ?? "");
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      invalidManifestHashes.push(`${String(entry.slug ?? "unknown")}: ${hash || "missing"}`);
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
    name: "manifest-digests-present",
    severity: invalidManifestHashes.length > 0 ? "fail" : "pass",
    message:
      invalidManifestHashes.length > 0
        ? "Every registry entry must pin its manifest SHA-256 digest."
        : "Every registry entry pins its manifest SHA-256 digest.",
    ...(invalidManifestHashes.length > 0
      ? { details: invalidManifestHashes }
      : {}),
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
