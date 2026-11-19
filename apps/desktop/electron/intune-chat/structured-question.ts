import type { GraphCacheResourceStatus } from "@openadminos/agent-sdk";

import type { GraphCacheQueryPredicate, IntelligenceSqliteStore } from "./sqlite-store.js";

/**
 * Device questions that code can answer exactly: counts, breakdowns and
 * filtered lists over the device cache, follow-ups that narrow the last
 * such result, and "why is this device not compliant" lookups.
 *
 * The local 8B model was handed 20 sample rows of managed and Entra
 * devices together and asked to count. It said 3 where 6 devices were
 * not compliant, skipped the per OS split, and named Entra-only devices.
 * Here code reads the question into filters, counts in SQL over every
 * cached row, and the model only writes the answer around the facts.
 */

export type StructuredDeviceResource = "managedDevices" | "entraDevices";

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
  computedAt: string;
}

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
  /** Plain sentences, computed in code, that the answer must state. */
  facts: string[];
  /** What the question asks that the cached data does not hold. */
  notInData?: string[];
  snapshot?: { refreshedAt?: string; rows: number; partial: boolean; lastError?: string };
  /** The context a follow-up narrows. */
  context: Omit<ChatResultContext, "tenantId" | "computedAt">;
  /** For a device lookup: the facts an answer is checked against. */
  device?: { name: string; complianceState?: string; lastSyncDate?: string };
}

/** How many listed rows the facts and the pack carry by name. */
export const COMPUTED_LIST_LIMIT = 50;

const OS_FILTERS: Array<{ pattern: RegExp; label: string; predicate: GraphCacheQueryPredicate }> = [
  { pattern: /\bwindows\b|\bwin(?:10|11)\b/, label: "Windows", predicate: { field: "operatingSystem", op: "eq", value: "Windows" } },
  { pattern: /\bmac ?os\b|\bmacs?\b|\bos x\b/, label: "macOS", predicate: { field: "operatingSystem", op: "eq", value: "macOS" } },
  { pattern: /\bios\b|\bipad ?os\b|\biphones?\b|\bipads?\b/, label: "iOS", predicate: { field: "operatingSystem", op: "in", value: ["iOS", "iPadOS"] } },
  { pattern: /\bandroid\b/, label: "Android", predicate: { field: "operatingSystem", op: "startsWith", value: "Android" } },
  { pattern: /\blinux\b|\bubuntu\b/, label: "Linux", predicate: { field: "operatingSystem", op: "eq", value: "Linux" } },
];

const DEVICE_SUBJECT = /\b(devices?|machines?|endpoints?|computers?|laptops?|pcs?|phones?|tablets?|fleet|intune|ones?)\b/;
const COUNT_INTENT = /\b(how many|number of|count|total|totals|tally)\b/;
const LIST_INTENT = /\b(which|list|names?|show (?:me )?(?:the |all )?(?:devices|ones|them|those|these|which|me)|what are (?:they|the)|give me (?:the )?(?:list|names))\b/;
const BREAKDOWN_OS = /\b(?:per|by|each|split by|broken down by|grouped by|for each|across)\s+(?:os|operating systems?|platforms?)\b|\bos (?:split|breakdown)\b|\bper-os\b/;
const BREAKDOWN_COMPLIANCE = /\b(?:per|by|each)\s+compliance(?: state| status)?\b/;
const BREAKDOWN_OWNERSHIP = /\b(?:per|by)\s+(?:owner(?:ship)?(?: type)?)\b/;
const NOT_COMPLIANT = /\b(not compliant|noncompliant|non-compliant|non compliant|aren'?t compliant|isn'?t compliant|out of compliance|failing compliance|fail compliance)\b/;
const COMPLIANT = /\bcompliant\b/;
const GRACE = /\bin grace period\b|\bgrace period\b/;
const ENTRA_SUBJECT = /\b(entra|azure ad|aad|directory devices?|registered devices?|registration|hybrid(?: joined)?|joined|join type|trust type|device objects?)\b/;
/**
 * Topics the device count path does not model. A question about apps,
 * policies or encryption is left to the planner, so a count of all
 * devices never stands in for an answer to a different question.
 */
