import type { RunRecord } from "./openAdminOS.js";
import { PILOT_COPY } from "./pilot-mode.js";

export interface RunReportContext {
  agentName?: string;
  tenantName?: string;
  sampleData?: boolean;
}

export function runReportPlaintext(
  run: RunRecord,
  ctx: RunReportContext = {},
): string {
  const title = ctx.agentName ?? run.agentSlug;
  const tenant = ctx.tenantName ?? run.tenantId ?? "Not available";

  const lines: string[] = [
    `${title}: ${run.status === "planned" ? "Dry run: not applied" : run.status}`,
    `Started: ${run.queuedAt}`,
    `Duration: ${formatDuration(run)}`,
    `Provider: ${runProviderLabel(run)}`,
    `Tenant: ${tenant}`,
    ...(ctx.sampleData ? ["Data: Pilot mode sample data from a fictional company"] : []),
  ];

  if (run.summary) {
    lines.push("", "Summary:", run.summary);
  }

  if (run.steps.length > 0) {
    lines.push("", "Steps:");
    for (const step of run.steps) {
      lines.push(`  - [${step.status}] ${step.label}${step.detail ? `: ${step.detail}` : ""}`);
    }
  }

  if (run.logs.length > 0) {
    lines.push("", "Logs:");
    for (const log of run.logs) {
      lines.push(`  ${log.timestamp} ${log.level.toUpperCase()} ${log.message}`);
    }
  }

  const note = aiGeneratedNote(run);
  if (note) {
    lines.push("", note);
  }

  return lines.join("\n");
}

export function runReportMarkdown(
  run: RunRecord,
  ctx: RunReportContext = {},
): string {
  const title = ctx.agentName ?? run.agentSlug;
  const tenant = ctx.tenantName ?? run.tenantId ?? "Not available";

  const parts: string[] = [
    `# ${title}`,
    "",
    `**Status:** ${run.status === "planned" ? "Dry run: not applied" : run.status}`,
    `**Started:** ${run.queuedAt}`,
    `**Duration:** ${formatDuration(run)}`,
    `**Provider:** ${run.pilot ? PILOT_COPY.providerName : `${run.providerId ?? "Not available"}${run.model ? ` (\`${run.model}\`)` : ""}`}`,
    `**Tenant:** ${tenant}`,
    ...(ctx.sampleData ? ["**Data:** Pilot mode sample data from a fictional company"] : []),
  ];

  if (run.summary) {
    parts.push("", "## Summary", "", run.summary);
  }

  if (run.steps.length > 0) {
    parts.push("", "## Steps", "");
    for (const step of run.steps) {
      parts.push(`- **[${step.status}]** ${step.label}${step.detail ? `: ${step.detail}` : ""}`);
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

  const note = aiGeneratedNote(run);
  if (note) {
    parts.push("", "---", "", `_${note}_`);
  }

  return parts.join("\n");
}

/**
 * Disclosure line for reports that contain model output (EU AI Act
 * Article 50(2)). Runs without a provider, such as deterministic baseline
 * rollbacks, carry no model text and get no note.
 */
export function aiGeneratedNote(run: RunRecord): string | undefined {
  // Pilot runs use prepared sample text, so the note must not claim that a
  // model produced it.
  if (run.pilot) return PILOT_COPY.reportNote;
  if (!run.providerId) return undefined;
  const source = run.model ? `${run.providerId} (${run.model})` : run.providerId;
  return `This report includes AI-generated text, produced in OpenAdminOS with ${source}.`;
}

export function runReportJson(
  run: RunRecord,
  ctx: RunReportContext = {},
): string {
  return JSON.stringify(
    ctx.sampleData
      ? {
          sampleData: true,
          sampleDataNotice: "Pilot mode sample data from a fictional company",
          run,
        }
      : run,
    null,
    2,
  );
}

function runProviderLabel(run: RunRecord): string {
  if (run.pilot) return PILOT_COPY.providerName;
  return `${run.providerId ?? "Not available"}${run.model ? ` (${run.model})` : ""}`;
}

function formatDuration(run: RunRecord): string {
  if (!run.startedAt) return "Not available";
  const end = run.finishedAt
    ? new Date(run.finishedAt).getTime()
    : Date.now();
  const start = new Date(run.startedAt).getTime();
  const ms = end - start;
  if (Number.isNaN(ms) || ms < 0) return "Not available";
  return `${(ms / 1000).toFixed(1)}s`;
}
