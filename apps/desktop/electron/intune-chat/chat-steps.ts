import type {
  GraphCacheResourceKind,
  IntuneChatDocumentationSource,
  IntuneChatInvestigationToolName,
  IntuneChatQuestionKind,
  IntuneChatStep,
  IntuneChatToolTraceEntry,
} from "@openadminos/agent-sdk";

import { definitionForResource, planChatContext } from "./planner.js";
import { normalizeSourceUrl } from "../../src/shared/chat-steps.js";
import { isMcpChatToolName, isTenantTool, mcpChatServerOf, type McpChatContext, type McpChatServer, type McpChatTool } from "./tools.js";
import { isSplashtopReadTool } from "../splashtop/reads.js";
import { MCP_CATALOG } from "../mcp/catalog.js";

export const LEARN_SERVER_ID = "microsoft-learn";
export const ON_DEVICE = "On device";
export const MICROSOFT_GRAPH = "Microsoft Graph";
export const SPLASHTOP_OPEN_API = "Splashtop Open API";

/** "list computers" for splashtop_list_computers. */
function splashtopToolLabel(tool: string): string {
  return tool.replace(/^splashtop_/, "").replace(/_/g, " ");
}

/** A passage from the local docs index, as retrieval returns it. */
export interface DocsIndexPassage {
  file: string;
  title?: string;
  text: string;
  indexVersion?: string;
}

const EXCERPT_CHARS = 320;

/**
 * The start of a passage as plain text, for the popover of a citation
 * chip: Markdown markers, links and code fences removed, whitespace
 * collapsed, cut at a word near 320 characters.
 */
export function sourceExcerpt(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const plain = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_`>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  if (plain.length <= EXCERPT_CHARS) return plain;
  const cut = plain.slice(0, EXCERPT_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${(space > EXCERPT_CHARS * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}...`;
}

/**
 * Records the timeline of one answer. Steps are appended in the order they
 * start and never move, live or stored. Every change hands the full list
 * to the listener.
 */
export class ChatStepRecorder {
  private readonly list: IntuneChatStep[] = [];
  private nextId = 1;

  constructor(private readonly onChange?: (steps: IntuneChatStep[]) => void) {}

  get steps(): IntuneChatStep[] {
    return this.list.map((step) => ({ ...step }));
  }

  start(step: Omit<IntuneChatStep, "id" | "status" | "startedAt">): string {
    const record: IntuneChatStep = { ...step, id: `step-${this.nextId++}`, status: "active", startedAt: new Date().toISOString() };
    this.list.push(record);
    this.emit();
    return record.id;
  }

  update(id: string, patch: Partial<Omit<IntuneChatStep, "id" | "startedAt">>): void {
    const index = this.list.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    this.list[index] = { ...this.list[index]!, ...patch };
    this.emit();
  }

  /** Completes a step and sets its duration unless the patch gives one. */
  finish(id: string, patch: Partial<Omit<IntuneChatStep, "id" | "startedAt">> = {}): void {
    const step = this.list.find((entry) => entry.id === id);
    if (!step) return;
    this.update(id, { status: "completed", durationMs: Math.max(0, Date.now() - Date.parse(step.startedAt)), ...patch });
  }

  /** Ends every step still active, for example after a stop or a failure. */
  settle(status: "completed" | "failed"): void {
    for (const step of this.list) if (step.status === "active") this.finish(step.id, { status });
  }

  private emit(): void {
    this.onChange?.(this.steps);
  }
}

/** The sources chosen for a question, decided before anything runs. */
export interface ChatSourcePlan {
  kind: IntuneChatQuestionKind;
  /** Servers the answer must call before it can finish: named in the question or chosen for it. */
  requiredServerIds: string[];
  /** A server is chosen for the question, so the local docs index is only its fallback. */
  serversFirst: boolean;
  /** The first step's detail: the classification and the chosen sources. */
  detail: string;
}

/**
 * What names a server in a question: its name, its aliases, and its host
 * with and without "www.". A host the server shares with other sites
 * (www.microsoft.com) is no name of its own; there only the server URL
 * with its path names it.
 */
function serverNames(server: McpChatServer): string[] {
  const names = [server.name.toLowerCase(), ...server.aliases];
  if (!server.sharedHost) {
    names.push(server.host, server.host.replace(/^www\./, ""));
  } else if (server.url) {
    const url = new URL(server.url);
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (path) names.push(`${url.hostname}${path}`, `${url.hostname.replace(/^www\./, "")}${path}`);
  }
  return names.filter(Boolean);
}

// A name counts only as a whole: no letter, digit, dot, hyphen or @ may continue it on the left, and no letter, digit, hyphen,
// underscore, @ or dot followed by another label on the right. So "learn.microsoft.com", "admin@kqlsearch.com" and
// "kqlsearch.com.example" do not name a server, and a sentence ending in "kqlsearch.com." does.
function wholeName(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}.@-])${escapeRegExp(name)}(?![\\p{L}\\p{N}_@-]|\\.[\\p{L}\\p{N}])`, "u");
}

/** A topic matches as a word, and also right before digits, so "KB5034441" matches the topic "kb". */
function topicPattern(topic: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(topic)}(?:\\b|(?=\\d))`);
}

