import type {
  GraphCacheResourceKind,
  IntuneChatDocumentationSource,
  IntuneChatInvestigationToolName,
  IntuneChatQuestionKind,
  IntuneChatStep,
  IntuneChatToolTraceEntry,
} from "@openadminos/agent-sdk";

import { definitionForResource, planChatContext } from "./planner.js";
import { isMcpChatToolName, isTenantTool, type McpChatContext, type McpChatServer, type McpChatTool } from "./tools.js";

export const LEARN_SERVER_ID = "microsoft-learn";
export const ON_DEVICE = "On device";
export const MICROSOFT_GRAPH = "Microsoft Graph";

/** A passage from the local docs index, as retrieval returns it. */
export interface DocsIndexPassage {
  file: string;
  title?: string;
  text: string;
  indexVersion?: string;
}

/**
 * Records the timeline of one answer. Every change hands the full list to
 * the listener, so a live view never has to order steps itself. While the
 * model step is active it stays last and new steps go in before it.
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
    const answer = this.list.findIndex((entry) => entry.kind === "answer" && entry.status === "active");
    if (answer >= 0 && step.kind !== "answer") this.list.splice(answer, 0, record);
    else this.list.push(record);
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
  /** Microsoft Learn is chosen, so the local docs index is only a fallback. */
  learnFirst: boolean;
  /** The first step's detail: the classification and the chosen sources. */
  detail: string;
}

/** Servers the question names by name, alias or host. */
export function namedServers(question: string, servers: readonly McpChatServer[]): McpChatServer[] {
  const lower = question.toLowerCase();
  return servers.filter((server) =>
    [server.name.toLowerCase(), server.host, server.host.replace(/^www\./, ""), ...server.aliases].some((name) => name && lower.includes(name)),
  );
}

/**
 * Chooses sources: a server the question names, or the model said it
 * would use, is always required. For a
 * docs or mixed question, servers whose topics match are chosen next. For
 * a docs question with none chosen, Microsoft Learn is chosen when
 * installed; a mixed question may be an ambiguous tenant question, so it
 * never gets a third-party call it did not ask for. The local docs index
 * is used directly unless Learn is chosen, and is Learn's fallback.
 */
