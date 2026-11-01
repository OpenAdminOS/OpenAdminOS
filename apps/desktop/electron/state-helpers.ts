import { createHash } from "node:crypto";
import { TENANT_DATA_INSTRUCTIONS } from "@openadminos/runtime";
import { graphAccessDenialFromError, graphAccessDenialText, type GraphAccessDenial } from "@openadminos/agent-sdk";
import type {
  GraphCacheRefreshResourceResult,
  GraphCacheResourceKind,
  GraphCacheResourceStatus,
  GraphCacheStatus,
  IntuneChatConversation,
  IntuneChatMessage,
  IntuneChatToolTraceEntry,
  IntuneChatProgressStep,
  MultiTenantChatJob,
  MultiTenantDeviceRow,
  MultiTenantTenantComparison,
  ProviderId,
  RegistryAgentSummary,
  RunGraphApi,
  RunLlmApi,
  RunRecord,
  SelfTrainingSuggestion,
  TenantGroup,
  TenantReadinessStatus,
  TenantRecord,
  TenantScope,
  TenantScopePreflight,
  TenantSession,
} from "@openadminos/agent-sdk";
import type { RegistryIndexEntry } from "./registry-client.js";
import type { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import {
  GRAPH_CACHE_RESOURCES,
  buildAnswerPack,
  chatTitleForPrompt,
  definitionForResource,
  pathForResource,
  staleManagedDeviceSyncThresholdDays,
  thresholdIsoDaysBefore,
} from "./intune-chat/planner.js";
import { withAgentCompatibility } from "./agent-draft-helpers.js";



/**
 * Default stats aggregator URL. Constructor option `statsApiUrl` wins;
 * env var `OPENAGENTS_STATS_API` is the next fallback; otherwise the
 * official deployment URL. An empty string disables the POST entirely
 * Installs still complete locally, the count just doesn't flow to
 * the public stats file. main.ts passes `""` in dev so we don't
 * report dev installs to production.
 */
export const DEFAULT_STATS_API_URL = "https://openadminos.com";



export function entryToRegistrySummary(
  entry: RegistryIndexEntry,
  appVersion: string,
): RegistryAgentSummary {
  return withAgentCompatibility({
    id: entry.id,
    slug: entry.slug,
    registryId: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    mode: entry.mode,
    category: entry.category as RegistryAgentSummary["category"],
    tier: entry.tier,
    requiresEntraTier: entry.requiresEntraTier ?? "free",
    scopes: entry.scopes,
    author: entry.author,
    manifestUrl: entry.manifestUrl,
    manifestSha256: entry.manifestSha256,
    minAppVersion: entry.minAppVersion,
    execution: entry.execution,
    connectors: entry.connectors,
    ...(entry.writeLimits ? { writeLimits: entry.writeLimits } : {}),
  }, appVersion);
}



export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}



export function humanizeScheduledRunError(message: string, accessDenial?: GraphAccessDenial): string {
  const raw = message.trim();
  const lower = raw.toLowerCase();
  if (accessDenial) return graphAccessDenialText(accessDenial);
  const unknownDenial = graphAccessDenialFromError(raw);
  if (unknownDenial) return graphAccessDenialText(unknownDenial);
  if (lower.includes("graph request failed") && lower.includes("fetch failed")) {
    return "Microsoft Graph request failed. Check network or VPN connectivity, then rerun the schedule.";
  }
  if (lower.includes("graph request failed") && (lower.includes("401") || lower.includes("unauthorized"))) {
    return "Microsoft Graph rejected the request because the tenant sign-in expired. Reconnect the tenant, then rerun the schedule.";
  }
  if (lower.includes("no active tenant") || lower.includes("tenant required")) {
    return "No active tenant is available. Connect a tenant before scheduled runs can start.";
  }
  if (raw.length > 180) {
    return `${raw.slice(0, 177)}...`;
  }
  return raw || "Scheduled run failed.";
}



/**
 * MSAL's interactive flow throws raw library errors whose messages are
 * accurate but unfriendly ("AADSTS500113: No reply address was found"…).
 * Map the common ones to plain English; fall back to the original message
 * so we never hide signal.
 */
export function humanizeMsalError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (error instanceof Error && error.name === "TenantConnectCancelledError") {
    return "Sign-in was cancelled. Nothing was connected.";
  }
  if (error instanceof Error && error.name === "TenantConnectTimeoutError") {
    return "Microsoft sign-in timed out after five minutes. Start again when you are ready.";
  }
  if (lower.includes("user_cancelled") || lower.includes("cancelled by user")) {
    return "Sign-in was cancelled in the browser. Try again from Settings → Tenants.";
  }
  if (lower.includes("aadsts50105") || lower.includes("assigned to a role")) {
    return "The account isn't assigned to access Microsoft Graph CLI for this tenant. Ask a tenant admin to grant access, or sign in with a different account.";
  }
  if (
    lower.includes("aadsts65001") ||
    lower.includes("consent") ||
    lower.includes("requires admin")
  ) {
    return "Admin consent is required for the Microsoft Graph CLI in this tenant. Have a Global Administrator approve the app, then try again.";
  }
  if (lower.includes("aadsts50020") || lower.includes("user account") || lower.includes("not exist")) {
    return "That account doesn't exist in this tenant. Pick a directory account during sign-in instead of a personal Microsoft account.";
  }
  if (
    lower.includes("aadsts700016") ||
    lower.includes("aadsts900023") ||
    lower.includes("not found in the directory")
  ) {
    return "Microsoft rejected the sign-in because the tenant doesn't recognise our app id. This can happen if Conditional Access blocks the Microsoft Graph CLI; check with your security team.";
  }
  if (
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed")
  ) {
    return "Couldn't reach Microsoft's sign-in endpoint. Check your internet connection (proxy / VPN / DNS) and try again.";
  }
  if (lower.includes("interaction_required") || lower.includes("invalid_grant")) {
    return "The previous sign-in session expired. Reconnect from Settings → Tenants and complete the consent prompt.";
  }
  if (
    lower.includes("secure storage") ||
    lower.includes("secret service keyring") ||
    lower.includes("basic_text")
  ) {
    return raw;
  }
  // Fall back to the raw message so debugging is still possible.
  return `Sign-in failed: ${raw}`;
}



