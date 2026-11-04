import type { IntuneChatDocumentationSource, IntuneChatMessage, IntuneChatStep, IntuneChatStepOrigin } from "./openAdminOS.js";

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

/**
 * The live step list in the order it was first shown: a step already on
 * screen keeps its place and new steps append below it, so a list the host
 * ordered differently never rearranges visible rows.
 */
export function appendOnlySteps(shown: readonly IntuneChatStep[] | undefined, next: readonly IntuneChatStep[]): IntuneChatStep[] {
  if (!shown?.length) return [...next];
  const byId = new Map(next.map((step) => [step.id, step]));
  const kept = shown.flatMap((step) => {
    const updated = byId.get(step.id);
    return updated ? [updated] : [];
  });
  const keptIds = new Set(kept.map((step) => step.id));
  return [...kept, ...next.filter((step) => !keptIds.has(step.id))];
}

/** The scope line while an answer runs: the title of the step running now, or of the last one. */
export function currentStepTitle(steps: readonly IntuneChatStep[] | undefined): string {
  const list = steps ?? [];
  return [...list].reverse().find((step) => step.status === "active")?.title ?? list.at(-1)?.title ?? "Reading the question";
}

const TENANT_TOOLS = new Set(["list_cached_resources", "query_cache", "graph_get", "refresh_resource", "query_drift"]);

/**
 * Whether the answer rests on tenant data: the host marked it (cached rows
 * in a deterministic answer), a completed Graph refresh step, or a tenant
 * tool that succeeded.
 */
export function usedTenantEvidence(message: Pick<IntuneChatMessage, "steps" | "toolTrace" | "tenantContext">): boolean {
  return message.tenantContext === true || (message.steps ?? []).some((step) => step.kind === "graph-refresh" && step.status === "completed") ||
    (message.toolTrace ?? []).some((entry) => TENANT_TOOLS.has(entry.tool) && !entry.error);
}

/**
 * What an answer used: the MCP servers that answered, the local docs
 * index and the tenant. Read from the citation targets, the steps and the
 * trace, so a message whose trace was not stored still names Learn.
 */
export function answerSources(message: Pick<IntuneChatMessage, "steps" | "documentationSources" | "toolTrace" | "tenantContext">): string[] {
  const documentation = message.documentationSources ?? [];
  const servers = new Set([
    ...documentation.filter((source) => source.kind === "mcp").map((source) => source.serverName ?? "MCP server"),
    ...(message.toolTrace ?? []).filter((entry) => entry.mcpSource && !entry.error).map((entry) => entry.mcpSource!.serverName),
  ]);
  return [
    ...servers,
    ...(documentation.some((source) => source.kind === "docs-index") ? ["docs index"] : []),
    ...(usedTenantEvidence(message) ? ["your tenant"] : []),
  ];
}

/**
 * How long the run took, first start to last end. Steps can overlap (an
 * older model step spanned its tool calls), so durations are not summed;
 * steps without a usable start time fall back to the sum.
 */
function wallTimeMs(steps: readonly IntuneChatStep[]): number {
  const spans = steps.map((step) => ({ start: Date.parse(step.startedAt), end: Date.parse(step.startedAt) + (step.durationMs ?? 0) }));
  if (spans.length === 0 || spans.some((span) => !Number.isFinite(span.start))) return steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);
  return Math.max(...spans.map((span) => span.end)) - Math.min(...spans.map((span) => span.start));
}

/**
 * The folded line after an answer: how many steps, how long, which
 * sources, and what left the device and where it went. Labels come from
 * the steps and the citation targets, never from model text.
 */
