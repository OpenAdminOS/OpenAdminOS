import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ajv2020,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { load as parseYaml } from "js-yaml";

import type { CheckResult } from "./checks.js";

export interface ManifestSchemaReport {
  /** Slug derived from the directory name. */
  slug: string;
  /** Absolute path to the YAML manifest. */
  manifestPath: string;
  /** Schema validation results (one per assertion). */
  results: CheckResult[];
}

/**
 * Validate every `agents/<slug>/manifest.yaml` against the canonical
 * JSON Schema. Agents without a YAML manifest (code-based) are skipped.
 * Returns one report per agent; an empty array means there's nothing to
 * validate (rare — at least one of our two showcase agents always ships
 * YAML).
 */
export function runManifestSchemaChecks(): ManifestSchemaReport[] {
  const schema = loadSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  const reports: ManifestSchemaReport[] = [];
  for (const yamlPath of findManifestYamlFiles()) {
    const slug = dirname(yamlPath).split(/[\\/]/).pop() ?? yamlPath;
    const results = validateOne(yamlPath, validate);
    reports.push({ slug, manifestPath: yamlPath, results });
  }
  return reports;
}

function validateOne(yamlPath: string, validate: ValidateFunction): CheckResult[] {
  const source = readFileSync(yamlPath, "utf8");

  let parsed: unknown;
  try {
    parsed = parseYaml(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      {
        name: "yaml-parse",
        severity: "fail",
        message: `Failed to parse YAML: ${message}`,
      },
    ];
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [
      {
        name: "yaml-shape",
        severity: "fail",
        message: "manifest.yaml must resolve to an object at the root.",
      },
    ];
  }

  const ok = validate(parsed);
  if (ok) {
    return [
      {
        name: "schema",
        severity: "pass",
        message: "Manifest conforms to schemas/agent-template.schema.json.",
      },
    ];
  }

  const errors = (validate.errors ?? []) as ErrorObject[];
  const details = errors.map(formatAjvError);
  return [
    {
      name: "schema",
      severity: "fail",
      message: `Manifest failed JSON Schema validation (${errors.length} issue${
        errors.length === 1 ? "" : "s"
      }).`,
      details,
    },
  ];
}

function formatAjvError(error: ErrorObject): string {
  const where = error.instancePath || "<root>";
  const message = error.message ?? "(no message)";
  const extras = error.params
    ? ` ${JSON.stringify(error.params)}`
    : "";
  return `${where}: ${message}${extras}`;
}

function loadSchema(): AnySchema {
  const schemaPath = findSchemaPath();
  return JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
}

function findSchemaPath(): string {
  const candidates = [
    join(repoRoot(), "schemas", "agent-template.schema.json"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `Unable to locate schemas/agent-template.schema.json. Looked in: ${candidates.join(", ")}.`,
  );
}

function findManifestYamlFiles(): string[] {
  const agentsRoot = join(repoRoot(), "agents");
  if (!existsSync(agentsRoot)) return [];
  return readdirSync(agentsRoot)
    .map((entry) => join(agentsRoot, entry))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    })
    .map((agentDir) => join(agentDir, "manifest.yaml"))
    .filter((candidate) => existsSync(candidate))
    .sort();
}

function repoRoot(): string {
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let current = resolve(start);
    while (true) {
      // The repo root is the first ancestor that contains BOTH `agents/`
      // and `schemas/` — the qa-graph package alone has `agents/` higher
      // up but no `schemas/` of its own.
      if (
        existsSync(join(current, "agents")) &&
        existsSync(join(current, "schemas"))
      ) {
        return current;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error("Unable to locate the repo root (no folder contains both agents/ and schemas/).");
}
