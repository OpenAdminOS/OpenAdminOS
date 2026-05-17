import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020, type AnySchema, type ErrorObject } from "ajv/dist/2020.js";

import type { CheckResult } from "./checks.js";
import { repoRoot } from "./schema-check.js";

export interface StatsReport {
  /**
   * Empty when `stats/agents.json` is absent on disk. A single check
   * result otherwise — pass when the file conforms to the schema AND
   * every slug present in `stats/agents.json` has a sibling agent on
   * disk; fail otherwise.
   */
  results: CheckResult[];
}

/**
 * Validate `stats/agents.json` against the canonical schema, and
 * cross-check that every slug in the file corresponds to an existing
 * agent directory. Bot-authored, but humans can break the schema in a
 * PR — this is the guardrail.
 */
export function runStatsChecks(): StatsReport {
  const statsPath = join(repoRoot(), "stats", "agents.json");
  if (!existsSync(statsPath)) {
    return { results: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statsPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      results: [
        {
          name: "stats-json-parse",
          severity: "fail",
          message: `Failed to parse stats/agents.json: ${message}`,
        },
      ],
    };
  }

  const schema = loadStatsSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);

  if (!validate(parsed)) {
    const errors = (validate.errors ?? []) as ErrorObject[];
    return {
      results: [
        {
          name: "stats-schema",
          severity: "fail",
          message: `stats/agents.json failed schema validation (${errors.length} issue${
            errors.length === 1 ? "" : "s"
          }).`,
          details: errors.map(formatAjvError),
        },
      ],
    };
  }

  const agentSlugs = listAgentSlugs();
  const statsSlugs = Object.keys(
    (parsed as { agents: Record<string, unknown> }).agents,
  );

  const unknownInStats = statsSlugs.filter((slug) => !agentSlugs.has(slug));
  if (unknownInStats.length > 0) {
    return {
      results: [
        {
          name: "stats-slugs",
          severity: "fail",
          message: `stats/agents.json references slug${
            unknownInStats.length === 1 ? "" : "s"
          } with no matching agent directory.`,
          details: unknownInStats.map((slug) => `agents/${slug}/ not found`),
        },
      ],
    };
  }

  const missingInStats = [...agentSlugs].filter((slug) => !statsSlugs.includes(slug));
  if (missingInStats.length > 0) {
    return {
      results: [
        {
          name: "stats-coverage",
          severity: "warn",
          message: `stats/agents.json is missing entries for ${missingInStats.length} agent${
            missingInStats.length === 1 ? "" : "s"
          } in agents/.`,
          details: missingInStats.map((slug) => `agents/${slug}/`),
        },
      ],
    };
  }

  return {
    results: [
      {
        name: "stats-schema",
        severity: "pass",
        message: `stats/agents.json conforms to schemas/stats.schema.json (${statsSlugs.length} agent${
          statsSlugs.length === 1 ? "" : "s"
        }).`,
      },
    ],
  };
}

function loadStatsSchema(): AnySchema {
  const schemaPath = join(repoRoot(), "schemas", "stats.schema.json");
  if (!existsSync(schemaPath)) {
    throw new Error(`Unable to locate ${schemaPath}.`);
  }
  return JSON.parse(readFileSync(schemaPath, "utf8")) as AnySchema;
}

function listAgentSlugs(): Set<string> {
  const agentsRoot = join(repoRoot(), "agents");
  if (!existsSync(agentsRoot)) return new Set();
  return new Set(
    readdirSync(agentsRoot).filter((slug) =>
      existsSync(join(agentsRoot, slug, "manifest.yaml")),
    ),
  );
}

function formatAjvError(error: ErrorObject): string {
  const where = error.instancePath || "<root>";
  const message = error.message ?? "(no message)";
  const extras = error.params ? ` ${JSON.stringify(error.params)}` : "";
  return `${where}: ${message}${extras}`;
}