const OTHER_TOPIC = /\b(apps?|applications?|polic(?:y|ies)|profiles?|scripts?|remediations?|updates?|patch|users?|groups?|encrypt\w*|bitlocker|filevault|autopilot|enrol\w*|sign-?ins?|alerts?|incidents?|defender|configuration|certificates?|wi-?fi|vpn|licen[cs]e\w*|storage|disk|memory|serial|model|manufacturer|vendor|ram|cpu|primary user|assigned|assignment|stale|inactive|retire\w*|wipe\w*|delete\w*)\b/;
const FOLLOW_UP_LEAD = /^(?:and |but |ok(?:ay)?,? |so |then )?(?:only|just|what about|how about|and|of (?:those|these|them)|which of (?:those|these|them)|how many of (?:those|these|them)|filter (?:to|by|for)|same for)\b/;
const ANAPHORA = /\b(those|these|them|that list|the same|of those|of these|of them|ones)\b/;
const WHY = /\bwhy\b|\breason\b|\bwhat(?:'s| is) wrong\b|\bcause\b/;

/**
 * Every word a structured question may contain. A question with any other
 * content word ("which Macs need attention", "devices with BitLocker
 * issues") asks something the counts do not answer, so it is left to the
 * planner and the model.
 */
const KNOWN_WORDS = new Set([
  "how", "many", "much", "are", "there", "is", "was", "were", "be", "show", "per", "which", "what", "whats", "what's",
  "not", "compliant", "noncompliant", "non", "compliance", "devices", "device", "managed", "intune", "entra",
  "list", "give", "tell", "me", "us", "all", "the", "and", "with", "that", "have", "has", "do", "does", "can", "could",
  "would", "please", "of", "in", "on", "by", "to", "for", "at", "or", "a", "an", "our", "my", "we", "i", "you",
  "only", "just", "those", "these", "them", "they", "ones", "one", "it", "its", "also", "both", "each", "every",
  "count", "number", "total", "totals", "tally", "operating", "system", "systems", "os", "platform", "platforms",
  "split", "breakdown", "broken", "down", "grouped", "group", "across", "state", "status", "states",
  "windows", "win10", "win11", "macos", "mac", "macs", "osx", "x", "ios", "ipados", "iphone", "iphones", "ipad", "ipads",
  "android", "linux", "ubuntu", "machines", "machine", "endpoints", "endpoint", "computers", "computer", "laptops",
  "laptop", "pcs", "pc", "phones", "phone", "tablets", "tablet", "fleet", "tenant", "currently", "right", "now", "cached",
  "out", "failing", "fail", "grace", "period", "aren't", "isn't", "arent", "isnt", "ownership", "owner", "type",
  "sync", "synced", "syncs", "syncing", "checked", "check", "seen", "last", "contacted", "this", "month", "week",
  "today", "past", "within", "over", "since", "days", "day", "never", "no", "longer", "haven't", "hasn't", "didn't",
  "havent", "hasnt", "didnt", "without", "names", "name", "them", "about", "how's", "so", "then", "but", "ok", "okay",
  "same", "filter", "instead", "directory", "azure", "ad", "aad", "registered", "joined", "here", "again", "too",
]);

function unknownWords(lower: string): string[] {
  return lower
    .replace(/[?.!,;:()"]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word && !/^\d+$/.test(word) && !KNOWN_WORDS.has(word) && !word.split("-").every((part) => KNOWN_WORDS.has(part) || /^\d+$/.test(part)));
}

function normalize(question: string): string {
  return question.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, " ").trim();
}

function osFilter(lower: string): { label: string; predicate: GraphCacheQueryPredicate } | undefined {
  // "per OS" names no system; an OS named inside a breakdown phrase is still a filter.
  const matched = OS_FILTERS.filter((entry) => entry.pattern.test(lower));
  return matched.length === 1 ? matched[0] : undefined;
}

function complianceFocus(lower: string): { label: string; predicate: GraphCacheQueryPredicate } | undefined {
  if (NOT_COMPLIANT.test(lower)) return { label: "not compliant", predicate: { field: "complianceState", op: "neq", value: "compliant" } };
  if (GRACE.test(lower)) return { label: "in grace period", predicate: { field: "complianceState", op: "eq", value: "inGracePeriod" } };
  if (COMPLIANT.test(lower)) return { label: "compliant", predicate: { field: "complianceState", op: "eq", value: "compliant" } };
  return undefined;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A sync window named in the question, as a predicate on lastSyncDateTime. */
export function syncFilter(lower: string, generatedAt: string): { label: string; predicate: GraphCacheQueryPredicate } | undefined {
  if (!/\b(sync(?:ed|ing|s)?|checked in|check-?in|last seen|contacted)\b/.test(lower)) return undefined;
  const now = new Date(generatedAt);
  if (!Number.isFinite(now.getTime())) return undefined;
  const negated = /\b(not|n't|never|no longer|haven'?t|hasn'?t|didn'?t|without)\b/.test(lower);
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
      ?? (/\b(?:last|past) week\b/.test(lower) ? "7" : /\b(?:last|past) month\b|\b30 days\b/.test(lower) ? "30" : undefined);
    if (days === undefined) return undefined;
    const count = Math.max(1, Math.min(3650, Number(days)));
    since = new Date(now.getTime() - count * MS_PER_DAY);
    label = `in the last ${count} ${count === 1 ? "day" : "days"}`;
  }
  return negated
    ? { label: `not synced ${label}`, predicate: { field: "lastSyncDateTime", op: "lt", value: since.toISOString() } }
    : { label: `synced ${label}`, predicate: { field: "lastSyncDateTime", op: "gte", value: since.toISOString() } };
}

/**
 * Reads a device question into a structured query, or undefined when the
 * question is not one code can answer exactly. A follow-up such as "only
 * Windows" narrows `previous` instead of starting over.
 */
export function structuredQueryForQuestion(input: {
  question: string;
  generatedAt: string;
  previous?: ChatResultContext;
}): StructuredDeviceQuery | undefined {
  const lower = normalize(input.question);
  if (!lower) return undefined;
  const os = osFilter(lower);
  const compliance = complianceFocus(lower);
  const sync = syncFilter(lower, input.generatedAt);
  const breakdown = [
    ...(BREAKDOWN_OS.test(lower) ? ["operatingSystem"] : []),
    ...(BREAKDOWN_COMPLIANCE.test(lower) ? ["complianceState"] : []),
    ...(BREAKDOWN_OWNERSHIP.test(lower) ? ["managedDeviceOwnerType"] : []),
  ];
  const count = COUNT_INTENT.test(lower);
  const list = LIST_INTENT.test(lower);
  const constraints = [os, compliance, sync].filter(Boolean).length;

  // A word the parser does not know means the question asks something the counts do not answer.
  if (unknownWords(lower).length > 0) return undefined;
  const previous = input.previous;
  const wordCount = lower.split(" ").length;
  const followsUp = previous !== undefined
    && !ENTRA_SUBJECT.test(lower)
    && !OTHER_TOPIC.test(lower)
    && (FOLLOW_UP_LEAD.test(lower) || ANAPHORA.test(lower) || (wordCount <= 4 && constraints > 0 && !DEVICE_SUBJECT.test(lower)))
    && (constraints > 0 || count || list || breakdown.length > 0);
  if (followsUp && previous) {
    const added = [os, compliance, sync].flatMap((entry) => (entry ? [entry] : []));
    // A narrowing that repeats a filter already in force adds nothing new; the previous set is listed again.
    const fields = new Set(previous.filters.map((filter) => filter.field));
    const fresh = added.filter((entry) => !fields.has(entry.predicate.field) || !previous.filters.some((filter) => JSON.stringify(filter) === JSON.stringify(entry.predicate)));
    const label = fresh.map((entry) => entry.label).join(", ");
    return {
      kind: "count",
      resource: previous.resource,
      scopeLabel: previous.label,
      filters: previous.filters,
      breakdown: breakdown.length > 0 ? breakdown : fresh.length === 0 && previous.resource === "managedDevices" ? ["operatingSystem"] : [],
      ...(fresh.length > 0 ? { focus: { label, filters: fresh.map((entry) => entry.predicate) } } : {}),
      list: true,
      followUp: { previousQuestion: previous.question, previousLabel: previous.label },
    };
  }

  if (!DEVICE_SUBJECT.test(lower) || OTHER_TOPIC.test(lower) || WHY.test(lower)) return undefined;
  if (!count && breakdown.length === 0 && !(list && constraints > 0)) return undefined;
  const entra = ENTRA_SUBJECT.test(lower) && !/\bintune\b|\bmanaged devices?\b/.test(lower);
  const resource: StructuredDeviceResource = entra ? "entraDevices" : "managedDevices";
  // Entra device objects carry no complianceState and no lastSyncDateTime.
  if (entra && (compliance || sync)) return undefined;
  const scopeFilters = [os, ...(compliance && !list && !count ? [compliance] : [])].flatMap((entry) => (entry ? [entry.predicate] : []));
  const scopeLabel = resource === "managedDevices"
    ? `Intune managed ${os ? `${os.label} ` : ""}devices`
    : `Entra ${os ? `${os.label} ` : ""}devices`;
  // "How many devices, and which are not compliant": the count covers the set, the list the subset.
  const focusParts = [compliance, sync].flatMap((entry) => (entry ? [entry] : []));
  const focus = focusParts.length > 0 && (count || breakdown.length > 0) && list
    ? { label: focusParts.map((entry) => entry.label).join(", "), filters: focusParts.map((entry) => entry.predicate) }
    : undefined;
  const filters = focus ? scopeFilters : [...scopeFilters, ...focusParts.map((entry) => entry.predicate)];
  const label = focus || focusParts.length === 0 ? scopeLabel : `${scopeLabel} ${focusParts.map((entry) => entry.label).join(", ")}`;
  return {
    kind: "count",
    resource,
    scopeLabel: label,
    filters: dedupe(filters),
    breakdown,
    ...(focus ? { focus } : {}),
    list: list || Boolean(focus),
  };
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

/** Whether a question asks why a named managed device is not compliant. */
export function deviceComplianceReasonQuery(question: string, store: IntelligenceSqliteStore, tenantId: string): DeviceDetailQuery | undefined {
  const lower = normalize(question);
  if (!WHY.test(lower) || !(NOT_COMPLIANT.test(lower) || /\bcompliance\b/.test(lower))) return undefined;
  const match = store.findGraphRowsNamedIn({ tenantId, resource: "managedDevices", text: question, limit: 2 })[0];
  if (!match) return undefined;
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
export function groupText(group: Record<string, number> | undefined): string {
  return Object.entries(group ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => `${value} ${count}`).join(", ");
}

const FIELD_WORDS: Record<string, string> = { operatingSystem: "per OS", complianceState: "per compliance state", managedDeviceOwnerType: "per ownership" };

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
  const counted = store.countGraphCache({
    tenantId,
    resource: query.resource,
    filters: query.filters,
    groupBy: query.breakdown,
    ...(listSet ? { listLimit: COMPUTED_LIST_LIMIT } : {}),
  });
  const focusCount = query.focus
    ? store.countGraphCache({
        tenantId,
        resource: query.resource,
        filters: [...query.filters, ...query.focus.filters],
        groupBy: query.resource === "managedDevices" ? ["operatingSystem"] : [],
        listLimit: COMPUTED_LIST_LIMIT,
      })
    : undefined;
  const rows = (counted.rows ?? []).flatMap((row) => listedRow(row) ?? []);
  const focusRows = (focusCount?.rows ?? []).flatMap((row) => listedRow(row) ?? []);

  const facts: string[] = [];
  const breakdownText = query.breakdown.map((field) => `${FIELD_WORDS[field] ?? `by ${field}`}: ${groupText(counted.groups[field]) || "none reported"}`).join("; ");
  const previousSet = `the ${counted.total} ${query.scopeLabel} from the previous answer`;
  if (!query.followUp) facts.push(`${query.scopeLabel}: ${counted.total}${breakdownText ? ` (${breakdownText})` : ""}.`);
  else if (!query.focus) facts.push(`${capitalize(previousSet)}${breakdownText ? ` (${breakdownText})` : ""}${listSet && rows.length ? ":" : "."}`);
  if (query.focus && focusCount) {
    const os = groupText(focusCount.groups.operatingSystem);
    const subject = query.followUp ? `${capitalize(query.focus.label)} among ${previousSet}` : capitalize(query.focus.label);
    facts.push(`${subject}: ${focusCount.total}${os && Object.keys(focusCount.groups.operatingSystem ?? {}).length > 1 ? ` (${os})` : ""}${focusRows.length ? ":" : "."}`);
    facts.push(...focusRows.map(rowLine));
    if (focusCount.total > focusRows.length) facts.push(`${focusCount.total - focusRows.length} more match and are not listed.`);
  } else if (listSet) {
    facts.push(...rows.map(rowLine));
    if (counted.total > rows.length) facts.push(`${counted.total - rows.length} more match and are not listed.`);
  }
  facts.push(`Counted from the ${query.resource === "managedDevices" ? "Intune" : "Entra"} device cache${snapshot?.refreshedAt ? ` refreshed ${snapshot.refreshedAt}` : ""}${snapshot?.partial ? "; the cache does not hold every device, so these counts cover the cached part only" : ""}.`);

  const listedFilters = query.focus ? [...query.filters, ...query.focus.filters] : query.filters;
  const listedLabel = query.focus ? `${query.scopeLabel} ${query.focus.label}` : query.scopeLabel;
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
      total: query.focus && focusCount ? focusCount.total : counted.total,
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
  const counted = store.countGraphCache({ tenantId, resource: "managedDevices", filters: [{ field: "id", op: "eq", value: query.deviceId }], listLimit: 1 });
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
    device: { name: row.name, ...(row.complianceState ? { complianceState: row.complianceState } : {}), ...(lastSyncDate ? { lastSyncDate } : {}) },
  };
}

function capitalize(text: string): string {
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsNumber(answer: string, value: number): boolean {
  return new RegExp(`(?<![\\d.,])${value}(?![\\d.,]\\d)`).test(answer);
}

/** A label and its count close together, in either order: "Windows 5", "5 Windows", "Windows: 5", "Windows | 5". */
function mentionsCount(answer: string, label: string, count: number): boolean {
  const name = escapeRegExp(label);
  const gap = "[^\\n\\d]{0,24}?";
  return new RegExp(`\\b${name}\\b${gap}(?<![\\d.])${count}(?![\\d])|(?<![\\d.])${count}(?![\\d])${gap}\\b${name}\\b`, "i").test(answer);
}

/**
 * The facts an answer leaves out or contradicts. A local model that wrote
 * 3 where 6 devices matched, or skipped the per OS split, gets its answer
 * replaced by the computed one.
 */
export function missingComputedFacts(answer: string, result: ComputedResult): string[] {
  const missing: string[] = [];
  if (result.kind === "device-detail") {
    if (!/\b(not (?:in|included in|part of|available in|held in|contained in|recorded in) the (?:cached |local )?(?:data|cache)|(?:cache|cached data|data) does(?: not|n't) (?:include|hold|contain|show|say|record)|not cached|isn'?t cached|no (?:cached )?(?:data|record) (?:of|on|about) (?:which|the failing))/i.test(answer)) missing.push("that the failing rule is not in the cached data");
    if (result.device?.lastSyncDate && !answer.includes(result.device.lastSyncDate) && !mentionsHumanDate(answer, result.device.lastSyncDate)) missing.push("the last sync date");
    return missing;
  }
  if (!(result.followUp && result.focus) && !mentionsNumber(answer, result.total)) missing.push(`the total ${result.total}`);
  for (const [field, group] of Object.entries(result.groups)) {
    for (const [value, count] of Object.entries(group)) if (!mentionsCount(answer, value, count)) missing.push(`${field} ${value} ${count}`);
  }
  if (result.focus) {
    if (!mentionsNumber(answer, result.focus.total)) missing.push(`the ${result.focus.label} count ${result.focus.total}`);
    if (result.focus.rows.length <= 25) for (const row of result.focus.rows) if (!answer.toLowerCase().includes(row.name.toLowerCase())) missing.push(row.name);
  }
  if (result.rows && result.rows.length <= 25) for (const row of result.rows) if (!answer.toLowerCase().includes(row.name.toLowerCase())) missing.push(row.name);
  return missing;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function mentionsHumanDate(answer: string, isoDate: string): boolean {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return false;
  const name = MONTHS[month - 1]!;
  const short = name.slice(0, 3);
  const lower = answer.toLowerCase();
  return new RegExp(`\\b(?:${name}|${short})\\.? ${day}(?:st|nd|rd|th)?,? ${year}\\b|\\b${day}(?:st|nd|rd|th)? (?:of )?(?:${name}|${short})\\.?,? ${year}\\b`).test(lower)
    || lower.includes(`${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`)
    || lower.includes(`${month}/${day}/${year}`);
}

/**
 * Structured filters for the sample rows of a device question: the OS
 * and compliance state it names, matched on fields, not as raw words.
 */
export function deviceRowFilters(question: string): GraphCacheQueryPredicate[] {
  const lower = normalize(question);
  return [osFilter(lower), complianceFocus(lower)].flatMap((entry) => (entry ? [entry.predicate] : []));
}

/** Search terms with question words removed: names and identifiers are what a text match is for. */
export const QUESTION_WORDS: ReadonlySet<string> = new Set([
  "how", "many", "much", "are", "there", "is", "was", "were", "show", "per", "which", "what", "who", "why", "when", "where",
  "not", "compliant", "noncompliant", "non-compliant", "compliance", "devices", "device", "managed", "intune", "entra",
  "list", "give", "tell", "me", "all", "the", "and", "with", "that", "this", "have", "has", "had", "does", "did", "do",
  "can", "could", "would", "should", "please", "about", "into", "their", "them", "those", "these", "only", "just",
  "count", "number", "total", "each", "every", "operating", "system", "systems", "platform", "platforms", "split",
  "breakdown", "synced", "sync", "last", "month", "week", "today", "days", "ones", "our", "my", "we", "you", "your",
  "windows", "macos", "ios", "ipados", "android", "linux", "state", "status", "tenant", "for", "from", "any", "some",
  "most", "least", "more", "less", "than", "been", "being", "still", "also", "both", "them", "they", "its", "it's",
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

/** The read-only calls the host runs for a local model before its first turn, so the counts are traced. */
export function hostCallsForQuery(query: StructuredQuery): Array<{ tool: "count_cached"; params: Record<string, unknown> }> {
  if (query.kind === "device-detail") {
    return [{ tool: "count_cached", params: { resource: "managedDevices", filters: [{ field: "id", op: "eq", value: query.deviceId }], list: true } }];
  }
  const calls: Array<{ tool: "count_cached"; params: Record<string, unknown> }> = [];
  if (!query.focus || query.breakdown.length > 0 || !query.followUp) {
    calls.push({ tool: "count_cached", params: { resource: query.resource, ...(query.filters.length ? { filters: query.filters } : {}), ...(query.breakdown.length ? { groupBy: query.breakdown } : {}), ...(query.list && !query.focus ? { list: true } : {}) } });
  }
  if (query.focus) {
    calls.push({ tool: "count_cached", params: { resource: query.resource, filters: [...query.filters, ...query.focus.filters], ...(query.resource === "managedDevices" ? { groupBy: ["operatingSystem"] } : {}), list: true } });
  }
  return calls;
}

/** The stored follow-up context of a conversation, when it belongs to this tenant. */
export function readChatResultContext(store: IntelligenceSqliteStore, conversationId: string, tenantId: string): ChatResultContext | undefined {
  const value = store.getChatResultContext(conversationId) as Partial<ChatResultContext> | undefined;
  if (!value || value.version !== 1 || value.tenantId !== tenantId || typeof value.question !== "string" || typeof value.label !== "string" || !Array.isArray(value.filters)) return undefined;
  if (value.resource !== "managedDevices" && value.resource !== "entraDevices") return undefined;
  return value as ChatResultContext;
}

/** The context the next question narrows: this answer's computed result, or none. */
export function chatResultContextFor(result: ComputedResult | undefined, input: { tenantId: string; question: string; computedAt: string }): ChatResultContext | undefined {
  if (!result) return undefined;
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

/** What a replaced answer's notice says. */
export const COMPUTED_ANSWER_NOTICE = "The local model's answer did not match the counts computed from cached data, so the computed result is shown instead.";

/**
 * Keeps a local model's answer when it states the computed facts, and
 * replaces it with the computed answer when it leaves any out.
 */
export function reconcileWithComputed(answer: string, result: ComputedResult | undefined): { answer: string; replaced: boolean } {
  if (!result || !answer.trim()) return { answer, replaced: false };
  return missingComputedFacts(answer, result).length === 0
    ? { answer, replaced: false }
    : { answer: computedAnswerText(result), replaced: true };
}