/**
 * Every catalog server, installed or not. Their names settle which server
 * a longer name belongs to even when that server is off for this answer.
 */
const CATALOG_SERVERS: readonly McpChatServer[] = MCP_CATALOG.map(mcpChatServerOf);

/** A host such as mcp.windowsforum.com, as opposed to a product name. */
function isHostName(name: string): boolean {
  return /^[^\s/]+\.[^\s/]+$/.test(name);
}

/**
 * A longer name as written in a question: with a possessive after a word
 * ("Splashtop's Agentic Packr"), and a host with the rest of its link, so
 * a path or query such as `?utm_source=splashtop` goes with it.
 */
function longerNamePattern(name: string): RegExp {
  const words = name.split(/\s+/).map(escapeRegExp).join("(?:['\u2019]s)?\\s+");
  // The link ends at whitespace or a delimiter around it: <...>, [..](...), quotes or a comma.
  const rest = isHostName(name) ? "(?:[/?#][^\\s<>()\\[\\]{}\"'`,]*)?" : "";
  return new RegExp(`(?<![\\p{L}\\p{N}.@-])${words}${rest}(?![\\p{L}\\p{N}_@-]|\\.[\\p{L}\\p{N}])`, "gu");
}

/**
 * The question as one server reads it: another server's name that holds
 * one of this server's names or topics, and any link to another server's
 * host with its path and query, are blanked out, so "Splashtop
 * Agentic Packr", "Splashtop's Agentic Packr" and
 * support-splashtopagenticpackr.splashtop.com name that listing and not the
 * one called "Splashtop", whether or not the Agentic Packr listing is
 * installed. A separate mention ("Splashtop Business and Splashtop Agentic
 * Packr") still names both.
 */
function questionFor(server: McpChatServer, lower: string, servers: readonly McpChatServer[]): string {
  const ownNames = serverNames(server);
  const others = new Map(CATALOG_SERVERS.map((other) => [other.id, other]));
  for (const other of servers) others.set(other.id, other);
  others.delete(server.id);
  let text = lower;
  for (const other of others.values()) {
    for (const name of serverNames(other)) {
      // A link to another server's host belongs to that server, query and all.
      const holdsOwnWord = isHostName(name)
        || ownNames.some((word) => word !== name && wholeName(word).test(name))
        || server.topics.some((topic) => topic !== name && topicPattern(topic).test(name));
      if (holdsOwnWord) text = text.replace(longerNamePattern(name), " ");
    }
  }
  return text;
}