export function runNotificationTitle(run: RunRecord): string {
  if (run.status === "planned") return "Dry run: not applied";
  if (run.status === "completed") return run.trigger === "schedule" ? "Scheduled agent run completed" : "Agent run completed";
  if (run.status === "failed") return run.trigger === "schedule" ? "Scheduled agent run failed" : "Agent run failed";
  return run.status === "cancelled" ? "Agent run cancelled" : "Agent run rejected";
}

export function isTerminalRunStatus(status: RunRecord["status"]): boolean {
  return (
    status === "planned" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rejected"
  );
}



export function trimForPrompt(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 32)).trimEnd()}\n[truncated locally]`;
}



export function createLocalOnlyTenantSession(): TenantSession {
  return {
    tenantId: "local-device",
    username: "local-device",
    async acquireTokenForScopes(_scopes: string[]): Promise<string> {
      throw new Error(
        "This connector is not running with an active Microsoft 365 tenant session.",
      );
    },
  };
}



export function sanitizeGraphResources(
  resources: GraphCacheResourceKind[] | undefined,
): GraphCacheResourceKind[] {
  const allowed = new Set(GRAPH_CACHE_RESOURCES.map((entry) => entry.resource));
  const selected = (resources && resources.length > 0
    ? resources
    : GRAPH_CACHE_RESOURCES.map((entry) => entry.resource)
  ).filter((resource): resource is GraphCacheResourceKind => allowed.has(resource));
  return [...new Set(selected)];
}



export function tenantNamesById(tenants: TenantRecord[]): Map<string, string> {
  return new Map(tenants.map((tenant) => [tenant.id, tenant.displayName]));
}



export function normalizeTenantGroupName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("Tenant group name is required.");
  if (trimmed.length > 80) throw new Error("Tenant group name is too long.");
  return trimmed;
}



export function normalizeWorkspaceTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("Workspace title is required.");
  if (trimmed.length > 140) throw new Error("Workspace title is too long.");
  return trimmed;
}



export function normalizeWorkspaceInstructions(instructions: string): string {
  const trimmed = instructions.trim();
  if (trimmed.length > 10_000) {
    throw new Error("Workspace instructions are too long.");
  }
  return trimmed;
}



export function resolveTenantGroups(scope: TenantScope, groups: TenantGroup[]): TenantGroup[] {
  const groupIds = new Set(
    scope.kind === "selected" || scope.kind === "all" ? scope.groupIds ?? [] : [],
  );
  return groups.filter((group) => groupIds.has(group.id));
}



export function resolveTenantScopeIds(input: {
  scope: TenantScope;
  groups: TenantGroup[];
  tenants: TenantRecord[];
  activeTenantId?: string;
}): string[] {
  const known = new Set(input.tenants.map((tenant) => tenant.id));
  if (input.scope.kind === "all") {
    return input.tenants.map((tenant) => tenant.id);
  }
  const selected = new Set<string>();
  if (input.scope.kind === "active") {
    if (input.activeTenantId && known.has(input.activeTenantId)) {
      selected.add(input.activeTenantId);
    }
  } else {
    for (const tenantId of input.scope.tenantIds) {
      if (!known.has(tenantId)) throw new Error(`Unknown tenant selected: ${tenantId}`);
      selected.add(tenantId);
    }
  }
  for (const group of input.groups) {
    for (const tenantId of group.tenantIds) {
      if (known.has(tenantId)) selected.add(tenantId);
    }
  }
  return [...selected];
}



export function isWindowsCompliancePrompt(prompt: string): boolean {
  return /\b(windows|device|devices|compliant|non-?compliant|compliance)\b/i.test(prompt);
}



export function isGraphCacheStatusStale(status: GraphCacheResourceStatus): boolean {
  // Match the single-tenant send path: errored resources are retried,
  // and staleness follows the per-resource TTL, not a flat 6h rule that
  // contradicted host policy for fast and slow resources alike.
  if (status.lastError) return true;
  if (!status.refreshedAt || status.rows === 0) return true;
  const refreshedMs = Date.parse(status.refreshedAt);
  if (!Number.isFinite(refreshedMs)) return true;
  return Date.now() - refreshedMs > resourceStalenessMs(status.resource);
}



export function newestRefreshedAt(statuses: GraphCacheResourceStatus[]): string | undefined {
  return statuses
    .map((status) => status.refreshedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}



export function tenantReadinessStatus(input: {
  missingScopes: string[];
  staleResources: GraphCacheResourceKind[];
  errors: string[];
  hasRows: boolean;
}): TenantReadinessStatus {
  if (input.missingScopes.length > 0) return "missing-scopes";
  if (input.errors.some((error) => /throttl|429|too many requests/i.test(error))) {
    return "throttled";
  }
  if (input.errors.some((error) => /expired|interaction required|login/i.test(error))) {
    return "expired";
  }
  if (input.errors.length > 0 && !input.hasRows) return "failed";
  if (input.staleResources.length > 0 || !input.hasRows) return "stale";
  return "ready";
}



export function readinessWarnings(input: {
  status: TenantReadinessStatus;
  staleResources: GraphCacheResourceKind[];
  errors: string[];
}): string[] {
  const warnings: string[] = [];
  if (input.status === "stale") {
    warnings.push(
      input.staleResources.length > 0
        ? `${input.staleResources.length} resource cache needs refresh.`
        : "No local cache rows yet.",
    );
  }
  if (input.errors.length > 0) warnings.push(input.errors[0]!);
  return warnings;
}



export function readinessRecovery(status: TenantReadinessStatus, accessDenials: GraphAccessDenial[] = []): string {
  if (accessDenials.length > 0) return [...new Set(accessDenials.map(denial => denial.recovery))].join(" ");
  const copy: Record<TenantReadinessStatus, string> = {
    ready: "Ready to run.",
    stale: "Run can refresh cache before answering.",
    expired: "Reconnect this tenant before including it.",
    "missing-scopes": "Review the access error to check consent, active roles, and tenant licences before retrying.",
    throttled: "Wait for Microsoft Graph throttling to clear or remove this tenant.",
    skipped: "Tenant is skipped for this run.",
    failed: "Review the cached error or remove this tenant from the run.",
  };
  return copy[status];
}



export function emptyMultiTenantSummary(): MultiTenantChatJob["summary"] {
  return {
    tenantsScanned: 0,
    failedTenants: 0,
    skippedTenants: 0,
    staleTenants: 0,
    windowsDevices: 0,
    compliant: 0,
    nonCompliant: 0,
    unknown: 0,
  };
}



export function updateJobTenantProgress(
  job: MultiTenantChatJob,
  tenantId: string,
  patch: Partial<MultiTenantChatJob["progress"][number]>,
): MultiTenantChatJob {
  return {
    ...job,
    progress: job.progress.map((entry) =>
      entry.tenantId === tenantId ? { ...entry, ...patch } : entry,
    ),
    updatedAt: new Date().toISOString(),
  };
}



export async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(workers);
}



export function normalizeMultiTenantDeviceRow(input: {
  row: unknown;
  tenantId: string;
  tenantName: string;
  sourceRefreshedAt?: string;
}): MultiTenantDeviceRow | undefined {
  if (!isRecord(input.row)) return undefined;
  const deviceName = stringValue(input.row.deviceName) ?? stringValue(input.row.displayName);
  const operatingSystem = stringValue(input.row.operatingSystem) ?? "Unknown";
  if (!deviceName) return undefined;
  const lastSyncDateTime = stringValue(input.row.lastSyncDateTime);
  const stale = lastSyncDateTime
    ? Date.now() - Date.parse(lastSyncDateTime) > 7 * 24 * 60 * 60 * 1000
    : true;
  return {
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    deviceId: stringValue(input.row.id),
    deviceName,
    complianceState:
      stringValue(input.row.complianceState) ??
      stringValue(input.row.complianceStatus) ??
      "unknown",
    operatingSystem,
    osVersion: stringValue(input.row.osVersion),
    lastSyncDateTime,
    owner:
      stringValue(input.row.userPrincipalName) ??
      stringValue(input.row.emailAddress) ??
      stringValue(input.row.owner),
    sourceRefreshedAt: input.sourceRefreshedAt,
    stale,
  };
}



export function buildTenantComparison(input: {
  tenant: TenantScopePreflight["tenants"][number];
  rows: MultiTenantDeviceRow[];
}): MultiTenantTenantComparison {
  let compliant = 0;
  let nonCompliant = 0;
  let unknown = 0;
  for (const row of input.rows) {
    const state = normalizeComplianceState(row.complianceState);
    if (state === "compliant") compliant += 1;
    else if (state === "non-compliant") nonCompliant += 1;
    else unknown += 1;
  }
  return {
    tenantId: input.tenant.tenantId,
    tenantName: input.tenant.tenantName,
    status: input.tenant.status === "stale" ? "stale" : "ready",
    windowsDevices: input.rows.length,
    compliant,
    nonCompliant,
    unknown,
    lastRefresh: newestString(input.rows.map((row) => row.sourceRefreshedAt)),
    warnings: input.tenant.warnings,
  };
}



export function normalizeComplianceState(value: string): "compliant" | "non-compliant" | "unknown" {
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "compliant") return "compliant";
  if (normalized === "noncompliant" || normalized === "non-compliant") {
    return "non-compliant";
  }
  return "unknown";
}



export function buildMultiTenantSummary(
  comparisons: MultiTenantTenantComparison[],
): MultiTenantChatJob["summary"] {
  return comparisons.reduce(
    (summary, tenant) => ({
      tenantsScanned: summary.tenantsScanned + 1,
      failedTenants:
        summary.failedTenants +
        (["failed", "expired", "missing-scopes", "throttled"].includes(tenant.status)
          ? 1
          : 0),
      skippedTenants: summary.skippedTenants + (tenant.status === "skipped" ? 1 : 0),
      staleTenants: summary.staleTenants + (tenant.status === "stale" ? 1 : 0),
      windowsDevices: summary.windowsDevices + tenant.windowsDevices,
      compliant: summary.compliant + tenant.compliant,
      nonCompliant: summary.nonCompliant + tenant.nonCompliant,
      unknown: summary.unknown + tenant.unknown,
    }),
    emptyMultiTenantSummary(),
  );
}



export function buildMultiTenantDossierMarkdown(input: {
  prompt: string;
  providerName: string;
  model?: string;
  generatedAt: string;
  summary: MultiTenantChatJob["summary"];
  comparisons: MultiTenantTenantComparison[];
  rows: MultiTenantDeviceRow[];
}): string {
  const lines = [
    "# Multi-tenant Chat dossier",
    "",
    `Generated: ${input.generatedAt}`,
    `Provider: ${input.providerName}${input.model ? ` · ${input.model}` : ""}`,
    `Query: ${input.prompt}`,
    "",
    "## Summary",
    "",
    `- Tenants scanned: ${input.summary.tenantsScanned}`,
    `- Failed tenants: ${input.summary.failedTenants}`,
    `- Stale tenants: ${input.summary.staleTenants}`,
    `- Windows devices: ${input.summary.windowsDevices}`,
    `- Compliant: ${input.summary.compliant}`,
    `- Non-compliant: ${input.summary.nonCompliant}`,
    `- Unknown: ${input.summary.unknown}`,
    "",
    "## Tenant Comparison",
    "",
    "| Tenant | Status | Windows | Compliant | Non-compliant | Unknown | Last refresh |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const tenant of input.comparisons) {
    lines.push(
      `| ${tenant.tenantName} | ${tenant.status} | ${tenant.windowsDevices} | ${tenant.compliant} | ${tenant.nonCompliant} | ${tenant.unknown} | ${tenant.lastRefresh ?? "unknown"} |`,
    );
  }
  lines.push("", "## Device Rows", "");
  lines.push("| Tenant | Device | Compliance | OS | OS version | Last sync | Owner |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of input.rows) {
    lines.push(
      `| ${row.tenantName} | ${row.deviceName} | ${row.complianceState} | ${row.operatingSystem} | ${row.osVersion ?? ""} | ${row.lastSyncDateTime ?? ""} | ${row.owner ?? ""} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}



