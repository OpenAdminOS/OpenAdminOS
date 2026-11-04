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
export function answerSources(message: Pick<IntuneChatMessage, "steps" | "documentationSources" | "toolTrace" | "tenantContext" | "sources">): string[] {
  const documentation = message.documentationSources ?? [];
  const servers = new Set([
    ...documentation.filter((source) => source.kind === "mcp").map((source) => source.serverName ?? "MCP server"),
    ...(message.toolTrace ?? []).filter((entry) => entry.mcpSource && !entry.error).map((entry) => entry.mcpSource!.serverName),
  ]);
  return [
    ...servers,
    ...(documentation.some((source) => source.kind === "docs-index") ? ["docs index"] : []),
    ...(usedTenantEvidence(message) || legacyTenantRows(message) ? ["your tenant"] : []),
  ];
}

/** Answers stored before steps existed marked tenant data only as source rows. */
function legacyTenantRows(message: Pick<IntuneChatMessage, "steps" | "sources">): boolean {
  return (message.steps ?? []).length === 0 && (message.sources ?? []).some((source) => source.rows > 0 && !source.error);
}

/**
 * A documentation answer that never touched the tenant: the question was
 * classified as docs and no refresh or tenant tool ran. Its header shows
 * no tenant, and its summary says the tenant was not used.
 */
