import type { CheckResult, Severity } from "./checks.js";

const SYMBOL: Record<Severity, string> = {
  pass: "[PASS]",
  warn: "[WARN]",
  fail: "[FAIL]",
};

export interface AgentReport {
  slug: string;
  name: string;
  results: CheckResult[];
}

export interface ProjectReport {
  agents: AgentReport[];
  fixtures: { name: string; results: CheckResult[] }[];
  /**
   * One entry per `agents/<slug>/manifest.yaml` validated against
   * `schemas/agent-template.schema.json`.
   */
  schemas: { slug: string; manifestPath: string; results: CheckResult[] }[];
  content: { slug: string; results: CheckResult[] }[];
  registry: { results: CheckResult[] };
  /**
   * Validation results for `stats/agents.json`. Empty `results` array
   * means the file is absent (acceptable until phase 3 lands). One entry
   * with `severity: "fail"` means the file is present but malformed.
   */
  stats: { results: CheckResult[] };
}

export function formatReport(report: ProjectReport): string {
  const lines: string[] = [];
  lines.push("Graph QA report");
  lines.push("===============");

  for (const agent of report.agents) {
    lines.push("");
    const severity = summarize(agent.results);
    lines.push(`${SYMBOL[severity]} ${agent.slug}  -  ${agent.name}`);
    for (const result of agent.results) {
      lines.push(`  ${SYMBOL[result.severity]} ${result.name}: ${result.message}`);
      if (result.details) {
        for (const detail of result.details) {
          lines.push(`      - ${detail}`);
        }
      }
    }
  }

  for (const fixture of report.fixtures) {
    lines.push("");
    const severity = summarize(fixture.results);
    lines.push(`${SYMBOL[severity]} fixture: ${fixture.name}`);
    for (const result of fixture.results) {
      lines.push(`  ${SYMBOL[result.severity]} ${result.name}: ${result.message}`);
      if (result.details) {
        for (const detail of result.details) {
          lines.push(`      - ${detail}`);
        }
      }
    }
  }

  for (const schema of report.schemas) {
    lines.push("");
    const severity = summarize(schema.results);
    lines.push(`${SYMBOL[severity]} schema: ${schema.slug}`);
    for (const result of schema.results) {
      lines.push(`  ${SYMBOL[result.severity]} ${result.name}: ${result.message}`);
      if (result.details) {
        for (const detail of result.details) {
          lines.push(`      - ${detail}`);
        }
      }
    }
  }

  if (report.stats.results.length > 0) {
    lines.push("");
    const severity = summarize(report.stats.results);
    lines.push(`${SYMBOL[severity]} stats: stats/agents.json`);
    for (const result of report.stats.results) {
      lines.push(`  ${SYMBOL[result.severity]} ${result.name}: ${result.message}`);
      if (result.details) {
        for (const detail of result.details) {
          lines.push(`      - ${detail}`);
        }
      }
    }
  }

  if (report.registry.results.length > 0) {
    lines.push("");
    const severity = summarize(report.registry.results);
    lines.push(`${SYMBOL[severity]} registry: agents/index.json`);
    for (const result of report.registry.results) {
      lines.push(`  ${SYMBOL[result.severity]} ${result.name}: ${result.message}`);
      if (result.details) {
        for (const detail of result.details) {
          lines.push(`      - ${detail}`);
        }
      }
    }
  }

  for (const content of report.content) {
    lines.push("");
    const severity = summarize(content.results);
    lines.push(`${SYMBOL[severity]} content: ${content.slug}`);
    for (const result of content.results) {
      lines.push(`  ${SYMBOL[result.severity]} ${result.name}: ${result.message}`);
      if (result.details) {
        for (const detail of result.details) {
          lines.push(`      - ${detail}`);
        }
      }
    }
  }

  const totals = countTotals(report);
  lines.push("");
  lines.push(
    `Totals: ${totals.pass} pass, ${totals.warn} warn, ${totals.fail} fail.`,
  );
  return lines.join("\n");
}

export function reportExitCode(report: ProjectReport): number {
  const totals = countTotals(report);
  return totals.fail > 0 ? 1 : 0;
}

function summarize(results: CheckResult[]): Severity {
  if (results.some((result) => result.severity === "fail")) return "fail";
  if (results.some((result) => result.severity === "warn")) return "warn";
  return "pass";
}

function countTotals(report: ProjectReport): { pass: number; warn: number; fail: number } {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const agent of report.agents) {
    for (const result of agent.results) {
      if (result.severity === "pass") pass++;
      else if (result.severity === "warn") warn++;
      else fail++;
    }
  }
  for (const fixture of report.fixtures) {
    for (const result of fixture.results) {
      if (result.severity === "pass") pass++;
      else if (result.severity === "warn") warn++;
      else fail++;
    }
  }
  for (const schema of report.schemas) {
    for (const result of schema.results) {
      if (result.severity === "pass") pass++;
      else if (result.severity === "warn") warn++;
      else fail++;
    }
  }
  for (const result of report.stats.results) {
    if (result.severity === "pass") pass++;
    else if (result.severity === "warn") warn++;
    else fail++;
  }
  for (const result of report.registry.results) {
    if (result.severity === "pass") pass++;
    else if (result.severity === "warn") warn++;
    else fail++;
  }
  for (const content of report.content) {
    for (const result of content.results) {
      if (result.severity === "pass") pass++;
      else if (result.severity === "warn") warn++;
      else fail++;
    }
  }
  return { pass, warn, fail };
}
