import type { AppState, NovaAnswerLink, OfficeFinding, RunRecord } from "@openadminos/agent-sdk";

/**
 * "What needs me?": the open Agent Team findings and the runs waiting for
 * the admin's confirmation, in the active organization only. Read from
 * the app state on this device; nothing is sent, approved or started, and
 * every entry links to the page where the admin decides.
 */

/** Entries spoken and listed of each kind; the rest are counted. */
export const NOVA_ATTENTION_LIMIT = 5;

export interface NovaAttention {
  /** What Nova says. */
  text: string;
  /** The full list for the panel. */
  displayText: string;
  links: NovaAnswerLink[];
  findings: OfficeFinding[];
  approvals: RunRecord[];
}

function openNow(finding: OfficeFinding, now: number): boolean {
  if (finding.state === "open") return true;
  // A snooze that ran out counts as open, also before the next tick reopens it.
  return finding.state === "snoozed" && Date.parse(finding.snoozedUntil ?? "") <= now;
}

const SEVERITY_ORDER: Record<OfficeFinding["severity"], number> = { warning: 0, info: 1 };

// Finding titles, persona and agent names come from model output and tenant
// data. They are spoken and shown as labels only: one line, no markdown
// structure, bounded length. The hosted voice prompt already treats tool
// results as reference data, never as instructions.
const LABEL_MAX_LENGTH = 120;
export function attentionLabel(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[*_`#>\[\]|<]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > LABEL_MAX_LENGTH ? `${flat.slice(0, LABEL_MAX_LENGTH - 3).trimEnd()}...` : flat || "Untitled";
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function novaAttention(state: AppState, now: Date): NovaAttention {
  const tenantId = state.activeTenantId;
  const organization = attentionLabel(
    state.organizations?.find((entry) => entry.id === state.activeOrganizationId)?.name ||
    state.tenants.find((tenant) => tenant.id === tenantId)?.displayName ||
    "the active organization");
  const time = now.getTime();
  const findings = tenantId
    ? (state.office?.findings ?? [])
        .filter((finding) => finding.tenantId === tenantId && openNow(finding, time))
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || Date.parse(b.changedAt) - Date.parse(a.changedAt))
    : [];
  const approvals = tenantId
    ? state.runs
        .filter((run) => run.status === "awaiting-confirmation" && run.tenantId === tenantId)
        .sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt))
    : [];
  if (findings.length === 0 && approvals.length === 0) {
    const text = `Nothing needs you in ${organization}. There are no open Agent Team findings and no runs waiting for your confirmation.`;
    return { text, displayText: text, links: [], findings, approvals };
  }
  const agentName = (run: RunRecord) =>
    attentionLabel(state.installedAgents.find((agent) => agent.slug === run.agentSlug)?.name ?? run.agentSlug);
  const persona = (finding: OfficeFinding) => {
    const name = state.office?.personas.find((entry) => entry.id === finding.personaId)?.name;
    return name ? attentionLabel(name) : undefined;
  };
  const summary = [
    approvals.length ? plural(approvals.length, "run waits for your confirmation", "runs wait for your confirmation") : "",
    findings.length ? plural(findings.length, "Agent Team finding is open", "Agent Team findings are open") : "",
  ].filter(Boolean);
  const spokenApprovals = approvals.slice(0, NOVA_ATTENTION_LIMIT).map((run) => agentName(run));
  const spokenFindings = findings.slice(0, NOVA_ATTENTION_LIMIT).map((finding) => attentionLabel(finding.title));
  const text = [
    `In ${organization}, ${summary.join(" and ")}.`,
    spokenApprovals.length ? `Waiting for confirmation: ${spokenApprovals.join("; ")}${approvals.length > NOVA_ATTENTION_LIMIT ? `, and ${approvals.length - NOVA_ATTENTION_LIMIT} more` : ""}.` : "",
    spokenFindings.length ? `Open findings: ${spokenFindings.join("; ")}${findings.length > NOVA_ATTENTION_LIMIT ? `, and ${findings.length - NOVA_ATTENTION_LIMIT} more` : ""}.` : "",
    "Nothing was approved. Open each item in the app to decide.",
  ].filter(Boolean).join(" ");
  const lines = [`**${organization}**`, ""];
  if (approvals.length) {
    lines.push("Runs waiting for your confirmation:");
    for (const run of approvals.slice(0, NOVA_ATTENTION_LIMIT)) lines.push(`- ${agentName(run)}${run.queuedAt ? `, queued ${run.queuedAt.slice(0, 16).replace("T", " ")} UTC` : ""}`);
    if (approvals.length > NOVA_ATTENTION_LIMIT) lines.push(`- ${approvals.length - NOVA_ATTENTION_LIMIT} more in Runs`);
    lines.push("");
  }
  if (findings.length) {
    lines.push("Open Agent Team findings:");
    for (const finding of findings.slice(0, NOVA_ATTENTION_LIMIT)) {
      const who = persona(finding);
      lines.push(`- ${finding.severity === "warning" ? "Warning" : "Info"}: ${attentionLabel(finding.title)}${who ? ` (${who})` : ""}`);
    }
    if (findings.length > NOVA_ATTENTION_LIMIT) lines.push(`- ${findings.length - NOVA_ATTENTION_LIMIT} more in Agent Team`);
  }
  const links: NovaAnswerLink[] = [
    ...approvals.slice(0, NOVA_ATTENTION_LIMIT).map((run) => ({ label: `Review ${agentName(run)}`, route: `/runs/${run.id}` })),
    ...(findings.length ? [{ label: "Open Agent Team", route: "/office" }] : []),
  ];
  return { text, displayText: lines.join("\n").trim(), links, findings, approvals };
}