export function tenantNotUsed(message: Pick<IntuneChatMessage, "questionKind" | "steps" | "toolTrace" | "tenantContext">): boolean {
  return message.questionKind === "docs" && !usedTenantEvidence(message);
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

/** What a hosted model receives to write the answer. */
export const ANSWER_CONTEXT_DETAIL = "The question, recent turns of this chat, and the results of the steps that ran for this answer.";

/** One place data went: what was sent there, and each item exactly as the steps recorded it. */
export interface EgressEntry {
  where: string;
  origin: IntuneChatStepOrigin;
  what: string[];
  items: string[];
}

/**
 * What left the device, per destination, in the order the steps ran:
 * search text to each MCP host a query reached, requests to Microsoft
 * Graph, and the answer context or a web search to a hosted model. A
 * local model has the device origin, so it never appears here.
 */
export function egressEntries(steps: readonly IntuneChatStep[]): EgressEntry[] {
  const byPlace = new Map<string, EgressEntry>();
  const add = (step: IntuneChatStep, what: string, item: string) => {
    const entry = byPlace.get(step.originLabel) ?? { where: step.originLabel, origin: step.origin, what: [], items: [] };
    if (!entry.what.includes(what)) entry.what.push(what);
    if (!entry.items.includes(item)) entry.items.push(item);
    byPlace.set(step.originLabel, entry);
  };
  for (const step of steps) {
    // Graph refreshes and reads send requests to Microsoft Graph (decision 2026-11-04).
    if (step.origin === "graph" && step.status !== "blocked") add(step, "requests", step.detail ? `${step.title}: ${step.detail}` : step.title);
    // The host clears sent text when a call was blocked or failed before it reached the host.
    if (step.kind === "mcp" && step.status !== "blocked" && step.sent) add(step, "search text", step.sent);
    if (step.origin === "model" && step.kind === "answer") add(step, "answer context", ANSWER_CONTEXT_DETAIL);
    if (step.origin === "model" && step.kind === "tool") add(step, "search text", step.detail ? `${step.title}: ${step.detail}` : step.title);
  }
  return [...byPlace.values()];
}

/** Steps per origin, for the icons in the folded line: on device, Microsoft Graph, MCP hosts, the model provider. */
export function originCounts(steps: readonly IntuneChatStep[]): Array<{ origin: IntuneChatStepOrigin; label: string; count: number }> {
  const order: IntuneChatStepOrigin[] = ["device", "graph", "third-party", "model"];
  return order.flatMap((origin) => {
    const matching = steps.filter((step) => step.origin === origin);
    if (matching.length === 0) return [];
    const labels = [...new Set(matching.map((step) => step.originLabel))];
    return [{ origin, label: joinList(labels), count: matching.length }];
  });
}

/**
 * The folded line after an answer: how many steps, how long, which
 * sources, and what left the device and where it went. Labels come from
 * the steps and the citation targets, never from model text.
 */
export function summarizeSteps(message: Pick<IntuneChatMessage, "steps" | "documentationSources" | "toolTrace" | "tenantContext" | "sources">): {
  count: number;
  totalMs: number;
  sources: string;
  /** "Nothing left this device", or what went where after "Sent: ". */
  egress: string;
  sent: EgressEntry[];
} {
  const steps = message.steps ?? [];
  const sources = answerSources(message);
  const sent = egressEntries(steps);
  const egress = sent.length === 0
    ? "Nothing left this device"
    : `Sent: ${sent.map((entry) => `${joinList(entry.what)} to ${entry.where}`).join(", ")}`;
  return {
    count: steps.length,
    totalMs: wallTimeMs(steps),
    sources: sources.length > 0 ? joinList(sources) : "no sources",
    egress,
    sent,
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

/** Text outside code: even parts of the split are prose, odd parts code. */
function proseParts(content: string): string[] {
  return content.split(/(```[\s\S]*?```|`[^`\n]*`)/);
}

const CITATION = /\[(\d{1,2})\](?!\()/g;

/** The numbering readers see: cited cards 1..N in order of first appearance. */
export interface CitationNumbering {
  /** The shown number of a stored citation number, when it points at a known source. */
  displayFor: (citation: number) => number | undefined;
  /** The cited cards in shown order, each with its shown number and how often the answer cites it. */
  cited: Array<SourceCard & { display: number; uses: number }>;
  /** Cards the answer was given but does not cite. */
  consulted: SourceCard[];
}

/**
 * Numbers only the sources the answer cites, consecutively from 1 in the
 * order they first appear, outside code. Chunks of one article share
 * their card's number. Sources the answer does not cite are listed as
 * consulted. Computed from the stored answer and its citation targets, so
 * a reloaded message numbers the same.
 */
export function numberCitations(content: string, sources: readonly IntuneChatDocumentationSource[]): CitationNumbering {
  const { cards, cardFor } = mergeSources(sources);
  const display = new Map<number, number>();
  const uses = new Map<number, number>();
  proseParts(content).forEach((part, index) => {
    if (index % 2 === 1) return;
    for (const match of part.matchAll(CITATION)) {
      const card = cardFor(Number(match[1]));
      if (!card) continue;
      if (!display.has(card.citation)) display.set(card.citation, display.size + 1);
      uses.set(card.citation, (uses.get(card.citation) ?? 0) + 1);
    }
  });
  const cited = cards
    .filter((card) => display.has(card.citation))
    .map((card) => ({ ...card, display: display.get(card.citation)!, uses: uses.get(card.citation)! }))
    .sort((a, b) => a.display - b.display);
  return {
    displayFor: (citation) => {
      const card = cardFor(citation);
      return card ? display.get(card.citation) : undefined;
    },
    cited,
    consulted: cards.filter((card) => !display.has(card.citation)),
  };
}

/**
 * Adjacent citations ("[4][2] [6]") as one run without repeats, in shown
 * order, each number replaced by its card's number, so merged chunks show
 * once. Code is left alone.
 */
export function orderCitationRuns(content: string, sources: readonly IntuneChatDocumentationSource[]): string {
  const { cardFor } = mergeSources(sources);
  const { displayFor } = numberCitations(content, sources);
  const rank = (n: number) => displayFor(n) ?? 1000 + n;
  return proseParts(content).map((part, index) => index % 2 === 1 ? part : part.replace(
    /\[\d{1,2}\](?!\()(?:[ ,]*\[\d{1,2}\](?!\())+/g,
    (run) => {
      const numbers = [...run.matchAll(/\[(\d{1,2})\]/g)].map((match) => cardFor(Number(match[1]))?.citation ?? Number(match[1]));
      return [...new Set(numbers)].sort((a, b) => rank(a) - rank(b)).map((n) => `[${n}]`).join("");
    },
  )).join("");
}

/**
 * The answer text with the numbers readers see, for copying. Numbers that
 * point at no source stay as they are. Code is left alone.
 */
export function renumberCitations(content: string, sources: readonly IntuneChatDocumentationSource[]): string {
  const ordered = orderCitationRuns(content, sources);
  const { displayFor } = numberCitations(ordered, sources);
  return proseParts(ordered).map((part, index) => index % 2 === 1 ? part : part.replace(CITATION, (match, n: string) => {
    const shown = displayFor(Number(n));
    return shown === undefined ? match : `[${shown}]`;
  })).join("");
}

/** The host a reader sees for a source: the MCP host, or the local docs index. */
export function sourceHost(source: IntuneChatDocumentationSource): string {
  return source.kind === "mcp" ? source.host ?? "third-party host" : "Local docs index";
}

/**
 * The line after "Sources": the distinct third-party hosts, said once to
 * be unverified, and the local docs index when it was used. The index is
 * bundled with the app, so it is never named as third-party.
 */
export function sourcesHeadingDetail(sources: readonly IntuneChatDocumentationSource[]): string {
  const hosts = [...new Set(sources.filter((source) => source.kind === "mcp").map(sourceHost))];
  const parts = [
    ...(hosts.length > 0 ? [`${joinList(hosts)}, not verified by OpenAdminOS`] : []),
    ...(sources.some((source) => source.kind === "docs-index") ? ["Local docs index on this device"] : []),
  ];
  return parts.join(" · ");
}

const LEARN_HOST = /(^|\.)learn\.microsoft\.com$/i;

/**
 * The Microsoft Learn page that supplies more than half of an answer's
 * citations, counting every citation in the text, for an "Open in Learn"
 * link on the answer.
 */
export function mainLearnPage(numbering: CitationNumbering): (SourceCard & { display: number }) | undefined {
  const total = numbering.cited.reduce((sum, card) => sum + card.uses, 0);
  const top = numbering.cited.find((card) => card.uses * 2 > total);
  if (!top?.url || top.kind !== "mcp") return undefined;
  try {
    return LEARN_HOST.test(new URL(top.url).hostname) ? top : undefined;
  } catch {
    return undefined;
  }
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
 * Blocks are labelled only when an answer has both kinds. Without tenant
 * evidence the whole answer is one documentation block, and without
 * documentation sources it is one plain block.
 */
export function splitAnswerBlocks(content: string, input: {
  documentationSources: readonly IntuneChatDocumentationSource[];
  tenantEvidence: boolean;
}): AnswerBlock[] {
  const sources = input.documentationSources;
  if (sources.length === 0 || citedNumbers(content, sources).length === 0 && input.tenantEvidence) {
    return [{ kind: "plain", text: content }];
  }
  // One kind of block needs no label: the step summary already names the source.
  if (!input.tenantEvidence) return [{ kind: "docs", text: content }];
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
  if (blocks.every((block) => block.kind === blocks[0]!.kind)) return [{ kind: blocks[0]!.kind, text: content }];
  return blocks.map((block) => ({
    kind: block.kind,
    label: block.kind === "docs" ? docsLabel(block.citations, sources) : "Your tenant",
    text: block.text,
  }));
}

/** "2026-08-26" as "Aug 26, 2026". */
export function formatIndexVersion(version: string): string {
  const date = new Date(`${version.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? version
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
