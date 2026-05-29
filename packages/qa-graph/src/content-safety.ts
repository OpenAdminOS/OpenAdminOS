import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { CheckResult } from "./checks.js";
import type { AgentManifest } from "./load-agents.js";

const SECRET_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { name: "client secret", pattern: /\b(client_secret|clientSecret|api[_-]?key|token)\b\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{16,}/i },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "OpenAI key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
];

const PERSONAL_DATA_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "email address", pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  { name: "tenant GUID", pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i },
];

const UNSUPPORTED_CLAIMS = /\b(guarantee|guaranteed|no risk|risk-free|always safe|will remediate|fully secure)\b/i;

export function runContentSafetyChecks(
  manifests: AgentManifest[],
): { slug: string; results: CheckResult[] }[] {
  return manifests.map((manifest) => ({
    slug: manifest.slug,
    results: checkAgentContent(manifest),
  }));
}

function checkAgentContent(agent: AgentManifest): CheckResult[] {
  const agentDir = dirname(agent.manifestPath);
  const readmePath = join(agentDir, "README.md");
  const results: CheckResult[] = [];
  const files = [{ label: "manifest.yaml", content: readFileSync(agent.manifestPath, "utf8") }];

  if (!existsSync(readmePath)) {
    results.push({
      name: "readme-present",
      severity: "fail",
      message: "Agent README.md is required for community review.",
    });
  } else {
    results.push({
      name: "readme-present",
      severity: "pass",
      message: "README.md present.",
    });
    files.push({ label: "README.md", content: readFileSync(readmePath, "utf8") });
  }

  const secretHits = findPatternHits(files, SECRET_PATTERNS);
  results.push({
    name: "no-secrets",
    severity: secretHits.length > 0 ? "fail" : "pass",
    message:
      secretHits.length > 0
        ? "Possible secrets found in agent content."
        : "No secret-like values found.",
    ...(secretHits.length > 0 ? { details: secretHits } : {}),
  });

  const personalDataHits = findPatternHits(files, PERSONAL_DATA_PATTERNS);
  results.push({
    name: "no-personal-data",
    severity: personalDataHits.length > 0 ? "fail" : "pass",
    message:
      personalDataHits.length > 0
        ? "Tenant-specific or personal data found in agent content."
        : "No tenant-specific or personal data found.",
    ...(personalDataHits.length > 0 ? { details: personalDataHits } : {}),
  });

  const unsupportedClaims = files
    .filter((file) => UNSUPPORTED_CLAIMS.test(file.content))
    .map((file) => `${file.label}: unsupported safety or remediation claim`);
  results.push({
    name: "claims-grounded",
    severity: unsupportedClaims.length > 0 ? "fail" : "pass",
    message:
      unsupportedClaims.length > 0
        ? "Remove unsupported guarantees from public agent copy."
        : "No unsupported guarantee language found.",
    ...(unsupportedClaims.length > 0 ? { details: unsupportedClaims } : {}),
  });

  return results;
}

function findPatternHits(
  files: { label: string; content: string }[],
  patterns: { name: string; pattern: RegExp }[],
): string[] {
  const hits: string[] = [];
  for (const file of files) {
    for (const pattern of patterns) {
      if (pattern.pattern.test(file.content)) {
        hits.push(`${file.label}: ${pattern.name}`);
      }
    }
  }
  return hits;
}