export function summarizeMultiTenantResult(
  summary: MultiTenantChatJob["summary"],
  comparisons: MultiTenantTenantComparison[],
): string {
  const caveats = comparisons
    .filter((tenant) => tenant.status !== "ready")
    .map((tenant) => `${tenant.tenantName}: ${tenant.status}`);
  const caveatText =
    caveats.length > 0
      ? ` Caveats: ${caveats.join("; ")}.`
      : " No tenant failures were recorded.";
  return `Across ${summary.tenantsScanned} tenant${summary.tenantsScanned === 1 ? "" : "s"}, cached Intune data shows ${summary.windowsDevices} Windows devices: ${summary.compliant} compliant, ${summary.nonCompliant} non-compliant, and ${summary.unknown} unknown.${caveatText}`;
}



/**
 * Read/mutation access to an existing conversation. Multi-tenant result
 * conversations stay readable; single-tenant conversations require the
 * owning tenant to be active. Legacy rows without a tenant pass, the
 * same tolerance assertConversationTenant applies to follow-up sends.
 */
export function assertConversationAccess(
  conversation: IntuneChatConversation,
  activeTenantId: string | undefined,
): void {
  if (conversation.scopeKind === "multi-tenant") return;
  if (!conversation.tenantId) return;
  if (conversation.tenantId !== activeTenantId) {
    throw new Error(
      "This conversation belongs to a different tenant. Switch to that tenant or start a new conversation.",
    );
  }
}



