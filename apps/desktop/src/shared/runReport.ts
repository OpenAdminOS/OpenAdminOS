import type { RunRecord } from "./openAdminOS.js";

export interface RunReportContext {
  agentName?: string;
  tenantName?: string;
}

export function runReportPlaintext(
  run: RunRecord,
  ctx: RunReportContext = {},
): string {
  const title = ctx.agentName ?? run.agentSlug;
  const tenant = ctx.tenantName ?? run.tenantId ?? "—";

  const lines: string[] = [
    `${title} — ${run.status}`,
    `Started: ${run.queuedAt}`,
    `Duration: ${formatDuration(run)}`,
    `Provider: ${run.providerId ?? "—"}${run.model ? ` (${run.model})` : ""}`,
    `Tenant: ${tenant}`,
  ];

  if (run.summary) {
    lines.push("", "Summary:", run.summary);
  }

  if (run.steps.length > 0) {
    lines.push("", "Steps:");
    for (const step of run.steps) {
      lines.push(`  - [${step.status}] ${step.label}${step.detail ? ` — ${step.detail}` : ""}`);
    }
  }

  if (run.logs.length > 0) {
    lines.push("", "Logs:");
    for (const log of run.logs) {
      lines.push(`  ${log.timestamp} ${log.level.toUpperCase()} ${log.message}`);
    }
  }

  return lines.join("\n");
}

export function runReportMarkdown(
  run: RunRecord,
  ctx: RunReportContext = {},
): string {
  const title = ctx.agentName ?? run.agentSlug;
  const tenant = ctx.tenantName ?? run.tenantId ?? "—";

  const parts: string[] = [
    `# ${title}`,
    "",
    `**Status:** ${run.status}`,
    `**Started:** ${run.queuedAt}`,
    `**Duration:** ${formatDuration(run)}`,
    `**Provider:** ${run.providerId ?? "—"}${run.model ? ` (\`${run.model}\`)` : ""}`,
    `**Tenant:** ${tenant}`,
  ];

  if (run.summary) {
    parts.push("", "## Summary", "", run.summary);
  }

  if (run.steps.length > 0) {
    parts.push("", "## Steps", "");
    for (const step of run.steps) {
      parts.push(`- **[${step.status}]** ${step.label}${step.detail ? ` — ${step.detail}` : ""}`);
    }
  }

  if (run.logs.length > 0) {
    parts.push("", "## Logs", "", "```");
    for (const log of run.logs) {
      parts.push(`${log.timestamp} ${log.level.toUpperCase()} ${log.message}`);
    }
    parts.push("```");
  }

  if (run.result !== undefined) {
    parts.push("", "## Result", "", "```json", JSON.stringify(run.result, null, 2), "```");
  }

  return parts.join("\n");
}

export function runReportJson(run: RunRecord): string {
  return JSON.stringify(run, null, 2);
}

function formatDuration(run: RunRecord): string {
  if (!run.startedAt) return "—";
  const end = run.finishedAt
    ? new Date(run.finishedAt).getTime()
    : Date.now();
  const start = new Date(run.startedAt).getTime();
  const ms = end - start;
  if (Number.isNaN(ms) || ms < 0) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}
