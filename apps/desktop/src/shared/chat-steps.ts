import type { IntuneChatDocumentationSource, IntuneChatMessage, IntuneChatStepOrigin } from "./openAdminOS.js";

/** Theme tokens per origin: on device, Microsoft Graph, a third-party host, the model provider. */
export const STEP_ORIGIN_TONE: Record<IntuneChatStepOrigin, { text: string; soft: string; dot: string }> = {
  device: { text: "text-[var(--color-success)]", soft: "bg-[var(--color-success-soft)]", dot: "bg-[var(--color-success)]" },
  graph: { text: "text-[var(--color-info)]", soft: "bg-[var(--color-info-soft)]", dot: "bg-[var(--color-info)]" },
  "third-party": { text: "text-[var(--color-warning)]", soft: "bg-[var(--color-warning-soft)]", dot: "bg-[var(--color-warning)]" },
  model: { text: "text-[var(--color-think)]", soft: "bg-[var(--color-think-soft)]", dot: "bg-[var(--color-think)]" },
};

export function formatStepDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const TENANT_TOOLS = new Set(["list_cached_resources", "query_cache", "graph_get", "refresh_resource", "query_drift"]);

/** Whether the answer read the tenant: a completed Graph refresh step or a tenant tool that succeeded. */
export function usedTenantEvidence(message: Pick<IntuneChatMessage, "steps" | "toolTrace">): boolean {
  return (message.steps ?? []).some((step) => step.kind === "graph-refresh" && step.status === "completed") ||
    (message.toolTrace ?? []).some((entry) => TENANT_TOOLS.has(entry.tool) && !entry.error);
}

/**
 * The folded line after an answer: how many steps, how long, which
 * sources, and what left the device and where it went. Labels come from
 * the steps and the citation targets, never from model text.
 */
export function summarizeSteps(message: Pick<IntuneChatMessage, "steps" | "documentationSources" | "toolTrace">): {
  count: number;
  totalMs: number;
  sources: string;
  egress: string;
} {
  const steps = message.steps ?? [];
  const servers = [...new Set((message.toolTrace ?? []).filter((entry) => entry.mcpSource && !entry.error).map((entry) => entry.mcpSource!.serverName))];
  const sources = [
    ...servers,
    ...((message.documentationSources ?? []).some((source) => source.kind === "docs-index") ? ["docs index"] : []),
    ...(usedTenantEvidence(message) ? ["your tenant"] : []),
  ];
  const sent = new Map<string, Set<string>>();
  const add = (where: string, what: string) => sent.set(where, (sent.get(where) ?? new Set()).add(what));
  for (const step of steps) {
    // A blocked call sent nothing; a failed one may have reached the host.
    if (step.kind === "mcp" && step.status !== "blocked" && step.sent) add(step.originLabel, "search text");
    if (step.origin === "model" && step.kind === "answer") add(step.originLabel, "answer context");
    if (step.origin === "model" && step.kind === "tool") add(step.originLabel, "search text");
  }
  const egress = sent.size === 0
    ? "Nothing left this device"
    : `Left this device: ${joinList([...sent].map(([where, what]) => `${joinList([...what])} to ${where}`))}`;
  return {
    count: steps.length,
    totalMs: steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0),
    sources: sources.length > 0 ? joinList(sources) : "no sources",
    egress,
  };
}

export interface AnswerBlock {
  kind: "docs" | "tenant" | "plain";
  /** Trace-derived label, for example "Microsoft Learn" or "Your tenant". */
  label?: string;
  text: string;
}

/** The citation numbers in a text that match a known source. */
export function citedNumbers(text: string, sources: readonly IntuneChatDocumentationSource[]): number[] {
  const known = new Set(sources.map((source) => source.citation));
  return [...new Set([...text.matchAll(/\[(\d{1,2})\](?!\()/g)].map((match) => Number(match[1])).filter((n) => known.has(n)))];
}

/** Paragraphs split at blank lines, keeping fenced code blocks whole. */
function chunks(content: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && line.trim() === "" && current.length > 0) {
      out.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.join("").trim()) out.push(current.join("\n"));
  return out;
}

function docsLabel(citations: readonly number[], sources: readonly IntuneChatDocumentationSource[]): string {
  const cited = sources.filter((source) => citations.includes(source.citation));
  const names = [...new Set(cited.map((source) => (source.kind === "mcp" ? source.serverName ?? "MCP server" : "Docs index")))];
  return names.length > 0 ? joinList(names) : "Documentation";
}

/**
 * Splits an answer into documentation and tenant blocks. A paragraph that
 * cites a known source is documentation; a code block stays with the
 * paragraph before it; other prose is tenant when tenant tools ran.
 * Without tenant evidence the whole answer is one documentation block,
 * and without documentation sources it is one unlabelled block.
 */
export function splitAnswerBlocks(content: string, input: {
  documentationSources: readonly IntuneChatDocumentationSource[];
  tenantEvidence: boolean;
}): AnswerBlock[] {
  const sources = input.documentationSources;
  if (sources.length === 0 || citedNumbers(content, sources).length === 0 && input.tenantEvidence) {
    return [{ kind: "plain", text: content }];
  }
  if (!input.tenantEvidence) {
    return [{ kind: "docs", label: docsLabel(citedNumbers(content, sources), sources), text: content }];
  }
  const blocks: Array<{ kind: "docs" | "tenant"; text: string; citations: number[] }> = [];
  for (const chunk of chunks(content)) {
    const citations = citedNumbers(chunk, sources);
    const previous = blocks.at(-1);
    const kind = citations.length > 0 ? "docs" : /^\s*```/.test(chunk) && previous ? previous.kind : "tenant";
    if (previous?.kind === kind) {
      previous.text += `\n\n${chunk}`;
      previous.citations.push(...citations);
    } else blocks.push({ kind, text: chunk, citations });
  }
  return blocks.map((block) => ({
    kind: block.kind,
    label: block.kind === "docs" ? docsLabel(block.citations, sources) : "Your tenant",
    text: block.text,
  }));
}

/** Source cards: the cited sources in citation order, or the MCP results when nothing was cited. */
export function sourcesForCards(content: string, sources: readonly IntuneChatDocumentationSource[]): IntuneChatDocumentationSource[] {
  const cited = citedNumbers(content, sources);
  if (cited.length > 0) return sources.filter((source) => cited.includes(source.citation));
  return sources.filter((source) => source.kind === "mcp").slice(0, 4);
}

/** "2026-08-26" as "Aug 26, 2026". */
export function formatIndexVersion(version: string): string {
  const date = new Date(`${version.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? version
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