export function planChatSources(input: {
  question: string;
  kind: IntuneChatQuestionKind;
  servers: readonly McpChatServer[];
  docsIndexAvailable: boolean;
  /** Server ids the model declared; unknown ids are ignored. */
  declaredServerIds?: readonly string[];
  /** Replaces the detail's first sentence, which names the kind. */
  lead?: string;
}): ChatSourcePlan {
  const lower = input.question.toLowerCase();
  const chosen = new Map(namedServers(input.question, input.servers).map((server) => [server.id, server]));
  // TODO(ugur): a server the model declares becomes required, so the timeline's sources are the ones that
  // run. Confirm, or show declared sources without enforcing them.
  for (const server of input.servers) if (input.declaredServerIds?.includes(server.id)) chosen.set(server.id, server);
  if (input.kind !== "tenant") {
    for (const server of input.servers) {
      if (server.topics.some((topic) => new RegExp(`\\b${topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower))) chosen.set(server.id, server);
    }
    const learn = input.servers.find((server) => server.id === LEARN_SERVER_ID);
    if (input.kind === "docs" && chosen.size === 0 && learn) chosen.set(learn.id, learn);
  }
  const learnFirst = chosen.has(LEARN_SERVER_ID);
  const names = [...chosen.values()].map((server) => server.name);
  const docs = input.docsIndexAvailable ? (learnFirst ? "the local docs index if Microsoft Learn is unavailable" : "the local docs index") : undefined;
  const documentation = [...names, ...(docs && !learnFirst ? [docs] : [])];
  const docsList = joinList(documentation) + (docs && learnFirst ? `, then ${docs}` : "");
  const tenant = "cached tenant data and Microsoft Graph";
  const lead = input.lead ?? (input.kind === "docs" ? "Documentation question." : input.kind === "mixed" ? "Documentation and tenant question." : "Tenant question.");
  const rest = input.kind === "docs"
    ? `${documentation.length > 0 ? `Sources: ${docsList}.` : "No documentation source is available, so the model answers from what it knows."} Your tenant is not checked.`
    : input.kind === "mixed"
      ? `Sources: ${documentation.length > 0 ? `${docsList}, and ` : ""}${tenant}.`
      : `Sources: ${tenant}${names.length > 0 ? `, and ${joinList(names)}` : ""}.`;
  return { kind: input.kind, requiredServerIds: [...chosen.keys()], learnFirst, detail: `${lead} ${rest}` };
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

  /** Decides the kind once and finishes the first step with it and its sources. */
  resolve(kind: IntuneChatQuestionKind, reason: QuestionKindReason, declaredServerIds: readonly string[] = []): ChatSourcePlan {
    if (this.decided) return this.plan;
    this.decided = true;
    const { veto, ...context } = this.input;
    this.plan = planChatSources({
      ...context,
      kind,
      declaredServerIds,
      ...(reason === "veto" ? { lead: `Treated as docs and tenant: ${veto ?? "the question mentions your tenant"}.` } : {}),
    });
    const detail = reason === "fallback" ? `${this.plan.detail} The model gave no question kind, so keyword rules decided.` : this.plan.detail;
    this.steps.finish(this.planStepId, { title: "Read the question", detail });
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
    return passages.map((passage) => this.push({
      kind: "docs-index",
      title: passage.title?.trim() || passage.file,
      file: passage.file,
      ...(passage.indexVersion ? { indexVersion: passage.indexVersion } : {}),
    }));
  }

  addMcpResults(results: ReadonlyArray<{ title: string; url?: string }>, tool: Pick<McpChatTool, "serverName" | "host">): Array<{ cite: string; title: string; url?: string }> {
    const items = results.length > 0 ? results : [{ title: `${tool.serverName} result` }];
    return items.map((item) => {
      const existing = item.url ? this.list.find((source) => source.url === item.url) : undefined;
      const citation = existing?.citation ?? this.push({
        kind: "mcp",
        title: item.title,
        ...(item.url ? { url: item.url } : {}),
        serverName: tool.serverName,
        host: tool.host,
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

/** The step for a tool call that just started. */
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
      detail: mcp?.tool ?? tool,
      origin: "third-party",
      originLabel: mcp?.host ?? "third-party host",
      sent: mcpSentText(params),
    };
  }
  if (tool === "web_search") return { kind: "tool", title: "Searching the web", origin: "model", originLabel: modelLabel };
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

/** How a finished tool call changes its step. Blocked MCP calls sent nothing, so they show no sent text. */
export function toolStepFinish(entry: IntuneChatToolTraceEntry): Partial<IntuneChatStep> {
  const durationMs = entry.durationMs;
  if (entry.mcpSource) {
    const { serverName, host, tool, blocked, results } = entry.mcpSource;
    if (blocked) {
      return { status: "blocked", title: `Blocked a ${serverName} query`, detail: `${entry.error ?? "The query held tenant data."}`, sent: undefined, durationMs };
    }
    // A call that failed before sending (bad params, seed failure) sent nothing.
    if (entry.error) return { status: "failed", title: `Could not reach ${serverName}`, detail: `${tool} · ${entry.error}`, durationMs, ...(entry.mcpSource.sentToHost ? {} : { sent: undefined }) };
    const count = results?.length ?? 0;
    return { status: "completed", title: `Asked ${serverName}`, detail: `${tool} · ${count > 0 ? `${count} ${count === 1 ? "result" : "results"}` : `answer from ${host}`}`, durationMs };
  }
  if (entry.tool === "web_search") return entry.error ? { status: "failed", title: "Web search failed", detail: entry.error, durationMs } : { status: "completed", title: "Searched the web", detail: entry.resultSummary, durationMs };
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
    finish(entry: IntuneChatToolTraceEntry): void {
      if (current) steps.finish(current, toolStepFinish(entry));
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
 * Starts the model step, which stays last while it runs. The returned
 * function finishes it; its duration leaves out the time tools took.
 */
export function startAnswerStep(steps: ChatStepRecorder, model: AnswerModel) {
  const startedAt = Date.now();
  const name = model.name ?? model.providerName;
  const id = steps.start({ kind: "answer", title: "Working on the answer", detail: name, origin: model.hosted ? "model" : "device", originLabel: modelOriginLabel(model) });
  return (result: { passages: number; trace?: readonly IntuneChatToolTraceEntry[]; tenantContext?: boolean; failed?: boolean }): void => {
    const trace = result.trace ?? [];
    const toolMs = trace.reduce((sum, entry) => sum + entry.durationMs, 0);
    const parts = ["question"];
    if (result.passages > 0) parts.push(`${result.passages} doc ${result.passages === 1 ? "passage" : "passages"}`);
    const servers = [...new Set(trace.filter((entry) => entry.mcpSource && !entry.error).map((entry) => entry.mcpSource!.serverName))];
    if (servers.length > 0) parts.push(`${joinList(servers)} results`);
    const tenant = trace.filter((entry) => isTenantTool(entry.tool) && !entry.error).length;
    if (tenant > 0) parts.push(`${tenant} tenant ${tenant === 1 ? "result" : "results"}`);
    else if (result.tenantContext) parts.push("cached tenant data");
    steps.finish(id, {
      status: result.failed ? "failed" : "completed",
      title: result.failed ? "Could not write the answer" : "Wrote the answer",
      detail: `${name} · ${joinList(parts)}`,
      durationMs: Math.max(0, Date.now() - startedAt - toolMs),
    });
  };
}

/** "2026-08-26" as "Aug 26, 2026". */
export function formatIndexVersion(version: string): string {
  const date = new Date(`${version.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime())
    ? version
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const LINK = /\bhttps?:\/\/|\bwww\.|\b[a-z0-9-]+\.(?:com|net|org|io|dev|app|cloud|ms)\b/i;

/**
 * Follow-ups the model returned in `next`: at most two, trimmed, at most
 * 120 characters, only read-only questions, no links, and nothing the
 * caller's tenant data check rejects.
 */
export function validFollowUps(value: unknown, holdsTenantData: (text: string) => boolean = () => false): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.replace(/\s+/g, " ").trim();
    if (!text || text.length > 120 || LINK.test(text) || planChatContext(text).hasWriteIntent || holdsTenantData(text)) continue;
    if (!out.some((existing) => existing.toLowerCase() === text.toLowerCase())) out.push(text);
    if (out.length === 2) break;
  }
  return out;
}

const PLATFORMS: ReadonlyArray<[RegExp, string]> = [
  [/\bmac\s?os\b|\bmacs?\b/i, "macOS"],
  [/\bipados\b/i, "iPadOS"],
  [/\bios\b|\biphones?\b/i, "iOS"],
  [/\bandroid\b/i, "Android"],
  [/\blinux\b/i, "Linux"],
  [/\bwindows\b/i, "Windows"],
];

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
  if (platform && input.tieInResources.includes("managedDevices")) {
    const counts = input.deviceCountsByOs;
    const count = counts
      ? Object.entries(counts).filter(([os]) => os.toLowerCase() === platform.toLowerCase() || (platform === "Windows" && /^windows/i.test(os))).reduce((sum, [, value]) => sum + value, 0)
      : undefined;
    if (count === 0) return undefined;
    const devices = count === undefined ? `${platform} devices` : `${count} ${platform} ${count === 1 ? "device" : "devices"}`;
    return `Check our ${devices}${topic ? ` for ${topic}` : ""} in Intune`;
  }
  // The planner lists the most relevant resource first.
  // TODO(ugur): this generic wording is used for every non-device tie-in, such as a KQL
  // question about sign-ins. Confirm it, or name per-resource follow-ups.
  const label = definitionForResource(input.tieInResources[0]!).label;
  return topic ? `Check ${topic} in our ${label.toLowerCase()}` : `Check how this applies to our ${label.toLowerCase()}`;
}

/** Deterministic follow-ups first, then the model's, at most two in all. */
export function mergeFollowUps(...lists: ReadonlyArray<ReadonlyArray<string | undefined>>): string[] {
  return validFollowUps(lists.flat().filter((item): item is string => Boolean(item)));
}

/** Whether a Microsoft Learn call answered: a failed or blocked call does not count. */
export function learnAnswered(trace: readonly IntuneChatToolTraceEntry[]): boolean {
  return trace.some((entry) => entry.mcpSource?.serverId === LEARN_SERVER_ID && !entry.error && !entry.mcpSource.blocked);
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