export function assertConversationTenant(
  conversation: IntuneChatConversation,
  activeTenantId: string,
): void {
  if (conversation.scopeKind === "multi-tenant") {
    throw new Error(
      "This is a multi-tenant result conversation. Start a new active-tenant conversation for follow-up prompts.",
    );
  }
  if (conversation.tenantId && conversation.tenantId !== activeTenantId) {
    throw new Error(
      "This conversation belongs to a different tenant. Switch to that tenant or start a new conversation.",
    );
  }
}



export function newestString(values: (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}



export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}



export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}



export function readPlannedChatRows(
  store: IntelligenceSqliteStore,
  input: {
    tenantId: string;
    question: string;
    generatedAt: string;
    resources: GraphCacheResourceKind[];
    searchTerms: string[];
    limitPerResource: number;
  },
): Record<GraphCacheResourceKind, unknown[]> {
  const rows = store.readGraphRows({
    tenantId: input.tenantId,
    resources: input.resources,
    searchTerms: input.searchTerms,
    limitPerResource: input.limitPerResource,
  });
  const staleSyncDays = staleManagedDeviceSyncThresholdDays(input.question);
  if (staleSyncDays !== undefined && input.resources.includes("managedDevices")) {
    rows.managedDevices = store.readManagedDevicesLastSyncBefore({
      tenantId: input.tenantId,
      thresholdIso: thresholdIsoDaysBefore(input.generatedAt, staleSyncDays),
      limit: input.limitPerResource,
    });
  }
  return rows;
}



export const GRAPH_CACHE_PAGE_LIMIT = 10;


/**
 * How many resources refresh at once. Graph throttles per resource
 * unit, so a handful of different resources in flight together stays
 * well inside normal limits while removing most of the wait before an
 * answer can start.
 */
export const GRAPH_REFRESH_CONCURRENCY = 4;


/**
 * Directory resources that support `$count=true` with
 * `ConsistencyLevel: eventual`. Asking for the count returns the true
 * tenant-wide total in the same request, which is the only way to
 * answer "how many" correctly once a collection exceeds the cache row
 * limit. Intune resources are deliberately excluded: `$count` is not
 * supported across `/deviceManagement`, and sending it there fails the
 * whole request.
 */
/**
 * How long a cached resource stays usable before a question triggers a
 * refresh. A single six-hour rule was wrong in both directions: sign-in
 * and audit data is stale within minutes, while Autopilot profiles and
 * enrollment configurations change a few times a year and were being
 * re-fetched needlessly.
 */
const RESOURCE_STALENESS_MS: Readonly<Record<string, number>> = {
  signIns: 15 * 60 * 1000,
  directoryAudits: 15 * 60 * 1000,
  intuneAuditEvents: 15 * 60 * 1000,
  securityAlerts: 15 * 60 * 1000,
  securityIncidents: 15 * 60 * 1000,
  troubleshootingEvents: 30 * 60 * 1000,
  autopilotEvents: 30 * 60 * 1000,
  managedDevices: 6 * 60 * 60 * 1000,
  entraDevices: 6 * 60 * 60 * 1000,
  users: 6 * 60 * 60 * 1000,
  groups: 6 * 60 * 60 * 1000,
  detectedApps: 12 * 60 * 60 * 1000,
  managedDeviceEncryptionStates: 12 * 60 * 60 * 1000,
  secureScores: 12 * 60 * 60 * 1000,
};

/** Resources not listed above change rarely; a day is plenty. */
export const DEFAULT_RESOURCE_STALENESS_MS = 24 * 60 * 60 * 1000;

export function resourceStalenessMs(resource: string): number {
  return RESOURCE_STALENESS_MS[resource] ?? DEFAULT_RESOURCE_STALENESS_MS;
}


export const COUNTABLE_GRAPH_RESOURCES: ReadonlySet<string> = new Set([
  "users",
  "groups",
  "entraDevices",
  "applications",
  "servicePrincipals",
  "administrativeUnits",
]);


