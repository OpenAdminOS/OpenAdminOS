import { randomUUID } from "node:crypto";

import type { GraphCacheResourceStatus, IntuneChatToolTraceEntry } from "@openadminos/agent-sdk";

import type { GraphCacheQueryPredicate, IntelligenceSqliteStore } from "./sqlite-store.js";

/**
 * Device questions that code can answer exactly: counts, breakdowns and
 * filtered lists over the device cache, follow-ups that narrow the last
 * such result, and "why is this device not compliant" lookups.
 *
 * The local 8B model was handed 20 sample rows of managed and Entra
 * devices together and asked to count. It said 3 where 6 devices were
 * not compliant, skipped the per OS split, and named Entra-only devices.
 * Here code reads the question into filters and counts in SQL over every
 * cached row. On a local model code also writes the answer from the facts;
 * a hosted model writes it from them as authoritative evidence.
 */

/** Code answers questions about the Intune device inventory only; Entra device questions go to the planner. */
export type StructuredDeviceResource = "managedDevices";

export interface StructuredDeviceQuery {
  kind: "count";
  resource: StructuredDeviceResource;
  /** What the counted set is, in plain words, such as "Intune managed devices". */
  scopeLabel: string;
  /** Filters that define the counted set. */
  filters: GraphCacheQueryPredicate[];
  /** Fields counted separately over the set, such as operatingSystem. */
  breakdown: string[];
  /** A subset to count and list by name, such as the devices not compliant. */
  focus?: { label: string; filters: GraphCacheQueryPredicate[] };
  /** List the set (or the focus) by name. */
  list: boolean;
  /** Set when the question narrows the previous result. */
  followUp?: { previousQuestion: string; previousLabel: string };
  /** The previous answer's rows, so a follow-up never counts a device added by a later refresh. */
  ids?: string[];
}

export interface DeviceDetailQuery {
  kind: "device-detail";
  resource: "managedDevices";
  deviceId: string;
  deviceName: string;
  /** What was asked about the device. Only compliance reasons are modelled. */
  topic: "compliance-reason";
}

export type StructuredQuery = StructuredDeviceQuery | DeviceDetailQuery;

/** The structured result of the last tenant answer, stored per conversation for follow-ups. */
export interface ChatResultContext {
  version: 1;
  tenantId: string;
  question: string;
  resource: StructuredDeviceResource;
  /** The filters of the set the answer listed (the focus when there was one). */
  filters: GraphCacheQueryPredicate[];
  label: string;
  total: number;
  /** The rows the answer matched, when at most CONTEXT_ID_LIMIT: a follow-up narrows these, not a re-read of the cache. */
  ids?: string[];
  /** The question's shape (its set, subset, split and list), so "what about macOS?" asks it again with macOS. */
  shape?: { filters: GraphCacheQueryPredicate[]; focus?: { label: string; filters: GraphCacheQueryPredicate[] }; breakdown: string[]; list: boolean; breakdownOnSubset?: boolean };
  computedAt: string;
}

/** How many matched row ids a follow-up context keeps; a larger set is narrowed by its filters. */
export const CONTEXT_ID_LIMIT = 500;

export interface ComputedListedRow {
  id: string;
  name: string;
  operatingSystem?: string;
  complianceState?: string;
  lastSyncDateTime?: string;
}

export interface ComputedResult {
  kind: StructuredQuery["kind"];
  resource: StructuredDeviceResource;
  scopeLabel: string;
  /** The result narrows the previous answer's set. */
  followUp?: boolean;
  total: number;
  groups: Record<string, Record<string, number>>;
  focus?: { label: string; total: number; groups: Record<string, Record<string, number>>; rows: ComputedListedRow[]; complete: boolean };
  /** Rows of the set itself, when the set is listed and has no focus. */
  rows?: ComputedListedRow[];
  rowsComplete?: boolean;
  /** Plain sentences, computed in code: the answer a local model's turn shows, and the facts a hosted model states. */
  facts: string[];
  /** What the question asks that the cached data does not hold. */
  notInData?: string[];
  snapshot?: { refreshedAt?: string; rows: number; partial: boolean; lastError?: string };
  /** The context a follow-up narrows. */
  context: Omit<ChatResultContext, "tenantId" | "computedAt">;
}

/** How many listed rows the facts and the pack carry by name. */
export const COMPUTED_LIST_LIMIT = 50;

const OS_FILTERS: Array<{ pattern: RegExp; label: string; predicate: GraphCacheQueryPredicate }> = [
  { pattern: /\bwindows\b/, label: "Windows", predicate: { field: "operatingSystem", op: "eq", value: "Windows" } },
  { pattern: /\bmac ?os\b|\bmacs?\b|\bos x\b/, label: "macOS", predicate: { field: "operatingSystem", op: "eq", value: "macOS" } },
  // "iOS" is Intune's iOS/iPadOS platform. Whether an iPad reports operatingSystem "iOS" or "iPadOS" is not
  // documented and could not be checked on a tenant, so iPad and iPhone words are not read as a filter.
  { pattern: /\bios\b/, label: "iOS/iPadOS", predicate: { field: "operatingSystem", op: "in", value: ["iOS", "iPadOS"] } },
  { pattern: /\bandroid\b/, label: "Android", predicate: { field: "operatingSystem", op: "startsWith", value: "Android" } },
  { pattern: /\blinux\b|\bubuntu\b/, label: "Linux", predicate: { field: "operatingSystem", op: "eq", value: "Linux" } },
];