export function summarizeSteps(message: Pick<IntuneChatMessage, "steps" | "documentationSources" | "toolTrace" | "tenantContext">): {
  count: number;
  totalMs: number;
  sources: string;
  egress: string;
} {
  const steps = message.steps ?? [];
  const sources = answerSources(message);
  // Graph refreshes and reads send requests to Microsoft Graph (decision 2026-11-04): they are listed too.
  const sent = new Map<string, Set<string>>();
  const add = (where: string, what: string) => sent.set(where, (sent.get(where) ?? new Set()).add(what));
  for (const step of steps) {
    if (step.origin === "graph" && step.status !== "blocked") add(step.originLabel, "requests");
    // The host clears sent text when a call was blocked or failed before it reached the host.
    if (step.kind === "mcp" && step.status !== "blocked" && step.sent) add(step.originLabel, "search text");
    if (step.origin === "model" && step.kind === "answer") add(step.originLabel, "answer context");
    if (step.origin === "model" && step.kind === "tool") add(step.originLabel, "search text");
  }
  const egress = sent.size === 0
    ? "Nothing left this device"
    : `Left this device: ${joinList([...sent].map(([where, what]) => `${joinList([...what])} to ${where}`))}`;
  return {
    count: steps.length,
    totalMs: wallTimeMs(steps),
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

/**
 * One key per article: lowercase host, no fragment, no locale segment such
 * as /en-us/, no trailing slash. Chunks of one Learn page share it.
 */
export function normalizeSourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/)/i, "").replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path.toLowerCase()}${parsed.search}`;
  } catch {
    return url;
  }
}

/** A source card: the first source of one article or file, with every citation number that points at it. */
export type SourceCard = IntuneChatDocumentationSource & { citations: number[] };

/** Sources merged into one card per article or file; `cardFor` maps any citation number to its card. */
export function mergeSources(sources: readonly IntuneChatDocumentationSource[]): { cards: SourceCard[]; cardFor: (citation: number) => SourceCard | undefined } {
  const byKey = new Map<string, SourceCard>();
  const byCitation = new Map<number, SourceCard>();
  for (const source of [...sources].sort((a, b) => a.citation - b.citation)) {
    const key = source.url ? `url:${normalizeSourceUrl(source.url)}` : source.file ? `file:${source.file}` : `citation:${source.citation}`;
    const card = byKey.get(key) ?? { ...source, citations: [] };
    card.citations.push(source.citation);
    byKey.set(key, card);
    byCitation.set(source.citation, card);
  }
  return { cards: [...byKey.values()], cardFor: (citation) => byCitation.get(citation) };
}

/**
 * Adjacent citations ("[4][2] [6]") as one ascending run without repeats,
 * each number replaced by its card's number, so merged chunks show once.
 * Code is left alone.
 */
export function orderCitationRuns(content: string, sources: readonly IntuneChatDocumentationSource[]): string {
  const { cardFor } = mergeSources(sources);
  return content.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => index % 2 === 1 ? part : part.replace(
    /\[\d{1,2}\](?!\()(?:[ ,]*\[\d{1,2}\](?!\())+/g,
    (run) => {
      const numbers = [...run.matchAll(/\[(\d{1,2})\]/g)].map((match) => cardFor(Number(match[1]))?.citation ?? Number(match[1]));
      return [...new Set(numbers)].sort((a, b) => a - b).map((n) => `[${n}]`).join("");
    },
  )).join("");
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

/**
 * Source cards: the cited sources in citation order. When the answer cites
 * nothing, the MCP results it was given are shown as consulted, not cited.
 * The host registers MCP results only for calls that answered, so a failed
 * or blocked call never appears.
 */
export function sourcesForCards(content: string, sources: readonly IntuneChatDocumentationSource[]): { cited: boolean; sources: SourceCard[] } {
  const { cards, cardFor } = mergeSources(sources);
  const cited = new Set(citedNumbers(content, sources).map((citation) => cardFor(citation)?.citation));
  if (cited.size > 0) return { cited: true, sources: cards.filter((card) => cited.has(card.citation)) };
  return { cited: false, sources: cards.filter((source) => source.kind === "mcp").slice(0, 4) };
}

/** "2026-08-26" as "Aug 26, 2026". */
export function formatIndexVersion(version: string): string {
  const date = new Date(`${version.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? version
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