export const GRAPH_CACHE_ROW_LIMIT = 1000;



export interface GraphCacheRequestPage {
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}



export interface GraphCollectionPage {
  rows: unknown[];
  nextLink?: string;
  /** `@odata.count` when the request asked for it. */
  totalCount?: number;
}



export async function fetchGraphCachePages(
  graph: RunGraphApi,
  request: GraphCacheRequestPage,
  signal?: AbortSignal,
  complete = false,
): Promise<{
  rows: unknown[];
  pages: number;
  pageLimitReached: boolean;
  totalCount?: number;
}> {
  const rows: unknown[] = [];
  let totalCount: number | undefined;
  let pages = 0;
  let nextRequest: GraphCacheRequestPage | undefined = request;
  let pendingNextLink: string | undefined;
  let truncated = false;
  let bytes = 0;
  const seenLinks = new Set<string>();
  const seenIds = new Set<string>();

  while (
    nextRequest &&
    (complete || pages < GRAPH_CACHE_PAGE_LIMIT) &&
    (complete || rows.length < GRAPH_CACHE_ROW_LIMIT)
  ) {
    signal?.throwIfAborted();
    const response = await graph.request({
      method: "GET",
      path: nextRequest.path,
      ...(nextRequest.query && Object.keys(nextRequest.query).length > 0
        ? { query: nextRequest.query }
        : {}),
      ...(nextRequest.headers ? { headers: nextRequest.headers } : {}),
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    const page = unwrapGraphCollectionPage(response);
    if (totalCount === undefined && page.totalCount !== undefined) {
      totalCount = page.totalCount;
    }
    pages += 1;
    const remainingRows = complete
      ? page.rows.length
      : GRAPH_CACHE_ROW_LIMIT - rows.length;
    truncated ||= page.rows.length > remainingRows;
    for (const row of page.rows.slice(0, remainingRows)) {
      const id =
        row && typeof row === "object" && "id" in row
          ? String(row.id)
          : undefined;
      if (complete && id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      bytes += Buffer.byteLength(JSON.stringify(row));
      if (complete && bytes > 128 * 1024 * 1024)
        throw new Error(
          "This resource exceeds the 128 MiB refresh memory limit. The previous snapshot was kept. Reduce the selected scope or contact support.",
        );
      rows.push(row);
    }
    if (page.nextLink && seenLinks.has(page.nextLink))
      throw new Error(
        "Graph repeated a continuation link. The previous snapshot was kept. Retry the refresh.",
      );
    if (page.nextLink) seenLinks.add(page.nextLink);
    pendingNextLink = page.nextLink;
    nextRequest = page.nextLink
      ? graphCacheRequestFromNextLink(page.nextLink, request.headers)
      : undefined;
  }

  return {
    rows,
    pages,
    // A final page that overflows the row cap without advertising a
    // nextLink would otherwise be reported as complete while rows were
    // dropped, which is a silent truncation.
    pageLimitReached: Boolean(pendingNextLink) || truncated,
    ...(totalCount !== undefined ? { totalCount } : {}),
  };
}



export function graphCacheRequestFromNextLink(
  nextLink: string,
  headers: Record<string, string> | undefined,
): GraphCacheRequestPage {
  const url = new URL(nextLink);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "graph.microsoft.com") {
    throw new Error("Graph returned an unsafe cache paging URL outside graph.microsoft.com.");
  }
  if (url.pathname !== "/beta" && !url.pathname.startsWith("/beta/")) {
    throw new Error("Graph returned a cache paging URL that is not on the required beta endpoint.");
  }
  const path = url.pathname.slice("/beta".length) || "/";
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }
  return {
    path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(headers ? { headers } : {}),
  };
}



export function buildChatProgressSteps(input: {
  refreshResources: GraphCacheResourceKind[];
  refreshResults: GraphCacheRefreshResourceResult[];
  activeResource?: GraphCacheResourceKind;
  cacheCheckStatus: IntuneChatProgressStep["status"];
  contextStatus: IntuneChatProgressStep["status"];
  modelStatus: IntuneChatProgressStep["status"];
}): IntuneChatProgressStep[] {
  const resultsByResource = new Map(
    input.refreshResults.map((result) => [result.resource, result]),
  );
  const steps: IntuneChatProgressStep[] = [
    {
      id: "cache-check",
      label: "Check cached tenant data",
      status: input.cacheCheckStatus,
    },
  ];

  for (const resource of input.refreshResources) {
    const result = resultsByResource.get(resource);
    const definition = definitionForResource(resource);
    steps.push({
      id: `refresh-${resource}`,
      label: `Refresh ${definition.label}`,
      status: result
        ? result.ok
          ? "completed"
          : "failed"
        : input.activeResource === resource
          ? "active"
          : "pending",
      ...(result
        ? {
            detail: result.ok
              ? graphCacheRefreshDetail(result)
              : result.error,
          }
        : {}),
    });
  }

  steps.push(
    {
      id: "context-pack",
      label: "Build answer context",
      status: input.contextStatus,
    },
    {
      id: "model-answer",
      label: "Generate response",
      status: input.modelStatus,
    },
  );
  return steps;
}



export function graphCacheRefreshDetail(result: GraphCacheRefreshResourceResult): string {
  const rowLabel = `${result.rows.toLocaleString()} row${result.rows === 1 ? "" : "s"} cached`;
  const pageLabel =
    typeof result.pages === "number" && result.pages > 1
      ? ` across ${result.pages.toLocaleString()} pages`
      : "";
  return result.pageLimitReached
    ? `${rowLabel}${pageLabel} · capped`
    : `${rowLabel}${pageLabel}`;
}



export function estimateChatProgressPercent(steps: IntuneChatProgressStep[]): number {
  if (steps.length === 0) return 0;
  const score = steps.reduce((sum, step) => {
    if (step.status === "completed" || step.status === "failed") return sum + 1;
    if (step.status === "active") return sum + 0.45;
    return sum;
  }, 0);
  return Math.max(5, Math.min(100, Math.round((score / steps.length) * 100)));
}



export function unwrapGraphCollectionPage(response: unknown): GraphCollectionPage {
  if (Array.isArray(response)) return { rows: response };
  if (
    typeof response === "object" &&
    response !== null &&
    Array.isArray((response as { value?: unknown }).value)
  ) {
    const record = response as {
      value: unknown[];
      "@odata.nextLink"?: unknown;
      "@odata.count"?: unknown;
    };
    const count = record["@odata.count"];
    return {
      rows: record.value,
      nextLink:
        typeof record["@odata.nextLink"] === "string"
          ? record["@odata.nextLink"]
          : undefined,
      ...(typeof count === "number" && Number.isFinite(count)
        ? { totalCount: count }
        : {}),
    };
  }
  return { rows: response === undefined || response === null ? [] : [response] };
}



export interface IntuneChatProviderBudget {
  limitPerResource: number;
  maxTokens: number;
  answerPackLimits: NonNullable<Parameters<typeof buildAnswerPack>[0]["limits"]>;
}



export function intuneChatProviderBudget(providerId: ProviderId): IntuneChatProviderBudget {
  if (providerId === "apple-foundation") {
    return {
      limitPerResource: 12,
      maxTokens: 512,
      answerPackLimits: {
        profile: "apple-foundation-small-context",
        maxRowsReadPerResource: 12,
        maxSampleRowsPerResource: 6,
        maxFindingSampleRows: 6,
        maxAgentSuggestions: 2,
      },
    };
  }
  return {
    limitPerResource: 40,
    maxTokens: 900,
    answerPackLimits: {
      profile: "default",
      maxRowsReadPerResource: 40,
      maxSampleRowsPerResource: 20,
      maxFindingSampleRows: 20,
    },
  };
}



export function buildIntuneChatSystemPrompt(isLocalProvider: boolean, publicResearch = false): string {
  return [
    "You are OpenAdminOS Chat.",
    TENANT_DATA_INSTRUCTIONS,
    publicResearch
      ? "Answer tenant questions from retrieved tenant evidence and public questions from retrieved web evidence. Clearly distinguish those sources."
      : "Answer Microsoft 365 admin questions only from the retrieved tenant context supplied by the host.",
    "If the context is missing, stale, partial, or has Graph errors, say that plainly.",
    "Do not invent tenant state, counts, users, devices, policies, or remediation results.",
    "A tool returning zero rows means zero matched that query, not that the tenant has none. Never state that a tenant has none of something on the strength of an empty result; check the unfiltered count first.",
    "For any question about how many, use tenantTotal for unfiltered totals when present, otherwise the breakdown that matches the asked dimension: operatingSystem, complianceState, state, severity, securityEnabled, signInAudience, @odata.type, policyPlatform, appPlatform, platforms, or another named breakdown. Breakdowns are counted over every cached row only when breakdownsCoverAllCachedRows is true; when it is false, they describe selectedRows only, so do not quote them as tenant-wide counts. Boolean buckets may be labelled true/false or 1/0. Never count the sampleRows: they are a small illustrative subset, and counting them undercounts. Array breakdowns such as platforms and groupTypes can count one row in more than one bucket.",
    "When cachedRows is below tenantTotal, or pageLimitReached is true, say that the detail rows cover only part of the tenant.",
    "Do not perform or imply Graph writes from chat. For changes, tell the admin to run an installed write agent so confirmation remains enforced.",
    isLocalProvider
      ? publicResearch
        ? "Reasoning is local, but this hosted Nova session shares audio, answers and public research queries with OpenAI under explicit session consent."
        : "The selected provider is local; keep wording consistent with local-only trust."
      : "The selected provider is hosted; be explicit when tenant context is being used to produce the answer.",
    "Use concise admin-facing prose. No hype, no exclamation marks.",
  ].join("\n");
}



export function withSelfTrainingOverlay(base: RunLlmApi, overlay: string): RunLlmApi {
  const composeSystem = (system: string | undefined) =>
    [system, overlay].filter((part): part is string => Boolean(part)).join("\n\n");
  return {
    get available() {
      return base.available;
    },
    get defaultModel() {
      return base.defaultModel;
    },
    complete: (options) =>
      base.complete({
        ...options,
        system: composeSystem(options.system),
      }),
    async *stream(options) {
      yield* base.stream({
        ...options,
        system: composeSystem(options.system),
      });
    },
  };
}



export function stableSuggestionId(tenantId: string, agentSlug: string, text: string): string {
  return `suggestion_${createHash("sha256")
    .update(`${tenantId}:${agentSlug}:${text}`)
    .digest("hex")
    .slice(0, 24)}`;
}



export const CHAT_MEMORY_MAX_TURNS = 4;
export const CHAT_MEMORY_MAX_CHARS = 4000;
const CHAT_MEMORY_MAX_MESSAGE_CHARS = 1000;

/**
 * Bounded plain-text memory for follow-up questions. The non-voice
 * prompt used to contain only the current question, so "Show only the
 * Windows ones" after a device answer had nothing to refer to. The
 * window is the last {@link CHAT_MEMORY_MAX_TURNS} completed turns,
 * each message truncated, under one hard character cap; older turns
 * drop first. Voice has its own tighter context builder.
 */
export function boundedConversationMemory(
  messages: readonly IntuneChatMessage[],
): string | undefined {
  // Build turns first. Filtering messages individually kept the user
  // prompts of failed or cancelled exchanges (user rows stay
  // "completed"), so eight abandoned prompts could ride along under a
  // four-turn policy. Only exchanges whose assistant reply completed
  // count as memory.
  const turns: string[] = [];
  const format = (message: IntuneChatMessage): string => {
    const text = message.content.trim();
    const bounded = text.length > CHAT_MEMORY_MAX_MESSAGE_CHARS
      ? `${text.slice(0, CHAT_MEMORY_MAX_MESSAGE_CHARS)} [truncated]`
      : text;
    return `${message.role === "user" ? "User" : "Assistant"}: ${bounded}`;
  };
  for (let index = 0; index < messages.length; index += 1) {
    const user = messages[index]!;
    if (user.role !== "user" || user.status !== "completed" || !user.content.trim()) continue;
    const assistant = messages[index + 1];
    if (
      !assistant ||
      assistant.role !== "assistant" ||
      assistant.status !== "completed" ||
      !assistant.content.trim()
    ) {
      continue;
    }
    turns.push(`${format(user)}\n${format(assistant)}`);
    index += 1;
  }
  const windowed = turns.slice(-CHAT_MEMORY_MAX_TURNS);
  while (windowed.length > 1 && windowed.join("\n").length > CHAT_MEMORY_MAX_CHARS) {
    windowed.shift();
  }
  if (windowed.length === 0) return undefined;
  const joined = windowed.join("\n");
  return joined.length > CHAT_MEMORY_MAX_CHARS
    ? joined.slice(joined.length - CHAT_MEMORY_MAX_CHARS)
    : joined;
}

/**
 * Resources an investigation actually read, derived from successful tool
 * trace entries. Sources must describe what ran, not what was planned:
 * a refusal that never touched tenant data must not carry source badges,
 * and a resource fetched mid-investigation must appear even when the
 * planner never named it.
 */
export function resourcesFromToolTrace(
  toolTrace: readonly IntuneChatToolTraceEntry[] | undefined,
): Set<GraphCacheResourceKind> {
  const known = new Set<GraphCacheResourceKind>(
    GRAPH_CACHE_RESOURCES.map((entry) => entry.resource),
  );
  const resources = new Set<GraphCacheResourceKind>();
  for (const entry of toolTrace ?? []) {
    if (entry.error) continue;
    const params = (entry.params ?? {}) as Record<string, unknown>;
    if (
      entry.tool === "query_cache" ||
      entry.tool === "refresh_resource" ||
      entry.tool === "query_drift"
    ) {
      const resource = params.resource;
      if (typeof resource === "string" && known.has(resource as GraphCacheResourceKind)) {
        resources.add(resource as GraphCacheResourceKind);
      }
      continue;
    }
    if (entry.tool === "graph_get") {
      // Prefer the normalized execution path: params.path is the raw
      // model-supplied value and can be a full URL or slashless.
      const path = entry.graphSource?.path ?? (typeof params.path === "string" ? params.path : undefined);
      const resource = path ? graphResourceForPath(path) : undefined;
      if (resource) resources.add(resource);
    }
  }
  return resources;
}

/** Map a live Graph path back to its cache resource by longest known base path. */
function graphResourceForPath(path: string): GraphCacheResourceKind | undefined {
  let best: GraphCacheResourceKind | undefined;
  let bestLength = -1;
  for (const definition of GRAPH_CACHE_RESOURCES) {
    const base = pathForResource(definition.resource).path;
    if ((path === base || path.startsWith(`${base}/`)) && base.length > bestLength) {
      best = definition.resource;
      bestLength = base.length;
    }
  }
  return best;
}

/** Resources the refresh_resource tool successfully refreshed mid-investigation. */
export function toolRefreshedResources(
  toolTrace: readonly IntuneChatToolTraceEntry[] | undefined,
): Set<GraphCacheResourceKind> {
  const known = new Set<GraphCacheResourceKind>(
    GRAPH_CACHE_RESOURCES.map((entry) => entry.resource),
  );
  const resources = new Set<GraphCacheResourceKind>();
  for (const entry of toolTrace ?? []) {
    if (entry.tool !== "refresh_resource" || entry.error) continue;
    const resource = (entry.params as Record<string, unknown> | undefined)?.resource;
    if (typeof resource === "string" && known.has(resource as GraphCacheResourceKind)) {
      resources.add(resource as GraphCacheResourceKind);
    }
  }
  return resources;
}

/**
 * Which resources an answer may claim as sources. Returns undefined to
 * mean "the planned resources", which is honest only when the answer
 * pack was built from them (deterministic path) or the model read the
 * full cache inventory. An empty set means no tenant sources at all.
 */
export function executedResourcesForAnswer(input: {
  toolTrace?: readonly IntuneChatToolTraceEntry[];
  usedDeterministic: boolean;
  usedNoData: boolean;
}): Set<GraphCacheResourceKind> | undefined {
  if (input.usedNoData) return new Set();
  if (input.usedDeterministic) return undefined;
  if (!input.toolTrace || input.toolTrace.length === 0) return undefined;
  const executed = resourcesFromToolTrace(input.toolTrace);
  if (executed.size > 0) return executed;
  const readInventory = input.toolTrace.some(
    (entry) => entry.tool === "list_cached_resources" && !entry.error,
  );
  return readInventory ? undefined : new Set();
}

export function buildIntuneChatSources(input: {
  cacheStatus: GraphCacheStatus["resources"];
  plannedResources: GraphCacheResourceKind[];
  /**
   * When provided, sources are limited to what actually ran. An empty
   * set deliberately yields no sources (refusals, write blocks). Omit
   * only on the deterministic path, where the answer pack is built from
   * the planned resources themselves.
   */
  executedResources?: Iterable<GraphCacheResourceKind>;
  /**
   * Execution trace. A resource read live through `graph_get` is
   * described from that execution (rows returned, pages fetched,
   * truncation, completion time), never from the cache snapshot that
   * happens to share its resource kind.
   */
  toolTrace?: readonly IntuneChatToolTraceEntry[];
  refreshedResources: Set<GraphCacheResourceKind>;
}): NonNullable<IntuneChatMessage["sources"]> {
  const visible = input.executedResources
    ? new Set(input.executedResources)
    : new Set(input.plannedResources);
  // Live execution provenance describes investigative answers only.
  // A deterministic fallback answered from its snapshot pack, so
  // letting the abandoned investigation's live read override its
  // sources misstates what the fallback actually used.
  const liveGraphByResource = new Map<GraphCacheResourceKind, IntuneChatToolTraceEntry[]>();
  const cacheReadsByResource = new Map<
    GraphCacheResourceKind,
    Array<NonNullable<IntuneChatToolTraceEntry["cacheSource"]>>
  >();
  const knownResources = new Set(GRAPH_CACHE_RESOURCES.map((entry) => entry.resource));
  for (const entry of input.executedResources ? input.toolTrace ?? [] : []) {
    if (entry.error) continue;
    if (entry.cacheSource && knownResources.has(entry.cacheSource.resource as GraphCacheResourceKind)) {
      const resource = entry.cacheSource.resource as GraphCacheResourceKind;
      const reads = cacheReadsByResource.get(resource) ?? [];
      // Repeated reads of the same snapshot are one piece of
      // evidence; a read before and after a refresh are two. A later
      // read of the same snapshot can still add a warning the first
      // read did not have (the refresh between them failed), so merge
      // it instead of discarding the read outright.
      const duplicateIndex = reads.findIndex(
        (read) =>
          read.refreshedAt === entry.cacheSource!.refreshedAt &&
          read.rows === entry.cacheSource!.rows,
      );
      if (duplicateIndex === -1) {
        reads.push(entry.cacheSource);
      } else if (entry.cacheSource.error && !reads[duplicateIndex]!.error) {
        reads[duplicateIndex] = { ...reads[duplicateIndex]!, error: entry.cacheSource.error };
      }
      cacheReadsByResource.set(resource, reads);
      continue;
    }
    if (entry.tool !== "graph_get" || !entry.graphSource) continue;
    const resource = graphResourceForPath(entry.graphSource.path);
    if (resource) {
      const entries = liveGraphByResource.get(resource) ?? [];
      entries.push(entry);
      liveGraphByResource.set(resource, entries);
    }
  }
  return input.cacheStatus
    .filter((status) => visible.has(status.resource))
    .flatMap((status) => {
      const request = pathForResource(status.resource);
      const cacheEntry = {
        resource: status.resource,
        label: status.label,
        rows: status.rows,
        pages: status.pages,
        pageLimitReached: status.pageLimitReached,
        refreshedAt: status.refreshedAt,
        source: input.refreshedResources.has(status.resource)
          ? "live" as const
          : "cache" as const,
        path: request.path,
        ...(request.select ? { select: request.select } : {}),
        ...(request.query ? { query: request.query } : {}),
        ...(status.lastError ? { error: status.lastError } : {}),
      };
      // Every distinct execution stays visible: a later refresh or a
      // detail lookup must not rewrite the provenance of evidence an
      // earlier read already supplied to the answer.
      const cacheReadEntries = (cacheReadsByResource.get(status.resource) ?? []).map((read) => ({
        resource: status.resource,
        label: status.label,
        rows: read.rows,
        pages: read.pages,
        pageLimitReached: read.pageLimitReached,
        refreshedAt: read.refreshedAt,
        source: read.fromRefresh
          ? "live" as const
          : input.refreshedResources.has(status.resource) &&
              read.refreshedAt !== undefined &&
              read.refreshedAt === status.refreshedAt
            ? "live" as const
            : "cache" as const,
        path: request.path,
        ...(request.select ? { select: request.select } : {}),
        ...(request.query ? { query: request.query } : {}),
        ...(read.error ? { error: read.error } : {}),
      }));
      const liveEntries = (liveGraphByResource.get(status.resource) ?? [])
        .filter((liveEntry) => liveEntry.graphSource)
        .map((liveEntry) => {
          const live = liveEntry.graphSource!;
          const select = live.query?.["$select"]
            ?.split(",")
            .map((field) => field.trim())
            .filter(Boolean);
          return {
            resource: status.resource,
            label: status.label,
            rows: live.rows,
            pages: live.pagesFetched,
            pageLimitReached: live.truncated,
            refreshedAt: liveEntry.completedAt,
            source: "live" as const,
            path: live.path,
            ...(select && select.length > 0 ? { select } : {}),
            ...(live.query ? { query: live.query } : {}),
          };
        });
      if (cacheReadEntries.length === 0 && liveEntries.length === 0) return [cacheEntry];
      if (cacheReadEntries.length === 0) return liveEntries;
      return [...cacheReadEntries, ...liveEntries];
    });
}



export function normalizeChatConversationTitle(title: string): string {
  const normalized = chatTitleForPrompt(title);
  if (!normalized.trim()) {
    throw new Error("Conversation title is required.");
  }
  return normalized;
}



export function hashTenantId(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 24);
}