const NOT_COMPLIANT = /\b(not compliant|noncompliant|non-compliant|non compliant|aren'?t compliant|isn'?t compliant|out of compliance|failing compliance|fail compliance)\b/;
const COMPLIANT = /\bcompliant\b/;
const GRACE = /\bin grace period\b|\bgrace period\b/;
/** A lead that marks a short follow-up, for planning it with the previous question. */
const FOLLOW_UP_LEAD = /^(?:and |but |ok(?:ay)?,? |so |then )?(?:only|just|what about|how about|and|of (?:those|these|them)|which of (?:those|these|them)|how many of (?:those|these|them)|filter (?:to|by|for)|same for)\b/;

function normalize(question: string): string {
  return question.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

/** An operating system the question excludes ("not Windows", "non-Windows", "other than macOS"): a filter the parser does not express. */
const NEGATED_SYSTEM = /(?:\b(?:not|except|excluding|besides|other than|apart from)|n't|\bnon)[\s-]*(?:(?:on|running|a|an|any)\s+)?(?:windows|mac ?os|macs?|os x|ios|ipad ?os|iphones?|ipads?|android|linux|ubuntu)\b/;

function osFilter(lower: string): { label: string; predicate: GraphCacheQueryPredicate } | undefined {
  if (NEGATED_SYSTEM.test(lower)) return undefined;
  // "per OS" names no system; an OS named inside a breakdown phrase is still a filter.
  const matched = OS_FILTERS.filter((entry) => entry.pattern.test(lower));
  return matched.length === 1 ? matched[0] : undefined;
}

/**
 * The compliance state a question asks about. "Not compliant" is Intune's
 * noncompliant state, as the direct evidence answers and the Intune
 * portal count it; grace period is its own state. Wording the parser
 * cannot read for certain ("not currently compliant", or both states in
 * one question) is ambiguous, and the question goes to the planner.
 */
function complianceFocus(lower: string): { label: string; predicate: GraphCacheQueryPredicate } | "ambiguous" | undefined {
  const negative = NOT_COMPLIANT.test(lower);
  const rest = lower.replace(new RegExp(NOT_COMPLIANT.source, "g"), " ");
  const positive = COMPLIANT.test(rest);
  if ([negative, positive, GRACE.test(lower)].filter(Boolean).length > 1) return "ambiguous";
  if (/(?:\b(?:not|no longer|never)|n't)\s+(?:\w+\s+){0,2}(?:in\s+)?(?:a\s+|the\s+)?grace\b/.test(lower)) return "ambiguous";
  if (positive && /(?:\b(?:not|no longer|never)|n't)\s+(?:\w+\s+){0,2}compliant\b/.test(rest)) return "ambiguous";
  if (negative) return { label: "not compliant", predicate: { field: "complianceState", op: "eq", value: "noncompliant" } };
  if (GRACE.test(lower)) return { label: "in grace period", predicate: { field: "complianceState", op: "eq", value: "inGracePeriod" } };
  if (positive) return { label: "compliant", predicate: { field: "complianceState", op: "eq", value: "compliant" } };
  return undefined;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A negation on the sync verb: "not synced", "haven't checked in", "without a sync", "no recent sync". */
const SYNC_NEGATION = /(?:\b(?:not|never|no longer|without)|n't)\s+(?:(?:been|had|yet|recently|once|a|any)\s+){0,2}(?:sync(?:ed|ing|s)?|checked in|check-?in|contacted|seen)\b|\bno (?:recent )?(?:sync|check-?in)\b/;

/** A sync window named in the question, as a predicate on lastSyncDateTime. */
function syncFilter(lower: string, generatedAt: string): { label: string; predicate: GraphCacheQueryPredicate } | undefined {
  if (!/\b(sync(?:ed|ing|s)?|checked in|check-?in|last seen|contacted)\b/.test(lower)) return undefined;
  const now = new Date(generatedAt);
  if (!Number.isFinite(now.getTime())) return undefined;
  // Only a negation on the sync verb itself counts: "not compliant and synced today" is synced today.
  const negated = SYNC_NEGATION.test(lower);
  let since: Date | undefined;
  let label = "";
  if (/\bthis month\b/.test(lower)) {
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    label = "this month";
  } else if (/\btoday\b/.test(lower)) {
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    label = "today";
  } else if (/\bthis week\b/.test(lower)) {
    const day = (now.getUTCDay() + 6) % 7;
    since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
    label = "this week";
  } else {
    const days = /\b(?:last|past|in the last|within(?: the last)?|over the last|for|in)\s+(\d{1,4})\s+days?\b/.exec(lower)?.[1]
      // "in the past week" is the trailing seven days; "last week" or "last month" alone is a calendar
      // period, which one cutoff cannot express, so it stays unread and the question goes to the planner.
      ?? (/\b(?:in|within|over|during) the (?:last|past) week\b|\bthe past week\b/.test(lower) ? "7" : /\b(?:in|within|over|during) the (?:last|past) month\b/.test(lower) ? "30" : undefined);
    if (days === undefined) return undefined;
    // A window outside one day to ten years is not shortened to fit: the question goes to the planner.
    const count = Number(days);
    if (!(count >= 1 && count <= 3650)) return undefined;
    since = new Date(now.getTime() - count * MS_PER_DAY);
    label = `in the last ${count} ${count === 1 ? "day" : "days"}`;
  }
  return negated
    ? { label: `not synced ${label}`, predicate: { field: "lastSyncDateTime", op: "lt", value: since.toISOString() } }
    : { label: `synced ${label}`, predicate: { field: "lastSyncDateTime", op: "gte", value: since.toISOString() } };
}

/**
 * The question shapes code answers, each read as a whole sentence.
 *
 * An open reading of the words kept finding questions it computed wrongly:
 * a dropped "not", an "or" read as "and", "Windows 11" read as Windows,
 * independent clauses read as a subset. On a local model code renders the
 * answer itself, so a misread is a confident wrong answer. The shapes below
 * are a closed list; any other question goes to the planner, as before.
 */
const OS_WORDS = "windows|macos|ios|android|linux";
const STATE_WORDS = "not compliant|noncompliant|compliant|in grace period";
const SYNC_WINDOW = "in the last \\d{1,4} days|within the last \\d{1,4} days|in the past \\d{1,4} days|this month|this week|today";
const SYNCED = `(?<sneg>have not |has not |did not |that have not |that have |have )?(?:synced|checked in) (?<swin>${SYNC_WINDOW})`;
const THERE = "(?: are there| do we have| do i have| we have| exist)?";
const WHERE = "(?: in intune| in our tenant| in the tenant| in total)?";

/** Intune devices, optionally of one OS: "devices", "managed Windows devices", "Macs". */
function devicesSlot(name: string): string {
  // Only "devices" names the whole inventory: "computers" or "machines" would also count phones.
  return `(?:(?:intune |managed |intune managed )?(?:(?<${name}>${OS_WORDS}) )?(?:intune |managed )?devices|(?<${name}Macs>macs))`;
}

const COUNT_HEAD = new RegExp(`^how many (?:(?<pre>noncompliant|compliant) )?${devicesSlot("os")}(?: (?:are|that are) (?<post>${STATE_WORDS})| ${SYNCED})?${THERE}${WHERE}(?<rest>.*)$`);
const LIST_STATE_AFTER = new RegExp(`^(?:which|list|show(?: me)?|what are)(?: all)?(?: the)?(?: of)?(?: our| my| the)? ${devicesSlot("os")}(?: (?:that |which )?(?:are|is))? (?<state>${STATE_WORDS})$`);
const LIST_STATE_BEFORE = new RegExp(`^(?:list|show(?: me)?|what are)(?: all)?(?: the| our| my)? (?<state>noncompliant|compliant) ${devicesSlot("os")}$`);
const LIST_SYNC = new RegExp(`^(?:which|list|show(?: me)?)(?: all)?(?: the)?(?: of)?(?: our| my)? ${devicesSlot("os")} ${SYNCED}$`);

/** The clauses a count may add, each whole: a per OS or per state split, the subset to list, or "list them". */
const CLAUSE_BREAK_OS = /^(?:show |list |give me |with )?(?:them |it |the |a )?(?:split |breakdown )?(?:per|by|split by|broken down by) (?:os|operating system|platform)s?$/;
const CLAUSE_BREAK_STATE = /^(?:show |list )?(?:them |it )?(?:per|by) compliance(?: state| status)?$/;
const CLAUSE_FOCUS_STATE = new RegExp(`^(?:(?:show|list|tell)(?: me)? )?(?:which (?:ones |of them )?are|how many (?:of them |of those )?are) (?<state>${STATE_WORDS})$|^(?:show|list)(?: me)? the (?<state2>${STATE_WORDS}) ones$`);
const CLAUSE_FOCUS_OS = new RegExp(`^(?:(?:show|list)(?: me)? )?(?:which (?:ones |of them )?are|how many (?:of them |of those )?are) (?<os>${OS_WORDS})(?: devices)?$`);
const CLAUSE_LIST = /^(?:show|list)(?: me)? (?:them|the devices|the list|their names)$/;

/** Follow-ups that refer back to the previous answer. */
const F_ONLY_OS = new RegExp(`^(?:only|just)(?: the)? (?:(?<os>${OS_WORDS})(?: ones| devices)?|(?<osMacs>macs))$`);
const F_ONLY_STATE = new RegExp(`^(?:only|just)(?: the)? (?<state>${STATE_WORDS})(?: ones| devices)?$`);
const F_OF_THOSE_OS = new RegExp(`^(?:which|how many) of (?:those|them|these) (?:are|run) (?<os>${OS_WORDS})(?: devices)?(?: (?<bstate>(?:by|per) compliance(?: state| status)?))?$`);
const F_OF_THOSE_STATE = new RegExp(`^(?:which|how many) of (?:those|them|these) are (?<state>${STATE_WORDS})(?: (?<bos>(?:by|per) os))?$`);
const F_OF_THOSE_SYNC = new RegExp(`^(?:which|how many) of (?:those|them|these) ${SYNCED}$`);
const F_SWITCH_OS = new RegExp(`^(?:what|how) about (?:(?<os>${OS_WORDS})(?: devices)?|(?<osMacs>macs))$|^(?:same )?for (?<os2>${OS_WORDS})$`);

type Part = { label: string; predicate: GraphCacheQueryPredicate };

/** A fresh question's label in its own words: "Intune managed Windows devices not synced in the last 7 days". */
function partsLabel(scope: readonly Part[]): string {
  const os = scope.find((part) => part.predicate.field === "operatingSystem")?.label;
  const rest = scope.filter((part) => part.predicate.field !== "operatingSystem").map((part) => part.label);
  return `Intune managed ${os ? `${os} ` : ""}devices${rest.length ? ` ${rest.join(", ")}` : ""}`;
}

/** The question in the form the shapes read: lower case, contractions and spellings made plain, no lead or end mark. */
function shapeText(question: string): string {
  return normalize(question)
    .replace(/\bnon[- ]compliant\b/g, "noncompliant")
    .replace(/\b(are|is)n'?t\b/g, "$1 not")
    .replace(/\bhaven'?t\b/g, "have not")
    .replace(/\bhasn'?t\b/g, "has not")
    .replace(/\bdidn'?t\b/g, "did not")
    .replace(/\bmac os\b/g, "macos")
    .replace(/\bipad os\b/g, "ipados")
    .replace(/[?!.]+$/, "")
    .replace(/^(?:and|so|ok|okay|then),? /, "")
    .trim();
}

function osPart(groups: Record<string, string | undefined>, name = "os"): Part | undefined {
  const word = groups[name] ?? (groups[`${name}Macs`] ? "macos" : undefined);
  return word ? osFilter(word) : undefined;
}

function statePart(word: string | undefined): Part | undefined {
  if (!word) return undefined;
  const state = complianceFocus(word);
  return state === "ambiguous" ? undefined : state;
}

function syncPart(groups: Record<string, string | undefined>, generatedAt: string): Part | undefined {
  if (!groups.swin) return undefined;
  const negated = /not/.test(groups.sneg ?? "");
  return syncFilter(`${negated ? "not " : ""}synced ${groups.swin}`, generatedAt);
}

function parts(...entries: Array<Part | undefined>): Part[] {
  return entries.flatMap((entry) => (entry ? [entry] : []));
}

/**
 * Reads a device question into a structured query, or undefined when it is
 * not one of the shapes code answers. A follow-up such as "only Windows"
 * narrows `previous` instead of starting over.
 */
export function structuredQueryForQuestion(input: {
  question: string;
  generatedAt: string;
  previous?: ChatResultContext;
}): StructuredDeviceQuery | undefined {
  const text = shapeText(input.question);
  if (!text) return undefined;
  if (input.previous) {
    const followUp = followUpQuery(text, input.previous, input.generatedAt);
    if (followUp !== "none") return followUp;
  }
  return countQuery(text, input.generatedAt) ?? listQuery(text, input.generatedAt);
}

function countQuery(text: string, generatedAt: string): StructuredDeviceQuery | undefined {
  const match = COUNT_HEAD.exec(text);
  if (!match?.groups) return undefined;
  const groups = match.groups;
  const scope = parts(osPart(groups), statePart(groups.pre ?? groups.post), syncPart(groups, generatedAt));
  if ((groups.pre && groups.post) || (groups.swin && !scope.some((part) => part.predicate.field === "lastSyncDateTime"))) return undefined;
  const breakdown: string[] = [];
  let focus: Part | undefined;
  let listed = false;
  for (const clause of (groups.rest ?? "").split(/\s*(?:[?,;.]|\band\b)\s*/).map((part) => part.trim()).filter(Boolean)) {
    if (CLAUSE_BREAK_OS.test(clause) && !breakdown.includes("operatingSystem")) breakdown.push("operatingSystem");
    else if (CLAUSE_BREAK_STATE.test(clause) && !breakdown.includes("complianceState")) breakdown.push("complianceState");
    else if (CLAUSE_LIST.test(clause)) listed = true;
    else {
      const state = CLAUSE_FOCUS_STATE.exec(clause)?.groups;
      const os = CLAUSE_FOCUS_OS.exec(clause)?.groups;
      const next = state ? statePart(state.state ?? state.state2) : os ? osPart(os) : undefined;
      // A clause the shapes do not read, or a second subset, is a different question.
      if (!next || focus) return undefined;
      focus = next;
    }
  }
  // "List their names, and show which are not compliant" asks for two lists; the computed answer holds one.
  if (listed && focus) return undefined;
  const fields = new Set(scope.map((part) => part.predicate.field));
  // A subset or a split on a field the counted set already fixes ("how many Windows devices, per OS") is not answered.
  if ((focus && fields.has(focus.predicate.field)) || breakdown.some((field) => fields.has(field))) return undefined;
  const filters = scope.map((part) => part.predicate);
  return {
    kind: "count",
    resource: "managedDevices",
    scopeLabel: partsLabel(scope),
    filters,
    breakdown,
    ...(focus ? { focus: { label: focus.label, filters: [focus.predicate] } } : {}),
    list: Boolean(focus) || listed,
  };
}

function listQuery(text: string, generatedAt: string): StructuredDeviceQuery | undefined {
  const groups = (LIST_STATE_AFTER.exec(text) ?? LIST_STATE_BEFORE.exec(text))?.groups;
  const syncGroups = groups ? undefined : LIST_SYNC.exec(text)?.groups;
  const scope = groups
    ? parts(osPart(groups), statePart(groups.state))
    : syncGroups
      ? parts(osPart(syncGroups), syncPart(syncGroups, generatedAt))
      : [];
  if (scope.length === 0 || (groups && !scope.some((part) => part.predicate.field === "complianceState")) || (syncGroups && !scope.some((part) => part.predicate.field === "lastSyncDateTime"))) return undefined;
  const filters = scope.map((part) => part.predicate);
  return { kind: "count", resource: "managedDevices", scopeLabel: partsLabel(scope), filters, breakdown: [], list: true };
}

/** A follow-up query, undefined for a follow-up the shapes cannot answer, or "none" when the text is no follow-up. */
function followUpQuery(text: string, previous: ChatResultContext, generatedAt: string): StructuredDeviceQuery | undefined | "none" {
  let added: Part[];
  let switching = false;
  const breakdown: string[] = [];
  let groups: Record<string, string | undefined> | undefined;
  if ((groups = F_ONLY_OS.exec(text)?.groups)) added = parts(osPart(groups));
  else if ((groups = F_ONLY_STATE.exec(text)?.groups)) added = parts(statePart(groups.state));
  else if ((groups = F_OF_THOSE_OS.exec(text)?.groups)) {
    added = parts(osPart(groups));
    if (groups.bstate) breakdown.push("complianceState");
  } else if ((groups = F_OF_THOSE_STATE.exec(text)?.groups)) {
    added = parts(statePart(groups.state));
    if (groups.bos) breakdown.push("operatingSystem");
  } else if ((groups = F_OF_THOSE_SYNC.exec(text)?.groups)) added = parts(syncPart(groups, generatedAt));
  else if ((groups = F_SWITCH_OS.exec(text)?.groups)) {
    added = parts(osPart(groups) ?? (groups.os2 ? osFilter(groups.os2) : undefined));
    switching = true;
  } else return "none";
  if (added.length !== 1) return undefined;
  const part = added[0]!;
  // "what about macOS?" asks the stored question again for macOS, in its shape: its split, its subset, a count
  // or a list, with the OS swapped in or added. A shape whose split was over a follow-up's subset is not rebuilt.
  if (switching) {
    const shape = previous.shape;
    if (!shape || shape.breakdownOnSubset) return undefined;
    const field = part.predicate.field;
    const inFocus = shape.focus?.filters.some((filter) => filter.field === field) ?? false;
    const swap = (filters: readonly GraphCacheQueryPredicate[]) => filters.map((filter) => (filter.field === field ? part.predicate : filter));
    const filters = inFocus ? [...shape.filters] : shape.filters.some((filter) => filter.field === field) ? swap(shape.filters) : [...shape.filters, part.predicate];
    return {
      kind: "count",
      resource: previous.resource,
      scopeLabel: describeFilters(filters),
      filters,
      // A per OS split of one OS says nothing; it is dropped once the set is one OS.
      breakdown: inFocus ? shape.breakdown : shape.breakdown.filter((entry) => entry !== field),
      ...(shape.focus ? { focus: inFocus ? { label: part.label, filters: swap(shape.focus.filters) } : shape.focus } : {}),
      list: shape.list,
    };
  }
  // A different value on a field already in force without a switch lead ("only the compliant ones" after the
  // noncompliant list) is ambiguous and goes to the planner.
  if (previous.filters.some((filter) => filter.field === part.predicate.field && JSON.stringify(filter) !== JSON.stringify(part.predicate))) return undefined;
  // "of those" needs the previous rows: an answer of more than CONTEXT_ID_LIMIT rows kept none, so the cache
  // could only be read afresh, which may count devices added since. Such a follow-up goes to the planner.
  if (!previous.ids) return undefined;
  return {
    kind: "count",
    resource: previous.resource,
    scopeLabel: previous.label,
    filters: previous.filters,
    breakdown,
    focus: { label: part.label, filters: [part.predicate] },
    list: true,
    followUp: { previousQuestion: previous.question, previousLabel: previous.label },
    ids: previous.ids,
  };
}

/** A plain label for a filtered device set, such as "Intune managed macOS devices not compliant". */
function describeFilters(filters: readonly GraphCacheQueryPredicate[]): string {
  const os = OS_FILTERS.find((entry) => filters.some((filter) => JSON.stringify(filter) === JSON.stringify(entry.predicate)))?.label;
  const state = filters.find((filter) => filter.field === "complianceState")?.value;
  const sync = filters.find((filter) => filter.field === "lastSyncDateTime");
  const base = `Intune managed ${os ? `${os} ` : ""}devices`;
  const parts = [
    state === "noncompliant" ? "not compliant" : state === "inGracePeriod" ? "in grace period" : state === "compliant" ? "compliant" : undefined,
    sync && typeof sync.value === "string" ? `${sync.op === "lt" ? "not synced" : "synced"} since ${sync.value.slice(0, 10)}` : undefined,
  ].filter(Boolean);
  return parts.length ? `${base} ${parts.join(", ")}` : base;
}

function dedupe(filters: GraphCacheQueryPredicate[]): GraphCacheQueryPredicate[] {
  const seen = new Set<string>();
  return filters.filter((filter) => {
    const key = JSON.stringify(filter);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** "why is LAPTOP-07 not compliant", read whole; the name must be one cached managed device's, exactly. */
const WHY_NOT_COMPLIANT = /^why (?:is|does) (?:the device |device )?(?<name>[a-z0-9][a-z0-9._-]{2,62}) (?:not compliant|noncompliant|non-compliant|non compliant|marked (?:as )?(?:noncompliant|non-compliant)|show as (?:noncompliant|non-compliant)|failing compliance|fail compliance|out of compliance)$/;

/** Whether a question asks why a named managed device is not compliant. */
export function deviceComplianceReasonQuery(question: string, store: IntelligenceSqliteStore, tenantId: string): DeviceDetailQuery | undefined {
  // Read from the question as typed, not shapeText: its rewrites ("non-compliant" to "noncompliant") would change a device name.
  const name = WHY_NOT_COMPLIANT.exec(normalize(question).replace(/[?!.]+$/, ""))?.groups?.name;
  if (!name) return undefined;
  const matches = store.findGraphRowsNamedIn({ tenantId, resource: "managedDevices", text: name, limit: 5 }).filter((entry) => entry.name.toLowerCase() === name);
  // None, or two records with this name: their states can differ, so code does not pick one. The planner path answers.
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  return { kind: "device-detail", resource: "managedDevices", deviceId: match.id, deviceName: match.name, topic: "compliance-reason" };
}

function listedRow(row: unknown): ComputedListedRow | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const id = text(record.id) ?? text(record.deviceId);
  const name = text(record.deviceName) ?? text(record.displayName) ?? id;
  if (!id || !name) return undefined;
  return {
    id,
    name,
    ...(text(record.operatingSystem) ? { operatingSystem: text(record.operatingSystem)! } : {}),
    ...(text(record.complianceState) ? { complianceState: text(record.complianceState)! } : {}),
    ...(text(record.lastSyncDateTime) ? { lastSyncDateTime: text(record.lastSyncDateTime)! } : {}),
  };
}

function snapshotOf(status: GraphCacheResourceStatus | undefined): ComputedResult["snapshot"] {
  if (!status) return undefined;
  return {
    ...(status.refreshedAt ? { refreshedAt: status.refreshedAt } : {}),
    rows: status.rows,
    partial: Boolean(status.pageLimitReached || (status.tenantTotal !== undefined && status.rows < status.tenantTotal)),
    ...(status.lastError ? { lastError: status.lastError } : {}),
  };
}

/** "Windows 5, macOS 2, Android 2", largest first. */
function groupText(group: Record<string, number> | undefined): string {
  return Object.entries(group ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => `${value} ${count}`).join(", ");
}

const FIELD_WORDS: Record<string, string> = { operatingSystem: "per OS", complianceState: "per compliance state" };

function rowLine(row: ComputedListedRow): string {
  const details = [row.operatingSystem, row.complianceState, row.lastSyncDateTime ? `last sync ${row.lastSyncDateTime.slice(0, 10)}` : undefined].filter(Boolean);
  return `- ${row.name}${details.length ? ` (${details.join(", ")})` : ""}`;
}

/** Runs a structured query over the cache. Every number is counted in SQL over all cached rows. */
export function computeStructuredResult(input: {
  store: IntelligenceSqliteStore;
  tenantId: string;
  query: StructuredQuery;
  cacheStatus: readonly GraphCacheResourceStatus[];
  generatedAt: string;
}): ComputedResult | undefined {
  const { store, tenantId, query } = input;
  const status = input.cacheStatus.find((entry) => entry.resource === query.resource);
  const snapshot = snapshotOf(status);
  if (!status?.refreshedAt) return undefined;
  if (query.kind === "device-detail") return computeDeviceDetail(input.store, tenantId, query, snapshot, input.generatedAt);

  const listSet = query.list && !query.focus;
  const ids = query.ids ? { ids: query.ids } : {};
  // A follow-up's set is the previous answer's rows, by id: a device whose values changed since stays in it,
  // listed with its current values, so the previous answer's size is never restated from a refresh.
  const baseFilters = query.ids ? [] : query.filters;
  const counted = store.countGraphCache({
    tenantId,
    resource: query.resource,
    filters: baseFilters,
    groupBy: query.breakdown,
    ...ids,
    ...(listSet ? { listLimit: COMPUTED_LIST_LIMIT } : {}),
  });
  const focusCount = query.focus
    ? store.countGraphCache({
        tenantId,
        resource: query.resource,
        filters: [...baseFilters, ...query.focus.filters],
        // A follow-up's requested breakdown ("of those, Windows by compliance state") is over the narrowed rows.
        groupBy: [...new Set(["operatingSystem", ...(query.followUp ? query.breakdown : [])])],
        ...ids,
        listLimit: COMPUTED_LIST_LIMIT,
      })
    : undefined;
  const listedFilters = query.focus ? [...query.filters, ...query.focus.filters] : query.filters;
  const listedTotal = query.focus && focusCount ? focusCount.total : counted.total;
  // The ids a follow-up narrows: the listed set, when it is small enough to keep.
  const contextIds = listedTotal <= CONTEXT_ID_LIMIT
    ? (store.countGraphCache({ tenantId, resource: query.resource, filters: query.focus ? [...baseFilters, ...query.focus.filters] : baseFilters, ...ids, listLimit: CONTEXT_ID_LIMIT }).rows ?? []).flatMap((row) => listedRow(row)?.id ?? [])
    : undefined;
  const rows = (counted.rows ?? []).flatMap((row) => listedRow(row) ?? []);
  const focusRows = (focusCount?.rows ?? []).flatMap((row) => listedRow(row) ?? []);

  const facts: string[] = [];
  const breakdownText = query.breakdown.map((field) => `${FIELD_WORDS[field] ?? `by ${field}`}: ${groupText(counted.groups[field]) || "none reported"}`).join("; ");
  const previousSet = `the ${query.ids?.length ?? counted.total} ${query.scopeLabel} from the previous answer`;
  const gone = query.ids ? query.ids.length - counted.total : 0;
  if (!query.followUp) facts.push(`${query.scopeLabel}: ${counted.total}${breakdownText ? ` (${breakdownText})` : ""}.`);
  else if (!query.focus) facts.push(`${capitalize(previousSet)}${breakdownText ? ` (${breakdownText})` : ""}${listSet && rows.length ? ":" : "."}`);
  if (gone > 0) facts.push(`${gone} of the devices in the previous answer ${gone === 1 ? "is" : "are"} no longer in the cache.`);
  // A device whose values changed since the previous answer stays in its set; say how many no longer match it.
  if (query.ids && query.filters.length > 0) {
    const changed = counted.total - store.countGraphCache({ tenantId, resource: query.resource, filters: query.filters, ids: query.ids }).total;
    if (changed > 0) facts.push(`${changed} of them no longer ${changed === 1 ? "matches" : "match"} "${query.scopeLabel}" with ${changed === 1 ? "its" : "their"} current values, shown below.`);
  }
  if (query.focus && focusCount) {
    const os = groupText(focusCount.groups.operatingSystem);
    const subject = query.followUp ? `${capitalize(query.focus.label)} among ${previousSet}` : capitalize(query.focus.label);
    const focusBreakdown = query.followUp ? query.breakdown.filter((field) => field !== "operatingSystem").map((field) => `${FIELD_WORDS[field] ?? `by ${field}`}: ${groupText(focusCount.groups[field]) || "none reported"}`) : [];
    const parts = [...(os && Object.keys(focusCount.groups.operatingSystem ?? {}).length > 1 ? [os] : []), ...focusBreakdown];
    facts.push(`${subject}: ${focusCount.total}${parts.length ? ` (${parts.join("; ")})` : ""}${focusRows.length ? ":" : "."}`);
    facts.push(...focusRows.map(rowLine));
    if (focusCount.total > focusRows.length) facts.push(`${focusCount.total - focusRows.length} more match and are not listed.`);
  } else if (listSet) {
    facts.push(...rows.map(rowLine));
    if (counted.total > rows.length) facts.push(`${counted.total - rows.length} more match and are not listed.`);
  }
  // A failed latest refresh is said, as the direct answers say it: these counts are older evidence.
  if (snapshot?.lastError) facts.unshift(`The latest refresh failed, so these counts are from the snapshot refreshed ${snapshot.refreshedAt ?? "earlier"}.`);
  facts.push(`Counted from the Intune device cache${snapshot?.refreshedAt ? ` refreshed ${snapshot.refreshedAt}` : ""}${snapshot?.partial ? "; the cache does not hold every device, so these counts cover the cached part only" : ""}.`);

  // Built from the filters, so a chain of follow-ups reads "Intune managed Windows devices not compliant".
  const listedLabel = describeFilters(dedupe(listedFilters));
  return {
    kind: "count",
    resource: query.resource,
    scopeLabel: query.scopeLabel,
    ...(query.followUp ? { followUp: true } : {}),
    total: counted.total,
    groups: counted.groups,
    ...(query.focus && focusCount
      ? { focus: { label: query.focus.label, total: focusCount.total, groups: focusCount.groups, rows: focusRows, complete: focusRows.length === focusCount.total } }
      : {}),
    ...(listSet ? { rows, rowsComplete: rows.length === counted.total } : {}),
    facts,
    ...(snapshot ? { snapshot } : {}),
    context: {
      version: 1,
      question: "",
      resource: query.resource,
      filters: dedupe(listedFilters),
      label: listedLabel,
      total: listedTotal,
      ...(contextIds ? { ids: contextIds } : {}),
      shape: { filters: query.filters, ...(query.focus ? { focus: query.focus } : {}), breakdown: query.breakdown, list: query.list, ...(query.followUp && query.focus && query.breakdown.length > 0 ? { breakdownOnSubset: true } : {}) },
    },
  };
}

function computeDeviceDetail(
  store: IntelligenceSqliteStore,
  tenantId: string,
  query: DeviceDetailQuery,
  snapshot: ComputedResult["snapshot"],
  generatedAt: string,
): ComputedResult | undefined {
  // The name is resolved again in the snapshot that answers: a refresh in this turn can have renamed the device.
  const counted = store.countGraphCache({ tenantId, resource: "managedDevices", filters: [{ field: "displayName", op: "eq", value: query.deviceName }], listLimit: 2 });
  if (counted.total !== 1) return undefined;
  const raw = counted.rows?.[0] as Record<string, unknown> | undefined;
  const row = listedRow(raw);
  if (!row) return undefined;
  const facts: string[] = [];
  const state = row.complianceState ?? "not reported";
  facts.push(`${row.name}${row.operatingSystem ? ` (${row.operatingSystem})` : ""} is marked ${state} in the Intune device cache${snapshot?.refreshedAt ? ` refreshed ${snapshot.refreshedAt}` : ""}.`);
  const notInData = [
    "The cached data does not include which compliance policy or setting failed for this device, so the failing rule cannot be named from it. Open the device in Intune, Device compliance, to see the failing setting.",
  ];
  facts.push(notInData[0]!);
  let lastSyncDate: string | undefined;
  if (row.lastSyncDateTime) {
    lastSyncDate = row.lastSyncDateTime.slice(0, 10);
    const days = Math.floor((new Date(generatedAt).getTime() - new Date(row.lastSyncDateTime).getTime()) / MS_PER_DAY);
    const age = Number.isFinite(days) && days >= 0 ? `, ${days} ${days === 1 ? "day" : "days"} before this answer` : "";
    facts.push(`Lead in the data: the last sync was on ${lastSyncDate}${age}.${Number.isFinite(days) && days > 30 ? " Its compliance state is the one reported at that check-in." : ""}`);
  } else {
    facts.push("The cache has no last sync time for this device.");
  }
  return {
    kind: "device-detail",
    resource: "managedDevices",
    scopeLabel: row.name,
    total: 1,
    groups: {},
    rows: [row],
    rowsComplete: true,
    facts,
    notInData,
    ...(snapshot ? { snapshot } : {}),
    context: { version: 1, question: "", resource: "managedDevices", filters: [{ field: "id", op: "eq", value: query.deviceId }], label: row.name, total: 1 },
  };
}

/** "not compliant" becomes "Not compliant"; a label with its own capitals ("macOS", "iOS/iPadOS") is kept as it is. */
function capitalize(text: string): string {
  return text && text === text.toLowerCase() ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
}

/** The trace entry of a code-rendered answer, so What ran shows the cache read. */
export function computedTraceEntry(result: ComputedResult): IntuneChatToolTraceEntry {
  const now = new Date().toISOString();
  const listed = result.focus?.rows.length ?? result.rows?.length ?? 0;
  return {
    id: `tool_${randomUUID()}`,
    tool: "count_cached",
    params: { resource: result.resource, filters: result.context.filters },
    resultSummary: `${result.focus?.total ?? result.total} matching cached rows counted${listed ? ` · ${listed} listed` : ""}`,
    ...(result.snapshot ? { cacheSource: { resource: result.resource, rows: result.snapshot.rows, ...(result.snapshot.refreshedAt ? { refreshedAt: result.snapshot.refreshedAt } : {}), ...(result.snapshot.lastError ? { error: result.snapshot.lastError } : {}) } } : {}),
    durationMs: 0,
    createdAt: now,
    completedAt: now,
  };
}

/** The answer code writes from a computed result: its facts, one per line. */
export function computedAnswerText(result: ComputedResult): string {
  return result.facts.join("\n");
}

/** The block the answer pack and the tool loop give the model. */
export function computedResultForModel(result: ComputedResult): Record<string, unknown> {
  return {
    authoritative: true,
    rule: "Computed in code over every cached row. State these facts and numbers exactly, name every listed row, and do not count sample rows yourself. Do not give reasons that are not in these facts; where the data does not hold the answer, say so.",
    resource: result.resource,
    scope: result.scopeLabel,
    total: result.total,
    ...(Object.keys(result.groups).length ? { breakdowns: result.groups } : {}),
    ...(result.focus ? { focus: result.focus } : {}),
    ...(result.rows ? { rows: result.rows } : {}),
    ...(result.notInData ? { notInData: result.notInData } : {}),
    facts: result.facts,
  };
}

/**
 * Structured filters for the sample rows of a device question: the OS
 * and compliance state it names, matched on fields, not as raw words.
 */
export function deviceRowFilters(question: string): GraphCacheQueryPredicate[] {
  const lower = normalize(question);
  // "Windows or noncompliant" is a union; ANDing its parts would sample the wrong rows.
  if (/\bor\b/.test(lower)) return [];
  const compliance = complianceFocus(lower);
  return [osFilter(lower), compliance === "ambiguous" ? undefined : compliance].flatMap((entry) => (entry ? [entry.predicate] : []));
}

/** Words a question is made of that name no row: dropped from every text match. */
export const QUESTION_WORDS: ReadonlySet<string> = new Set([
  "how", "many", "much", "are", "there", "is", "was", "were", "show", "per", "which", "what", "who", "why", "when", "where",
  "not", "list", "give", "tell", "me", "all", "the", "and", "with", "that", "this", "have", "has", "had", "does", "did", "do",
  "can", "could", "would", "should", "please", "about", "into", "their", "them", "those", "these", "only", "just",
  "count", "number", "total", "each", "every", "split", "breakdown", "ones", "our", "my", "we", "you", "your", "for", "from",
  "any", "some", "most", "least", "more", "less", "than", "been", "being", "still", "also", "both", "they", "its", "it's",
]);

/**
 * Device words the field filters replace: dropped from the text match of
 * Intune device rows only. A policy or profile search keeps them, so
 * "Windows compliance policies" still matches Windows policies.
 */
export const DEVICE_FIELD_WORDS: ReadonlySet<string> = new Set([
  "compliant", "noncompliant", "non-compliant", "compliance", "devices", "device", "managed", "intune",
  "operating", "system", "systems", "platform", "platforms", "synced", "sync", "last", "month", "week", "today", "days",
  "windows", "macos", "ios", "ipados", "android", "linux", "state", "status", "tenant",
]);

/** The structured query for a question, a named-device compliance lookup first. */
export function planStructuredQuery(input: {
  question: string;
  generatedAt: string;
  previous?: ChatResultContext;
  store: IntelligenceSqliteStore;
  tenantId: string;
}): StructuredQuery | undefined {
  return deviceComplianceReasonQuery(input.question, input.store, input.tenantId)
    ?? structuredQueryForQuestion({ question: input.question, generatedAt: input.generatedAt, ...(input.previous ? { previous: input.previous } : {}) });
}

/** The stored follow-up context of a conversation, when it belongs to this tenant. */
export function readChatResultContext(store: IntelligenceSqliteStore, conversationId: string, tenantId: string): ChatResultContext | undefined {
  const value = store.getChatResultContext(conversationId) as Partial<ChatResultContext> | undefined;
  if (!value || value.version !== 1 || value.tenantId !== tenantId || typeof value.question !== "string" || typeof value.label !== "string" || !Array.isArray(value.filters)) return undefined;
  if (value.resource !== "managedDevices") return undefined;
  return value as ChatResultContext;
}

/** The context the next question narrows: this answer's computed result, or none. */
export function chatResultContextFor(result: ComputedResult | undefined, input: { tenantId: string; question: string; computedAt: string }): ChatResultContext | undefined {
  // A device lookup is about one device; a follow-up such as "only Windows" never narrows it.
  if (!result || result.kind === "device-detail") return undefined;
  return { ...result.context, question: input.question, tenantId: input.tenantId, computedAt: input.computedAt };
}

const FOLLOW_UP_WORDS = /\b(those|these|them|that|it|the same|only|just|instead|also|what about|how about)\b/;

/**
 * The text a follow-up is planned from: the previous question with the
 * current one, so "only Windows" after a device question plans devices.
 */
export function followUpPlanningText(question: string, previousQuestion: string | undefined): string {
  if (!previousQuestion) return question;
  const lower = normalize(question);
  const short = lower.split(" ").length <= 6;
  return short && (FOLLOW_UP_WORDS.test(lower) || FOLLOW_UP_LEAD.test(lower)) ? `${previousQuestion}\n${question}` : question;
}