/** Servers the question names by name, alias or host. */
export function namedServers(question: string, servers: readonly McpChatServer[]): McpChatServer[] {
  const lower = question.toLowerCase();
  return servers.filter((server) => {
    const text = questionFor(server, lower, servers);
    return serverNames(server).some((name) => wholeName(name).test(text));
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Chooses sources: a server the question names is always required. For a
 * docs or mixed question, servers whose topics match are chosen next. For
 * a docs question with none chosen, Microsoft Learn is chosen when
 * installed; a mixed question may be an ambiguous tenant question, so it
 * never gets a third-party call it did not ask for. The local docs index
 * is used directly only when no server is chosen. Behind a chosen server
 * it is the fallback: it loads when no chosen server answers.
 */
export function planChatSources(input: {
  question: string;
  kind: IntuneChatQuestionKind;
  servers: readonly McpChatServer[];
  docsIndexAvailable: boolean;
  /** Server ids the model declared. They are shown as its intent, never required; unknown ids are ignored. */
  declaredServerIds?: readonly string[];
  /** Replaces the detail's first sentence, which names the kind. */
  lead?: string;
}): ChatSourcePlan {
  const lower = input.question.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  const chosen = new Map(namedServers(input.question, input.servers).map((server) => [server.id, server]));
  if (input.kind !== "tenant") {
    for (const server of input.servers) {
      const text = questionFor(server, lower, input.servers);
      if (server.topics.some((topic) => topicPattern(topic).test(text))) chosen.set(server.id, server);
    }
    const learn = input.servers.find((server) => server.id === LEARN_SERVER_ID);
    if (input.kind === "docs" && chosen.size === 0 && learn) chosen.set(learn.id, learn);
  }
  const names = [...chosen.values()].map((server) => server.name);
  const intended = input.servers.filter((server) => input.declaredServerIds?.includes(server.id) && !chosen.has(server.id)).map((server) => server.name);
  // TODO(ugur): the index waits behind every chosen server, also KQL Search or IntuneAutomation. Should only documentation servers hold it back?
  // It waits for the servers the model declared too, although those are never required calls.
  const waitsFor = [...names, ...intended];
  const serversFirst = waitsFor.length > 0;
  const docs = input.docsIndexAvailable
    ? (serversFirst ? `the local docs index if ${waitsFor.length === 1 ? `${waitsFor[0]} does not answer` : intended.length > 0 ? "no server answers" : "none of them answers"}` : "the local docs index")
    : undefined;
  // With no server chosen, the model's own choice leads the list, so the fallback reads in order.
  const modelLed = names.length === 0 && intended.length > 0 && Boolean(docs) && input.kind !== "tenant";
  const documentation = [...(modelLed ? [`${joinList(intended)}, chosen by the model`] : names), ...(docs && !serversFirst ? [docs] : [])];
  const docsList = joinList(documentation) + (docs && serversFirst ? `, then ${docs}` : "");
  const tenant = "cached tenant data and Microsoft Graph";
  const lead = input.lead ?? (input.kind === "docs" ? "Documentation question." : input.kind === "mixed" ? "Documentation and tenant question." : "Tenant question.");
  const rest = input.kind === "docs"
    ? `${documentation.length > 0 ? `Sources: ${docsList}.` : "No documentation source is available, so the model answers from what it knows."} Your tenant is not checked.`
    : input.kind === "mixed"
      ? `Sources: ${documentation.length > 0 ? `${docsList}${docs && serversFirst ? ", and " : ", "}` : ""}${tenant}.`
      : `Sources: ${tenant}${names.length > 0 ? `, and ${joinList(names)}` : ""}.`;
  const intent = intended.length > 0 && !modelLed ? ` The model also plans to ask ${joinList(intended)}.` : "";
  return { kind: input.kind, requiredServerIds: [...chosen.keys()], serversFirst, detail: `${lead} ${rest}${intent}` };
}

/**
 * How the kind was decided: by the model, by the model with the keyword
 * veto, by keyword rules after the model gave no kind, or by keyword
 * rules alone on a path where the model does not classify.
 */
export type QuestionKindReason = "model" | "veto" | "fallback" | "keywords";

/**
 * The kind of one answer and the first step that shows it. The kind is
 * decided once, then can only be upgraded from docs to mixed, never
 * downgraded. Until it is decided, `sources` is the keyword plan.
 */
export class QuestionKindTracker {
  private decided = false;
  /** The first step finished before the model classifies; the classification then shows on the model step. */
  private planShown = false;
  private readonly keywordVetoed: boolean;

  /**
   * `veto` says why a docs label is not allowed, for example "the question
   * mentions your tenant". A keyword docs kind with a veto starts as mixed.
   */
  constructor(
    private readonly steps: ChatStepRecorder,
    private readonly planStepId: string,
    private readonly input: { question: string; servers: readonly McpChatServer[]; docsIndexAvailable: boolean; veto?: string },
    private plan: ChatSourcePlan,
  ) {
    this.keywordVetoed = plan.kind === "docs" && Boolean(input.veto);
    if (this.keywordVetoed) this.plan = { ...plan, kind: "mixed" };
  }

  get sources(): ChatSourcePlan {
    return this.plan;
  }

  /**
   * Finishes the first step once the local plan is ready, when the model
   * classifies the question next. Its time is local planning only.
   */
  awaitModel(): void {
    if (this.planShown || this.decided) return;
    this.planShown = true;
    const { servers, docsIndexAvailable } = this.input;
    const sources = [...servers.map((server) => server.name), ...(docsIndexAvailable ? ["the local docs index"] : [])];
    this.steps.finish(this.planStepId, {
      title: "Read the question",
      detail: `${sources.length > 0 ? `Sources available: ${joinList(sources)}.` : "No documentation source is installed."} The model classifies the question.`,
    });
  }

  /**
   * Decides the kind once. Before the model classifies, the first step
   * shows it with its sources. A model classification is returned in the
   * plan's detail for the model step that made it, for example
   * "Classified as a docs question. Sources: Microsoft Learn. Your tenant
   * is not checked."
   */
  resolve(kind: IntuneChatQuestionKind, reason: QuestionKindReason, declaredServerIds: readonly string[] = []): ChatSourcePlan {
    if (this.decided) return this.plan;
    this.decided = true;
    const { veto, ...context } = this.input;
    const phrase = kind === "docs" ? "a docs question" : kind === "tenant" ? "a tenant question" : "a docs and tenant question";
    const lead = reason === "veto"
      ? `Treated as docs and tenant: ${veto ?? "the question mentions your tenant"}.`
      : reason === "model" ? `Classified as ${phrase}.`
        : reason === "fallback" ? `The model gave no question kind, so keyword rules decided: ${phrase}.`
          : this.planShown ? `Keyword rules decided: ${phrase}.` : undefined;
    this.plan = planChatSources({ ...context, kind, declaredServerIds, ...(lead ? { lead } : {}) });
    if (!this.planShown) this.steps.finish(this.planStepId, { title: "Read the question", detail: this.plan.detail });
    else if (reason === "keywords") this.steps.update(this.planStepId, { detail: this.plan.detail });
    return this.plan;
  }

  /** Decides the keyword kind when nothing else did, for example after a fallback. */
  settle(): void {
    this.resolve(this.plan.kind, this.keywordVetoed ? "veto" : "keywords");
  }

  /** A docs answer asked for tenant data: it becomes mixed, shown as its own step. */
  upgrade(): ChatSourcePlan {
    if (this.plan.kind !== "docs") return this.plan;
    this.plan = { ...this.plan, kind: "mixed" };
    this.steps.finish(this.steps.start({ kind: "plan", title: "Treating it as docs and tenant", origin: "device", originLabel: ON_DEVICE }), {
      title: "Treated as docs and tenant",
      detail: "The model asked for tenant data, so the answer now needs tenant evidence.",
    });
    return this.plan;
  }
}

function joinList(items: readonly string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Numbers documentation sources in the order they reach the model, so [n] always maps to one card. */
export class CitationRegistry {
  private readonly list: IntuneChatDocumentationSource[] = [];

  get sources(): IntuneChatDocumentationSource[] {
    return this.list.map((source) => ({ ...source }));
  }

  addPassages(passages: readonly DocsIndexPassage[]): number[] {
    return passages.map((passage) => {
      const excerpt = sourceExcerpt(passage.text);
      return this.push({
        kind: "docs-index",
        title: passage.title?.trim() || passage.file,
        file: passage.file,
        ...(passage.indexVersion ? { indexVersion: passage.indexVersion } : {}),
        ...(excerpt ? { excerpt } : {}),
      });
    });
  }

  addMcpResults(results: ReadonlyArray<{ title: string; url?: string; excerpt?: string }>, tool: Pick<McpChatTool, "serverName" | "host">): Array<{ cite: string; title: string; url?: string }> {
    const items = results.length > 0 ? results : [{ title: `${tool.serverName} result` }];
    return items.map((item: { title: string; url?: string; excerpt?: string }) => {
      // Chunks of one article (other fragment, locale segment or trailing slash) share its number.
      const existing = item.url ? this.list.find((source) => source.url && normalizeSourceUrl(source.url) === normalizeSourceUrl(item.url!)) : undefined;
      const excerpt = sourceExcerpt(item.excerpt);
      const citation = existing?.citation ?? this.push({
        kind: "mcp",
        title: item.title,
        ...(item.url ? { url: item.url } : {}),
        serverName: tool.serverName,
        host: tool.host,
        ...(excerpt ? { excerpt } : {}),
      });
      return { cite: `[${citation}]`, title: item.title, ...(item.url ? { url: item.url } : {}) };
    });
  }

  private push(source: Omit<IntuneChatDocumentationSource, "citation">): number {
    const citation = this.list.length + 1;
    this.list.push({ ...source, citation });
    return citation;
  }
}

/** The exact values an MCP call sends, as one line. */
export function mcpSentText(params: unknown): string {
  const entries = params && typeof params === "object" && !Array.isArray(params) ? Object.entries(params as Record<string, unknown>) : [];
  const text = (value: unknown) => (Array.isArray(value) ? value.map(String).join(", ") : String(value));
  if (entries.length === 1) return text(entries[0]![1]);
  return entries.map(([key, value]) => `${key}: ${text(value)}`).join(" · ");
}

const TOOL_STEP: Record<string, { active: string; done: string; failed: string; origin: "device" | "graph" }> = {
  list_cached_resources: { active: "Checking the cache inventory", done: "Checked the cache inventory", failed: "Could not read the cache inventory", origin: "device" },
  query_cache: { active: "Querying cached data", done: "Queried cached data", failed: "Cache query failed", origin: "device" },
  find_graph_endpoint: { active: "Looking up Graph endpoints", done: "Looked up Graph endpoints", failed: "Endpoint lookup failed", origin: "device" },
  graph_get: { active: "Reading Microsoft Graph", done: "Read Microsoft Graph", failed: "Graph read failed", origin: "graph" },
  refresh_resource: { active: "Refreshing tenant data", done: "Refreshed tenant data", failed: "Refresh failed", origin: "graph" },
  query_drift: { active: "Reading local change history", done: "Read local change history", failed: "Change history query failed", origin: "device" },
};

function resourceLabel(params: unknown): string | undefined {
  const resource = params && typeof params === "object" ? (params as Record<string, unknown>).resource : undefined;
  if (typeof resource !== "string") return undefined;
  try {
    return definitionForResource(resource as GraphCacheResourceKind).label;
  } catch {
    return resource;
  }
}

/**
 * The step for a tool call that just started. An MCP step shows no sent
 * text until the query writer's params passed every check (see
 * toolStepSending), because nothing has been sent before that.
 */
export function toolStepStart(
  tool: IntuneChatInvestigationToolName,
  params: unknown,
  mcp: McpChatTool | undefined,
  modelLabel: string,
): Omit<IntuneChatStep, "id" | "status" | "startedAt"> {
  if (isMcpChatToolName(tool)) {
    return {
      kind: "mcp",
      title: `Asking ${mcp?.serverName ?? "an MCP server"}`,
      detail: `${mcp?.tool ?? tool} · writing the query from your question`,
      origin: "third-party",
      originLabel: mcp?.host ?? "third-party host",
    };
  }
  if (tool === "web_search") return { kind: "tool", title: "Searching the web", origin: "model", originLabel: modelLabel };
  if (isSplashtopReadTool(tool)) {
    return { kind: "tool", title: "Reading Splashtop", detail: splashtopToolLabel(tool), origin: "graph", originLabel: SPLASHTOP_OPEN_API };
  }
  const copy = TOOL_STEP[tool]!;
  const label = resourceLabel(params);
  const path = tool === "graph_get" && params && typeof params === "object" ? (params as Record<string, unknown>).path : undefined;
  return {
    kind: "tool",
    title: copy.active,
    ...(label ? { detail: label } : typeof path === "string" ? { detail: path } : {}),
    origin: copy.origin,
    originLabel: copy.origin === "graph" ? MICROSOFT_GRAPH : ON_DEVICE,
  };
}

/** The query writer's params passed every check and are being sent: the MCP step shows them exactly. */
export function toolStepSending(tool: IntuneChatInvestigationToolName, params: Record<string, unknown>, mcp: McpChatTool | undefined): Partial<IntuneChatStep> {
  return { detail: mcp?.tool ?? tool, sent: mcpSentText(params) };
}

/**
 * How a finished tool call changes its step. MCP calls that sent nothing
 * show no sent text. `readsItem` marks a tool that reads one result by its
 * id (get_article): its step names the item, since the sent text is only
 * the id.
 */
export function toolStepFinish(entry: IntuneChatToolTraceEntry, readsItem = false): Partial<IntuneChatStep> {
  const durationMs = entry.durationMs;
  if (entry.mcpSource) {
    const { serverName, host, tool, blocked, results } = entry.mcpSource;
    if (blocked) {
      return { status: "blocked", title: `Blocked a ${serverName} query`, detail: `${entry.error ?? "The query held tenant data."}`, sent: undefined, durationMs };
    }
    // A call that stopped before sending (bad params, the query writer, the cache index, a server turned off) sent nothing.
    if (entry.error && !entry.mcpSource.sentToHost) return { status: "failed", title: `Did not send a ${serverName} query`, detail: `${tool} · ${entry.error}`, sent: undefined, durationMs };
    if (entry.error && entry.mcpSource.toolError) return { status: "failed", title: `${serverName} returned an error`, detail: `${tool} · ${entry.error}`, durationMs };
    if (entry.error) return { status: "failed", title: `Could not reach ${serverName}`, detail: `${tool} · ${entry.error}`, durationMs };
    if (entry.mcpSource.empty) return { status: "completed", title: `${serverName} found nothing`, detail: `${tool} · no results for this query`, durationMs };
    const count = results?.length ?? 0;
    // A list OpenAdminOS shortened, or one the server says continues, never reads as complete.
    const matched = entry.mcpSource.matched;
    const shown = matched !== undefined && matched > count ? `${count} of ${matched} results` : `${count} ${count === 1 ? "result" : "results"}`;
    const more = entry.mcpSource.more ? " · the server has more" : "";
    const item = readsItem && count === 1 ? results?.[0]?.title?.trim() : undefined;
    return { status: "completed", title: `Asked ${serverName}`, detail: `${tool} · ${item || (count > 0 ? shown : `answer from ${host}`)}${more}`, durationMs };
  }
  if (entry.tool === "web_search") return entry.error ? { status: "failed", title: "Web search failed", detail: entry.error, durationMs } : { status: "completed", title: "Searched the web", detail: entry.resultSummary, durationMs };
  if (isSplashtopReadTool(entry.tool)) {
    const what = splashtopToolLabel(entry.tool);
    return entry.error
      ? { status: "failed", title: "Splashtop read failed", detail: `${what} · ${entry.error}`, durationMs }
      : { status: "completed", title: "Read Splashtop", detail: `${what} · ${entry.resultSummary}`, durationMs };
  }
  const copy = TOOL_STEP[entry.tool];
  const label = resourceLabel(entry.params);
  if (entry.error) return { status: "failed", title: copy?.failed ?? "Tool failed", detail: entry.error, durationMs };
  return { status: "completed", title: copy?.done ?? "Ran a tool", detail: label ? `${label} · ${entry.resultSummary}` : entry.resultSummary, durationMs };
}

/** Records a step for each tool call the loop makes, one at a time. */
export function toolStepHooks(steps: ChatStepRecorder, mcp: McpChatContext | undefined, modelLabel: string) {
  let current: string | undefined;
  return {
    start(tool: IntuneChatInvestigationToolName, params: unknown): void {
      current = steps.start(toolStepStart(tool, params, mcp?.tools.find((entry) => entry.name === tool), modelLabel));
    },
    sending(tool: IntuneChatInvestigationToolName, params: Record<string, unknown>): void {
      if (current) steps.update(current, toolStepSending(tool, params, mcp?.tools.find((entry) => entry.name === tool)));
    },
    finish(entry: IntuneChatToolTraceEntry): void {
      if (current) steps.finish(current, toolStepFinish(entry, Boolean(mcp?.tools.find((tool) => tool.name === entry.tool)?.itemIds?.params?.length)));
      current = undefined;
    },
  };
}

/** What a model call in the tool loop decided. */
export type ModelStepOutcome =
  | { kind: "tool"; tool: IntuneChatInvestigationToolName; params: unknown }
  | { kind: "final"; passages: number; trace: readonly IntuneChatToolTraceEntry[] }
  | { kind: "repair"; reason: "malformed" | "kind" | "sources" | "evidence" | "unfinished" | "lookup" | "empty" | "documentation" | "excerpts" };

export interface ModelStepHooks {
  start(): void;
  /** The streamed reply is recognizably a final answer. */
  writing(): void;
  finish(outcome: ModelStepOutcome, classification?: string): void;
}

const DECISION: Record<string, string> = {
  list_cached_resources: "Chose to check the cache inventory",
  find_graph_endpoint: "Chose to look up Graph endpoints",
  graph_get: "Chose to read Microsoft Graph",
  refresh_resource: "Chose to refresh tenant data",
  query_drift: "Chose to read local change history",
  web_search: "Chose to search the web",
};

const REPAIR: Record<Extract<ModelStepOutcome, { kind: "repair" }>["reason"], string> = {
  malformed: "Reply was not valid tool JSON",
  kind: "Reply gave no question kind",
  sources: "Answered before asking the chosen source",
  evidence: "Answered without checking tenant data",
  unfinished: "Reply was progress, not an answer",
  lookup: "Answered on a failed lookup",
  empty: "Reply was an empty answer",
  documentation: "Answered before the local docs passages arrived",
  excerpts: "Answered from search excerpts",
};

/** A resource label inside a sentence: product names keep their capital, other labels read as plain words. */
function midSentenceLabel(label: string): string {
  return /^(?:Intune|Entra|Microsoft|Windows|Defender|Autopilot|Apple|Android|Conditional|Secure Score)\b/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/** The plain decision of a tool call, such as "Chose to ask Microsoft Learn" or "Chose to query cached managed devices". */
export function toolDecision(tool: IntuneChatInvestigationToolName, params: unknown, mcp: McpChatTool | undefined): string {
  if (isMcpChatToolName(tool)) return `Chose to ask ${mcp?.serverName ?? "an MCP server"}`;
  if (isSplashtopReadTool(tool)) return `Chose to read Splashtop ${splashtopToolLabel(tool)}`;
  if (tool === "query_cache") {
    const label = resourceLabel(params);
    if (!label) return "Chose to query cached data";
    return `Chose to query cached ${midSentenceLabel(label)}`;
  }
  return DECISION[tool] ?? "Chose a tool";
}

function answerInputs(passages: number, trace: readonly IntuneChatToolTraceEntry[], tenantContext?: boolean): string {
  const parts = ["question"];
  if (passages > 0) parts.push(`${passages} doc ${passages === 1 ? "passage" : "passages"}`);
  const servers = [...new Set(trace.filter((entry) => entry.mcpSource && !entry.error).map((entry) => entry.mcpSource!.serverName))];
  if (servers.length > 0) parts.push(`${joinList(servers)} results`);
  const tenant = trace.filter((entry) => isTenantTool(entry.tool) && !entry.error).length;
  if (tenant > 0) parts.push(`${tenant} tenant ${tenant === 1 ? "result" : "results"}`);
  else if (tenantContext) parts.push("cached tenant data");
  return joinList(parts);
}

/**
 * One step per model call of the tool loop, appended when the call
 * starts: "Working" with the provider and model, finished with what the
 * reply decided ("Chose to ask Microsoft Learn", "Wrote the answer"). Its
 * duration is the call alone.
 */
export function modelStepHooks(steps: ChatStepRecorder, model: AnswerModel, mcp: McpChatContext | undefined): ModelStepHooks {
  const name = model.name ?? model.providerName;
  let current: { id: string; startedAt: number } | undefined;
  return {
    start() {
      current = { id: steps.start({ kind: "answer", title: "Working", detail: name, origin: model.hosted ? "model" : "device", originLabel: modelOriginLabel(model) }), startedAt: Date.now() };
    },
    writing() {
      if (current) steps.update(current.id, { title: "Writing the answer" });
    },
    finish(outcome, classification) {
      if (!current) return;
      const title = outcome.kind === "final" ? "Wrote the answer"
        : outcome.kind === "tool" ? toolDecision(outcome.tool, outcome.params, mcp?.tools.find((tool) => tool.name === outcome.tool))
          : REPAIR[outcome.reason];
      const detail = outcome.kind === "final" ? `${name} · ${answerInputs(outcome.passages, outcome.trace)}`
        : outcome.kind === "repair" ? `${name} · ${outcome.reason === "excerpts" ? "asked the model to read the best match first" : "asked the model to try again"}` : name;
      steps.finish(current.id, { title, detail: classification ? `${detail} · ${classification}` : detail, durationMs: Math.max(0, Date.now() - current.startedAt) });
      current = undefined;
    },
  };
}

/** Where the model runs: on this device, or at the hosted provider. */
export interface AnswerModel {
  name?: string;
  hosted: boolean;
  providerName: string;
}

export function modelOriginLabel(model: AnswerModel): string {
  return model.hosted ? model.providerName : ON_DEVICE;
}

/**
 * Starts the model step of an answer written in one call, outside the tool
 * loop. The returned function finishes it; `writing` retitles it once
 * answer text arrives.
 */
export function startAnswerStep(steps: ChatStepRecorder, model: AnswerModel) {
  const startedAt = Date.now();
  const name = model.name ?? model.providerName;
  const id = steps.start({ kind: "answer", title: "Working", detail: name, origin: model.hosted ? "model" : "device", originLabel: modelOriginLabel(model) });
  let writing = false;
  const finish = (result: { passages: number; trace?: readonly IntuneChatToolTraceEntry[]; tenantContext?: boolean; failed?: boolean }): void => {
    steps.finish(id, {
      status: result.failed ? "failed" : "completed",
      title: result.failed ? "Could not write the answer" : "Wrote the answer",
      detail: `${name} · ${answerInputs(result.passages, result.trace ?? [], result.tenantContext)}`,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  };
  /** The first answer text arrived. */
  const startWriting = () => {
    if (writing) return;
    writing = true;
    steps.update(id, { title: "Writing the answer" });
  };
  return Object.assign(finish, { writing: startWriting });
}

/** "2026-08-26" as "Aug 26, 2026". */
export function formatIndexVersion(version: string): string {
  const date = new Date(`${version.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? version
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const LINK = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|cloud|ms)\b/i;

/** An offer to the admin at the start of a follow-up, such as "Would you like me to". */
const OFFER = /^(?:would you like(?: me)? to|do you want(?: me)? to|want me to|should i|shall i|can i|could i|may i|i can|let me)\s+/i;

/**
 * A follow-up in the admin's voice, as something they would type: an
 * offer such as "Would you like to check this tenant's macOS onboarding
 * status?" becomes "Check our macOS onboarding status". Text that still
 * speaks to the admin is dropped.
 */
export function inAdminVoice(text: string): string | undefined {
  let out = text;
  if (OFFER.test(out)) {
    out = out.replace(OFFER, "").replace(/\?+$/, "").trim();
    out = out.replace(/\b(?:this|the|your) tenant(?:'|\u2019)s\b/gi, "our").replace(/\byour\b/gi, "our");
    out = out.charAt(0).toUpperCase() + out.slice(1);
  }
  if (!out || /\b(?:you|your|yours)\b/i.test(out)) return undefined;
  return out;
}

const OVERLAP_STOPWORDS = new Set([
  "a", "an", "and", "are", "check", "do", "does", "find", "for", "how", "i", "in", "is", "list", "me", "of", "on", "or", "our",
  "see", "show", "status", "tenant", "tenants", "the", "this", "to", "we", "what", "which", "with",
]);

function overlapTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/(?:'|\u2019)s\b/g, "").split(/[^a-z0-9]+/).filter((token) => token && !/^\d+$/.test(token) && !OVERLAP_STOPWORDS.has(token)));
}

/** Whether two follow-ups ask for the same thing: at least half the words of the shorter one are in the other. */
export function nearDuplicateFollowUp(a: string, b: string): boolean {
  const left = overlapTokens(a);
  const right = overlapTokens(b);
  const smaller = Math.min(left.size, right.size);
  if (smaller === 0) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return [...left].filter((token) => right.has(token)).length / smaller >= 0.5;
}

/**
 * Follow-ups the model returned in `next`: at most two, trimmed, at most
 * 120 characters, only read-only questions in the admin's voice, no
 * links, and nothing the caller's tenant data check rejects.
 */
export function validFollowUps(value: unknown, holdsTenantData: (text: string) => boolean = () => false, limit = 2): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = inAdminVoice(item.replace(/\s+/g, " ").trim());
    if (!text || text.length > 120 || LINK.test(text) || planChatContext(text).hasWriteIntent || holdsTenantData(text)) continue;
    if (!out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
    if (out.length === limit) break;
  }
  return out;
}

const TITLE_CHARS = 60;

/**
 * The chat title the model returned in `title`, checked like `next`:
 * plain text on one line, at most 60 characters, no links, no write
 * intent and nothing the caller's tenant data check rejects. Surrounding
 * quotes and a closing period are dropped. Anything else gives no title,
 * and the chat keeps the trimmed question.
 */
export function validTitle(value: unknown, holdsTenantData: (text: string) => boolean = () => false): string | undefined {
  if (typeof value !== "string" || /[\r\n]/.test(value.trim())) return undefined;
  const text = value.replace(/\s+/g, " ").trim().replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "").replace(/\.$/, "").trim();
  if (!text || text.length > TITLE_CHARS) return undefined;
  if (/[`*#<>\[\]{}|\\]/.test(text) || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  if (LINK.test(text) || planChatContext(text).hasWriteIntent || holdsTenantData(text)) return undefined;
  return text;
}

const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/\bmac\s?os\b|\bmacs?\b/i, "macOS"],
  [/\bipados\b/i, "iPadOS"],
  [/\bios\b|\biphones?\b/i, "iOS"],
  [/\bandroid\b/i, "Android"],
  [/\blinux\b/i, "Linux"],
  [/\bwindows\b/i, "Windows"],
];

/** Topics the cached Intune device records answer: compliance state and encryption. */
const DEVICE_RECORD_TOPICS = new Set(["compliance", "encryption", "BitLocker", "FileVault"]);

const TOPICS = [
  "Defender", "BitLocker", "FileVault", "LAPS", "Autopilot", "Windows Hello", "Conditional Access", "Platform SSO",
  "Company Portal", "Windows Update", "app protection", "compliance", "encryption",
];

/**
 * The deterministic follow-up for a docs question with a tenant tie-in:
 * the planner mapped it to tenant resources, so checking the tenant is
 * offered as the next question instead of being done silently. Counts
 * come from the local cache only.
 */
export function tenantTieInFollowUp(input: {
  question: string;
  kind: IntuneChatQuestionKind;
  tieInResources: readonly GraphCacheResourceKind[];
  deviceCountsByOs?: Record<string, number>;
}): string | undefined {
  if (input.kind !== "docs" || input.tieInResources.length === 0) return undefined;
  const topic = TOPICS.find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(input.question));
  const platform = PLATFORMS.find(([pattern]) => pattern.test(input.question))?.[1];
  if (platform && input.tieInResources.includes("managedDevices")) return deviceFollowUp(platform, topic, input.deviceCountsByOs);
  // The planner lists the most relevant resource first.
  // TODO(ugur): this generic wording is used for every non-device tie-in, such as a KQL
  // question about sign-ins. Confirm it, or name per-resource follow-ups.
  const label = midSentenceLabel(definitionForResource(input.tieInResources[0]!).label);
  return topic ? `Check ${topic} in our ${label}` : `Check how this applies to our ${label}`;
}

/**
 * The device follow-up for a platform the question names, built from the
 * template, the platform name and the cached count only. No device of
 * that platform in the cache gives none.
 */
function deviceFollowUp(platform: string, topic: string | undefined, counts: Record<string, number> | undefined): string | undefined {
  const count = counts
    ? Object.entries(counts).filter(([os]) => os.toLowerCase() === platform.toLowerCase() || (platform === "Windows" && /^windows/i.test(os))).reduce((sum, [, value]) => sum + value, 0)
    : undefined;
  if (count === 0) return undefined;
  const devices = count === undefined ? `${platform} devices` : `${count} ${platform} ${count === 1 ? "device" : "devices"}`;
  // Only what the device records hold. Defender status, for one, is not in them, so a
  // "Check for Defender" follow-up led to an answer that could not tell.
  if (topic && DEVICE_RECORD_TOPICS.has(topic)) return `Check our ${devices} for ${topic} in Intune`;
  return `Show compliance and last sync for our ${devices}`;
}

/**
 * The follow-up after an answer that read tenant data. The model wrote
 * its `next` after reading tenant rows, so text from a field no index
 * knows (a street address, a description) could reach a suggestion the
 * admin then sends as the next question. Such an answer offers only this
 * one, built by code: the device template for a platform the question
 * names, with the cached count, and only when it asks for something the
 * question did not.
 */
export function tenantAnswerFollowUp(input: {
  question: string;
  resources: readonly GraphCacheResourceKind[];
  deviceCountsByOs?: Record<string, number>;
}): string | undefined {
  // TODO(ugur): tenant answers on other resources now offer no follow-up. Confirm, or name per-resource templates.
  const platform = PLATFORMS.find(([pattern]) => pattern.test(input.question))?.[1];
  if (!platform || !input.resources.includes("managedDevices")) return undefined;
  const topic = TOPICS.find((candidate) => new RegExp(`\\b${candidate}\\b`, "i").test(input.question));
  const text = deviceFollowUp(platform, topic, input.deviceCountsByOs);
  return text && !nearDuplicateFollowUp(text, input.question) ? text : undefined;
}

/** Deterministic follow-ups first, then the model's that ask for something else, at most two in all. */
export function mergeFollowUps(...lists: ReadonlyArray<ReadonlyArray<string | undefined>>): string[] {
  const kept: string[] = [];
  for (const text of validFollowUps(lists.flat().filter((item): item is string => Boolean(item)), undefined, Number.POSITIVE_INFINITY)) {
    if (!kept.some((existing) => nearDuplicateFollowUp(existing, text))) kept.push(text);
  }
  return kept.slice(0, 2);
}

/** Whether a Microsoft Learn call answered: a failed or blocked call, or one with no results, does not count. */
export function learnAnswered(trace: readonly IntuneChatToolTraceEntry[]): boolean {
  return trace.some((entry) => entry.mcpSource?.serverId === LEARN_SERVER_ID && !entry.error && !entry.mcpSource.blocked && (entry.mcpSource.results?.length ?? 0) > 0);
}

/**
 * The answer may only attribute text to Microsoft Learn when a Learn call
 * answered. Otherwise the passages came from the local index or the
 * model, so attribution phrases ("Microsoft Learn says", "according to
 * Microsoft Learn") name the Microsoft documentation instead. Other
 * mentions, such as "Microsoft Learn is not installed", and code are left
 * as they are.
 */
const LEARN_ATTRIBUTION =
  /\b(according to\s+)(?:the\s+)?Microsoft Learn\b|\b(?:the\s+)?Microsoft Learn(?=\s+(?:says|said|states|documents|recommends|notes|explains|describes|lists|shows|confirms)\b)/gi;

export function relabelUnverifiedLearn(answer: string, learnCalled: boolean): string {
  if (learnCalled) return answer;
  // Odd parts are fenced or inline code.
  return answer.split(/(```[\s\S]*?```|`[^`\n]*`)/).map((part, index) => index % 2 === 1 ? part : part.replace(
    LEARN_ATTRIBUTION,
    (_match, according: string | undefined, offset: number, whole: string) => {
      if (according) return `${according}the Microsoft documentation`;
      return /(?:^|[.!?]\s+|\n\s*)$/.test(whole.slice(0, offset)) ? "The Microsoft documentation" : "the Microsoft documentation";
    },
  )).join("");
}