export function buildSelfTrainingYaml(input: {
  agentSlug: string;
  tenantKey: string;
  updatedAt: string;
  suggestions: SelfTrainingSuggestion[];
}): string {
  const lines = [
    "schemaVersion: 1",
    `agentSlug: ${quoteYaml(input.agentSlug)}`,
    `tenantKey: ${quoteYaml(input.tenantKey)}`,
    "enabled: true",
    `updatedAt: ${quoteYaml(input.updatedAt)}`,
    "",
    "instructions:",
  ];
  if (input.suggestions.length === 0) {
    lines.push("  []");
  } else {
    for (const suggestion of input.suggestions) {
      lines.push(`  - id: ${quoteYaml(suggestion.id)}`);
      lines.push("    status: active");
      lines.push(`    source: ${quoteYaml(suggestion.source)}`);
      lines.push(`    createdAt: ${quoteYaml(suggestion.createdAt)}`);
      lines.push("    text: |-");
      lines.push(...indentBlock(suggestion.text, 6));
    }
  }
  lines.push("", "metadata:");
  lines.push(`  acceptedSuggestions: ${input.suggestions.length}`);
  lines.push("  note: Approved local self-training only. This file cannot add scopes, change mode, or bypass confirmation.");
  return `${lines.join("\n")}\n`;
}



export function quoteYaml(value: string): string {
  return JSON.stringify(value);
}



export function indentBlock(value: string, spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`);
}
