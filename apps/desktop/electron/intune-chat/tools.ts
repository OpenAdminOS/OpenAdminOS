import { randomUUID } from "node:crypto";

import type {
  DriftTimelineInput,
  DriftTimelineResult,
  GraphCacheRefreshResourceResult,
  GraphCacheResourceKind,
  GraphRequestInput,
  IntuneChatInvestigationToolName,
  IntuneChatToolTraceEntry,
  RunGraphApi,
} from "@openadminos/agent-sdk";

import { DEFAULT_SCOPE_METADATA } from "@openadminos/runtime";

import { lookupEndpoint, searchEndpoints } from "../graph-catalog.js";
import { unwrapGraphCollectionPage } from "../state-helpers.js";
import {
  GRAPH_CACHE_RESOURCES,
  definitionForResource,
  pathForResource,
} from "./planner.js";
import { DRIFT_TRACKED_RESOURCES } from "./drift/tracked-resources.js";
import type {
  GraphCacheQueryPredicate,
  IntelligenceSqliteStore,
} from "./sqlite-store.js";

export const QUERY_CACHE_ROW_CAP = 50;
export const GRAPH_GET_ROW_CAP = 50;
export const GRAPH_GET_PAYLOAD_BYTE_CAP = 24_000;
export const QUERY_DRIFT_ROW_CAP = 50;
const QUERY_DRIFT_SCAN_LIMIT = 500;

export interface IntuneChatToolDefinition {
  name: IntuneChatInvestigationToolName;
  description: string;
  params: Record<string, unknown>;
}

export interface IntuneChatToolExecution {
  result: unknown;
  trace: IntuneChatToolTraceEntry;
}

export interface IntuneChatToolContext {
  tenantId: string;
  store: IntelligenceSqliteStore;
  graphForScopes(scopes: string[]): Promise<RunGraphApi>;
  refreshResource(resource: GraphCacheResourceKind): Promise<GraphCacheRefreshResourceResult>;
  getDriftTimeline(input: DriftTimelineInput): Promise<DriftTimelineResult>;
}

export const INTUNE_CHAT_TOOL_DEFINITIONS: readonly IntuneChatToolDefinition[] = [
  {
    name: "list_cached_resources",
    description:
      "List active-tenant Graph cache resources, row counts, freshness, staleness, and last errors.",
    params: {
      type: "object",
      properties: {
        staleAfterHours: {
          type: "number",
          description: "Optional staleness threshold. Defaults to 6 hours.",
        },
      },
    },
  },
  {
    name: "query_cache",
    description:
      'Read cached rows for one resource kind. Filter with "where", for example {"resource":"managedDevices","where":{"complianceState":"noncompliant"},"limit":25}. Returns at most 50 rows.',
    params: {
      type: "object",
      required: ["resource"],
      properties: {
        resource: {
          type: "string",
          enum: GRAPH_CACHE_RESOURCES.map((entry) => entry.resource),
        },
        where: {
          type: "object",
          description:
            'Simplest filter: a map of field to required value, for example {"complianceState":"noncompliant"}. Prefer this.',
        },
        filters: {
          type: "array",
          description:
            'Only for comparisons other than equality: [{"field":"lastSyncDateTime","op":"lt","value":"2026-01-01"}]. Ops: eq, neq, contains, startsWith, in, lt, lte, gt, gte.',
        },
        sort: {
          type: "object",
          description: "{field, direction:'asc'|'desc'}",
        },
        limit: {
          type: "number",
          description: "Requested rows. Hard-capped at 50.",
        },
      },
    },
  },
  {
    name: "find_graph_endpoint",
    description:
      "Find the Microsoft Graph GET path for a subject before calling graph_get. Search in plain words, for example 'conditional access named locations' or 'mailbox settings'. Returns candidate paths with a summary and whether this tenant's consent covers them. Use this whenever the exact path is not already known; do not guess a path.",
    params: {
      type: "object",
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Plain-word description of the data being looked for.",
        },
        limit: {
          type: "number",
          description: "How many candidates to return. Defaults to 8, capped at 15.",
        },
      },
    },
  },
  {
    name: "graph_get",
    description:
      "Perform a live Microsoft Graph GET when cache is not enough. Non-GET methods are rejected. $top is capped at 50. Prefer a path returned by find_graph_endpoint over one recalled from memory.",
    params: {
      type: "object",
      required: ["path"],
      properties: {
        method: {
          type: "string",
          enum: ["GET"],
          description: "Only GET is accepted.",
        },
        path: {
          type: "string",
          description: "Graph path such as /users or /deviceManagement/managedDevices.",
        },
        query: {
          type: "object",
          description: "Optional $select, $top, $filter, $orderby, $count, or $search values.",
        },
        headers: {
          type: "object",
          description: "Optional read headers. Only ConsistencyLevel is accepted.",
        },
      },
    },
  },
  {
    name: "refresh_resource",
    description:
      "Refresh one known cache resource for the active tenant, then report updated freshness.",
    params: {
      type: "object",
      required: ["resource"],
      properties: {
        resource: {
          type: "string",
          enum: GRAPH_CACHE_RESOURCES.map((entry) => entry.resource),
        },
      },
    },
  },
  {
    name: "query_drift",
    description:
      "Answer what changed / who changed it questions from LOCAL drift history only. Uses stored snapshots and cached audit attribution; does not call Microsoft Graph.",
    params: {
      type: "object",
      properties: {
        resource: {
          type: "string",
          enum: [...DRIFT_TRACKED_RESOURCES],
          description: "Optional drift-tracked resource kind.",
        },
        from: {
          type: "string",
          description: "Optional inclusive ISO timestamp lower bound.",
        },
        to: {
          type: "string",
          description: "Optional inclusive ISO timestamp upper bound.",
        },
        changeKind: {
          type: "string",
          enum: ["added", "removed", "modified"],
          description: "Optional change kind filter.",
        },
        top: {
          type: "number",
          description: "Requested rows. Hard-capped at 50.",
        },
      },
    },
  },
] as const;

export function toolDefinitionsForPrompt(): string {
  return INTUNE_CHAT_TOOL_DEFINITIONS.map((tool) =>
    [
      `- ${tool.name}: ${tool.description}`,
      `  params: ${JSON.stringify(tool.params)}`,
    ].join("\n"),
  ).join("\n");
}

export async function executeIntuneChatTool(
  ctx: IntuneChatToolContext,
  tool: IntuneChatInvestigationToolName,
  params: unknown,
): Promise<IntuneChatToolExecution> {
  const startedAtMs = Date.now();
  const createdAt = new Date(startedAtMs).toISOString();
  try {
    const result = await executeToolUnchecked(ctx, tool, params);
    const completedAtMs = Date.now();
    const trace: IntuneChatToolTraceEntry = {
      id: `tool_${randomUUID()}`,
      tool,
      params: params ?? {},
      resultSummary: summarizeToolResult(tool, result),
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      createdAt,
      completedAt: new Date(completedAtMs).toISOString(),
    };
    return { result, trace };
  } catch (caught) {
    const completedAtMs = Date.now();
    const message = caught instanceof Error ? caught.message : String(caught);
    const trace: IntuneChatToolTraceEntry = {
      id: `tool_${randomUUID()}`,
      tool,
      params: params ?? {},
      resultSummary: `Failed: ${message}`,
      durationMs: Math.max(0, completedAtMs - startedAtMs),
      createdAt,
      completedAt: new Date(completedAtMs).toISOString(),
      error: message,
    };
    return {
      result: { ok: false, error: message },
      trace,
    };
  }
}

function executeToolUnchecked(
  ctx: IntuneChatToolContext,
  tool: IntuneChatInvestigationToolName,
  params: unknown,
): Promise<unknown> {
  switch (tool) {
    case "list_cached_resources":
      return Promise.resolve(listCachedResources(ctx, params));
    case "query_cache":
      return Promise.resolve(queryCache(ctx, params));
    case "find_graph_endpoint":
      return Promise.resolve(findGraphEndpoint(params));
    case "graph_get":
      return graphGet(ctx, params);
    case "refresh_resource":
      return refreshResource(ctx, params);
    case "query_drift":
      return queryDrift(ctx, params);
  }
}

function listCachedResources(ctx: IntuneChatToolContext, params: unknown): unknown {
  const staleAfterHours = numberParam(params, "staleAfterHours") ?? 6;
  const staleAfterMs = Math.max(1, staleAfterHours) * 60 * 60 * 1000;
  const nowMs = Date.now();
  const resources = ctx.store.getGraphCacheStatus(ctx.tenantId, [...GRAPH_CACHE_RESOURCES]);
  return {
    tenantId: ctx.tenantId,
    staleAfterHours,
    resources: resources.map((resource) => {
      const refreshedMs = resource.refreshedAt
        ? new Date(resource.refreshedAt).getTime()
        : Number.NaN;
      const stale =
        !resource.refreshedAt ||
        resource.rows === 0 ||
        !Number.isFinite(refreshedMs) ||
        nowMs - refreshedMs > staleAfterMs;
      return {
        resource: resource.resource,
        label: resource.label,
        rows: resource.rows,
        refreshedAt: resource.refreshedAt,
        stale,
        pages: resource.pages,
        pageLimitReached: resource.pageLimitReached,
        lastError: resource.lastError,
      };
    }),
  };
}

function queryCache(ctx: IntuneChatToolContext, params: unknown): unknown {
  const resource = resourceParam(params, "resource");
  const filters = filtersParam(params);
  const sort = sortParam(params);
  const limit = numberParam(params, "limit") ?? 25;
  const result = ctx.store.queryGraphCache({
    tenantId: ctx.tenantId,
    resource,
    filters,
    sort,
    limit: Math.min(limit, QUERY_CACHE_ROW_CAP),
  });
  // A query returning nothing is the most misread result in the whole
  // tool surface: models reported "the tenant has no managed devices"
  // when nine were cached and only the filter had missed. Always say
  // how many rows the resource holds unfiltered, and name the fields
  // that exist so a guessed field name can be corrected.
  let emptyHint:
    | { cachedRowsForResource: number; availableFields?: string[]; note: string }
    | undefined;
  if (result.returnedRows === 0) {
    let cachedRowsForResource = 0;
    try {
      cachedRowsForResource = ctx.store.aggregateGraphResource(
        ctx.tenantId,
        resource,
      ).total;
    } catch {
      // Fall back to reporting zero rather than failing the tool call.
    }
    if (cachedRowsForResource > 0) {
      const availableFields = fieldsForResource(ctx, resource);
      emptyHint = {
        cachedRowsForResource,
        ...(availableFields ? { availableFields } : {}),
        note: `No row matched this filter, but ${resource} holds ${cachedRowsForResource} cached rows, so the tenant is NOT empty and you must not answer that it has none. The filter named a field or value that does not exist on these rows. Retry using one of availableFields above, matching the field whose name is closest to what the question asks about.`,
      };
    } else {
      emptyHint = {
        cachedRowsForResource: 0,
        note: `Nothing is cached for ${resource}, so this query cannot show whether the tenant has any. Refresh the resource before concluding anything about it.`,
      };
    }
  }

  const availableFields = fieldsForResource(ctx, resource);
  return {
    resource,
    totalCount: result.totalCount,
    returnedRows: result.returnedRows,
    limit: result.limit,
    capped: result.totalCount > result.returnedRows,
    ...(availableFields ? { availableFields } : {}),
    ...(emptyHint ?? {}),
    rows: result.rows.map((entry) => ({
      refreshedAt: entry.refreshedAt,
      row: compactValue(entry.row),
    })),
  };
}

export const FIND_ENDPOINT_LIMIT_CAP = 15;

/** How many field names to advertise for a resource. */
const FIELD_HINT_CAP = 40;

/**
 * Field names present on the cached rows of a resource.
 *
 * A model cannot filter on a field it does not know exists. Measured
 * against a real tenant, "which laptops are not encrypted" was answered
 * with "none" while six of nine devices carried `isEncrypted: false`,
 * simply because the model never saw that the field was available.
 * Advertising the field list on every read, rather than only after a
 * query has already failed, is what makes an unanticipated question
 * answerable.
 *
 * Only `query_cache` carries this. The cache inventory covers every
 * resource at once, so attaching field lists there added dozens of
 * names per resource to a single observation and slowed the model down
 * far more than it helped.
 */
function fieldsForResource(
  ctx: IntuneChatToolContext,
  resource: GraphCacheResourceKind,
): string[] | undefined {
  try {
    const sample = ctx.store.queryGraphCache({
      tenantId: ctx.tenantId,
      resource,
      limit: 1,
    });
    const row = sample.rows[0]?.row;
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const keys = Object.keys(row as Record<string, unknown>);
    return keys.length > 0 ? keys.slice(0, FIELD_HINT_CAP) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Endpoint discovery. A small local model cannot reliably recall Graph
 * paths, and a guessed path costs a failed tool call and a repair turn.
 * Searching the bundled catalog turns "recall the path" into "pick from
 * a list", which is a far easier task and the difference between an 8B
 * model answering an unanticipated question and giving up.
 */
function findGraphEndpoint(params: unknown): unknown {
  const query = stringParam(params, "query");
  if (!query || query.trim().length === 0) {
    throw new Error("find_graph_endpoint requires a query describing the data needed.");
  }
  const requested = numberParam(params, "limit") ?? 8;
  const limit = Math.max(1, Math.min(FIND_ENDPOINT_LIMIT_CAP, Math.trunc(requested)));
  const matches = searchEndpoints(query, { method: "GET", limit });
  const candidates = matches.map((endpoint) => {
    const documented = endpoint.scopesDelegated;
    const consented = documented.filter((scope) => CONSENTED_SCOPES.has(scope));
    const usable = documented.length === 0 || consented.length > 0;
    return {
      path: endpoint.path,
      summary: endpoint.summary,
      usable,
      ...(usable
        ? {}
        : { blockedReason: `Needs ${documented.slice(0, 2).join(" or ")}, which is not consented.` }),
    };
  });
  return {
    query,
    candidates,
    ...(candidates.length === 0
      ? {
          note: "No endpoint matched. Try different words, or answer from cached resources instead.",
        }
      : {
          note: "Call graph_get with one of these paths. Paths ending in a placeholder such as {id} need a real id substituted.",
        }),
  };
}

async function graphGet(ctx: IntuneChatToolContext, params: unknown): Promise<unknown> {
  const method = stringParam(params, "method") ?? "GET";
  if (method.toUpperCase() !== "GET") {
    throw new Error("graph_get is read-only. Only GET is accepted.");
  }
  const path = normalizeGraphPath(stringParam(params, "path"));
  const validation = validateGraphGetPath(path);
  const query = cappedGraphQuery(objectParam(params, "query"));
  const headers = graphHeaders(objectParam(params, "headers"));
  const graph = await ctx.graphForScopes(validation.scopes);
  const request: GraphRequestInput = {
    method: "GET",
    path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  const response = await graph.request(request);
  return capGraphResponse({
    path,
    query,
    response,
    endpointSummary: validation.summary,
    scopes: validation.scopes,
  });
}

async function refreshResource(
  ctx: IntuneChatToolContext,
  params: unknown,
): Promise<unknown> {
  const resource = resourceParam(params, "resource");
  const result = await ctx.refreshResource(resource);
  return {
    resource: result.resource,
    label: result.label,
    ok: result.ok,
    rows: result.rows,
    pages: result.pages,
    pageLimitReached: result.pageLimitReached,
    refreshedAt: result.refreshedAt,
    error: result.error,
  };
}

async function queryDrift(
  ctx: IntuneChatToolContext,
  params: unknown,
): Promise<unknown> {
  const resource = optionalDriftResourceParam(params, "resource");
  const from = isoDateParam(params, "from");
  const to = isoDateParam(params, "to");
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw new Error("query_drift from date must be before the to date.");
  }
  const changeKind = changeKindParam(params);
  const top = topParam(params);
  const timeline = await ctx.getDriftTimeline({
    tenantId: ctx.tenantId,
    ...(resource ? { resources: [resource] } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    limit: QUERY_DRIFT_SCAN_LIMIT,
  });
  const matched = timeline.entries.filter((entry) => {
    if (entry.changeKind === "baseline") return false;
    return changeKind ? entry.changeKind === changeKind : true;
  });
  const rows = matched.slice(0, top).map((entry) => ({
    when: entry.capturedAt,
    resource: entry.resource,
    kind: entry.changeKind,
    name: entry.displayName ?? entry.graphId ?? "unknown",
    fieldsChanged: entry.fieldChangeCount,
    timestampOnly: entry.timestampOnly,
    actor: actorLabel(entry.attribution),
  }));
  const rowCapped = matched.length > rows.length;
  const note = rowCapped
    ? `Results were capped at ${top.toLocaleString()} rows. Narrow resource, from, to, or changeKind for more detail.`
    : timeline.hasMore
      ? `Local drift timeline scan reached ${QUERY_DRIFT_SCAN_LIMIT.toLocaleString()} entries. More matching rows may exist; narrow resource, from, to, or changeKind for more detail.`
      : undefined;
  return enforcePayloadCap({
    rows,
    returnedRows: rows.length,
    matchedRows: matched.length,
    top,
    ...(note ? { note } : {}),
  });
}

/** Read scopes this app asks a tenant to consent to. */
const CONSENTED_SCOPES = new Set(DEFAULT_SCOPE_METADATA.map((entry) => entry.name));

/**
 * Decide whether a Graph GET may be attempted, and with which scopes.
 *
 * Chat previously refused any endpoint whose delegated permissions were
 * absent from a small allowlist derived from the cached resources. The
 * bundled catalog only carries permission data for a fraction of its
 * entries, so that rule rejected roughly 14,000 read endpoints for
 * having no metadata rather than for being out of bounds, and left Chat
 * able to reach about 5% of Graph reads.
 *
 * The access token is the real boundary: it cannot exceed what the
 * admin consented to, Graph enforces that server-side, and this tool is
 * GET-only. So an endpoint is attempted when its permissions are
 * unknown, and refused with a specific message when they are known and
 * fall outside what this app requests. Scopes are never widened beyond
 * the consented set, because asking for more would trigger an
 * interactive consent prompt in the middle of an answer.
 */
function validateGraphGetPath(path: string): {
  scopes: string[];
  summary?: string;
} {
  const endpoint = lookupEndpoint("GET", path);
  if (!endpoint) {
    const suggestions = searchEndpoints(path, { method: "GET", limit: 3 })
      .map((entry) => entry.path)
      .join(", ");
    throw new Error(
      suggestions
        ? `Unknown Microsoft Graph GET path. Closest known paths: ${suggestions}.`
        : "Unknown Microsoft Graph GET path.",
    );
  }
  const documented = endpoint.scopesDelegated;
  const consented = documented.filter((scope) => CONSENTED_SCOPES.has(scope));
  if (documented.length > 0 && consented.length === 0) {
    throw new Error(
      `This endpoint requires ${documented.slice(0, 3).join(" or ")}, which OpenAdminOS does not request. No tenant data was read.`,
    );
  }
  // Where the catalog documents no permissions, fall back to the token
  // already held for this tenant. Graph rejects anything the consent
  // does not cover, and that rejection is surfaced verbatim.
  const resourceScopes = resourceScopesForPath(path);
  const scopes = [...new Set([...consented, ...resourceScopes])].sort();
  return { scopes, summary: endpoint.summary };
}

function resourceScopesForPath(path: string): string[] {
  const pathOnly = path.split("?")[0]!;
  const scopes = new Set<string>();
  for (const definition of GRAPH_CACHE_RESOURCES) {
    const request = pathForResource(definition.resource);
    if (pathOnly === request.path || pathOnly.startsWith(`${request.path}/`)) {
      for (const scope of definition.scopes) scopes.add(scope);
    }
  }
  return [...scopes];
}

function cappedGraphQuery(queryInput: Record<string, unknown> | undefined): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(queryInput ?? {})) {
    if (!["$select", "$top", "$filter", "$orderby", "$count", "$search"].includes(key)) {
      continue;
    }
    if (key === "$top") {
      const parsed = Number(value);
      query.$top = String(
        Number.isFinite(parsed)
          ? Math.max(1, Math.min(GRAPH_GET_ROW_CAP, Math.floor(parsed)))
          : GRAPH_GET_ROW_CAP,
      );
      continue;
    }
    const text = String(value).replace(/[\r\n]+/g, " ").trim();
    if (!text) continue;
    query[key] = text.slice(0, key === "$filter" ? 600 : 300);
  }
  if (!query.$top) query.$top = String(GRAPH_GET_ROW_CAP);
  return query;
}

function graphHeaders(headersInput: Record<string, unknown> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const consistency =
    headersInput?.ConsistencyLevel ?? headersInput?.consistencylevel ?? headersInput?.["consistency-level"];
  if (typeof consistency === "string" && consistency.toLowerCase() === "eventual") {
    headers.ConsistencyLevel = "eventual";
  }
  return headers;
}

function capGraphResponse(input: {
  path: string;
  query: Record<string, string>;
  response: unknown;
  endpointSummary?: string;
  scopes: string[];
}): unknown {
  const page = unwrapGraphCollectionPage(input.response);
  const isCollection =
    Array.isArray((input.response as { value?: unknown })?.value) ||
    Array.isArray(input.response);
  const base = isCollection
    ? {
        path: input.path,
        query: input.query,
        endpointSummary: input.endpointSummary,
        scopes: input.scopes,
        rowCountInPage: page.rows.length,
        returnedRows: Math.min(page.rows.length, GRAPH_GET_ROW_CAP),
        nextLinkPresent: Boolean(page.nextLink),
        truncated: page.rows.length > GRAPH_GET_ROW_CAP || Boolean(page.nextLink),
        rows: page.rows.slice(0, GRAPH_GET_ROW_CAP).map(compactValue),
      }
    : {
        path: input.path,
        query: input.query,
        endpointSummary: input.endpointSummary,
        scopes: input.scopes,
        truncated: false,
        value: compactValue(input.response),
      };
  return enforcePayloadCap(base);
}

function enforcePayloadCap(value: Record<string, unknown>): Record<string, unknown> {
  let next = value;
  if (JSON.stringify(next).length <= GRAPH_GET_PAYLOAD_BYTE_CAP) return next;
  if (Array.isArray(next.rows)) {
    let rows = next.rows;
    while (rows.length > 1) {
      rows = rows.slice(0, Math.ceil(rows.length / 2));
      next = {
        ...next,
        rows,
        returnedRows: rows.length,
        truncated: true,
        payloadTruncated: true,
      };
      if (JSON.stringify(next).length <= GRAPH_GET_PAYLOAD_BYTE_CAP) return next;
    }
  }
  const serialized = JSON.stringify(next);
  return {
    ...next,
    rows: undefined,
    valuePreview: serialized.slice(0, GRAPH_GET_PAYLOAD_BYTE_CAP),
    truncated: true,
    payloadTruncated: true,
  };
}

function summarizeToolResult(
  tool: IntuneChatInvestigationToolName,
  result: unknown,
): string {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  if (tool === "list_cached_resources") {
    const resources = Array.isArray(record.resources) ? record.resources : [];
    const stale = resources.filter((entry) =>
      Boolean((entry as { stale?: unknown }).stale),
    ).length;
    return `${resources.length} cache resources listed · ${stale} stale`;
  }
  if (tool === "query_cache") {
    // totalCount counts rows matching the filter, so a filter that
    // matched nothing used to summarise as "0 of 0 cached rows", which
    // reads as an empty cache and contradicts the result body. Report
    // the unfiltered total in that case.
    if (Number(record.returnedRows ?? 0) === 0) {
      const cached = Number(record.cachedRowsForResource ?? 0);
      return cached > 0
        ? `no rows matched this filter; ${cached.toLocaleString()} rows are cached for this resource`
        : "nothing is cached for this resource yet";
    }
    return `${Number(record.returnedRows ?? 0).toLocaleString()} of ${Number(record.totalCount ?? 0).toLocaleString()} cached rows returned`;
  }
  if (tool === "find_graph_endpoint") {
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const usable = candidates.filter((entry) =>
      Boolean((entry as { usable?: unknown }).usable),
    ).length;
    return `${candidates.length} candidate endpoints · ${usable} within consent`;
  }
  if (tool === "graph_get") {
    if (typeof record.rowCountInPage === "number") {
      return `${Number(record.returnedRows ?? 0).toLocaleString()} of ${record.rowCountInPage.toLocaleString()} live rows returned${record.truncated ? " · truncated" : ""}`;
    }
    return `Live Graph object returned${record.truncated ? " · truncated" : ""}`;
  }
  if (tool === "refresh_resource") {
    return record.ok === false
      ? `Refresh failed for ${String(record.resource ?? "resource")}`
      : `${Number(record.rows ?? 0).toLocaleString()} rows refreshed for ${String(record.resource ?? "resource")}`;
  }
  if (tool === "query_drift") {
    return `${Number(record.returnedRows ?? 0).toLocaleString()} drift changes returned${record.note ? " · capped" : ""}`;
  }
  return "Tool call completed.";
}

export function summarizeToolCallForProgress(
  tool: IntuneChatInvestigationToolName,
  params: unknown,
): string {
  const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
  if (tool === "list_cached_resources") return "Inspecting cache inventory.";
  if (tool === "query_cache") {
    return `Querying cache: ${String(record.resource ?? "resource")}.`;
  }
  if (tool === "find_graph_endpoint") {
    return `Looking up Graph endpoints for: ${String(record.query ?? "")}.`;
  }
  if (tool === "graph_get") {
    return `Running Graph GET: ${String(record.path ?? "path")}.`;
  }
  if (tool === "refresh_resource") {
    const resource =
      typeof record.resource === "string" && isGraphCacheResourceKind(record.resource)
        ? definitionForResource(record.resource).label
        : String(record.resource ?? "resource");
    return `Refreshing ${resource}.`;
  }
  if (tool === "query_drift") {
    const resource =
      typeof record.resource === "string" && isGraphCacheResourceKind(record.resource)
        ? definitionForResource(record.resource).label
        : "change history";
    return `Querying local drift history: ${resource}.`;
  }
  return "Running tool.";
}

function compactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}...` : value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 25).map((item) => compactValue(item, depth + 1));
  }
  if (typeof value === "object") {
    if (depth >= 4) return "[object truncated]";
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "@odata.context") continue;
      out[key] = compactValue(child, depth + 1);
      if (Object.keys(out).length >= 40) {
        out.__truncatedKeys = true;
        break;
      }
    }
    return out;
  }
  return String(value);
}

function resourceParam(params: unknown, key: string): GraphCacheResourceKind {
  const value = stringParam(params, key);
  if (!value || !isGraphCacheResourceKind(value)) {
    throw new Error(`${key} must be a known Graph cache resource.`);
  }
  return value;
}

function optionalDriftResourceParam(
  params: unknown,
  key: string,
): GraphCacheResourceKind | undefined {
  const value = stringParam(params, key);
  if (!value) return undefined;
  if (!DRIFT_TRACKED_RESOURCES.has(value as GraphCacheResourceKind)) {
    throw new Error(`${key} must be a drift-tracked resource.`);
  }
  return value as GraphCacheResourceKind;
}

function isGraphCacheResourceKind(value: string): value is GraphCacheResourceKind {
  return GRAPH_CACHE_RESOURCES.some((entry) => entry.resource === value);
}

/**
 * Read the filter predicates from a tool call.
 *
 * Two shapes are accepted. `where` is a plain map of field to value,
 * which is what a small model reaches for and what it can emit without
 * mangling. `filters` is the explicit {field, op, value} form, kept for
 * operators other than equality. Entries in `filters` that arrive as a
 * bare {field: value} pair are read as equality rather than rejected,
 * because refusing them cost a whole investigation over a shape the
 * model had otherwise chosen correctly.
 */
function filtersParam(params: unknown): GraphCacheQueryPredicate[] | undefined {
  const record =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : undefined;
  if (!record) return undefined;
  const predicates: GraphCacheQueryPredicate[] = [];

  const where = record.where;
  if (where && typeof where === "object" && !Array.isArray(where)) {
    for (const [field, value] of Object.entries(where as Record<string, unknown>)) {
      predicates.push({ field, op: "eq", value: value as GraphCacheQueryPredicate["value"] });
    }
  }

  const filters = record.filters;
  if (Array.isArray(filters)) {
    for (const filter of filters) {
      if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
        // Stray scalars inside the array are ignored rather than fatal.
        continue;
      }
      const entry = filter as Record<string, unknown>;
      if (typeof entry.field === "string") {
        const op = typeof entry.op === "string" ? entry.op : "eq";
        if (!isGraphCacheQueryOperator(op)) {
          throw new Error(
            `Unsupported query_cache operator: ${op}. Use eq, neq, contains, startsWith, in, lt, lte, gt, or gte.`,
          );
        }
        predicates.push({
          field: entry.field,
          op,
          value: entry.value as GraphCacheQueryPredicate["value"],
        });
        continue;
      }
      // A bare {field: value} pair.
      for (const [field, value] of Object.entries(entry)) {
        predicates.push({
          field,
          op: "eq",
          value: value as GraphCacheQueryPredicate["value"],
        });
      }
    }
  }

  return predicates.length > 0 ? predicates.slice(0, 8) : undefined;
}

function isGraphCacheQueryOperator(value: string): value is GraphCacheQueryPredicate["op"] {
  return (
    value === "eq" ||
    value === "neq" ||
    value === "contains" ||
    value === "startsWith" ||
    value === "in" ||
    value === "lt" ||
    value === "lte" ||
    value === "gt" ||
    value === "gte"
  );
}

function sortParam(params: unknown): { field: string; direction?: "asc" | "desc" } | undefined {
  const sort = objectParam(params, "sort");
  if (!sort || Array.isArray(sort)) return undefined;
  const field = typeof sort.field === "string" ? sort.field.trim() : "";
  if (!field) return undefined;
  return {
    field,
    direction: sort.direction === "asc" ? "asc" : "desc",
  };
}

function stringParam(params: unknown, key: string): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = (params as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : undefined;
}

function numberParam(params: unknown, key: string): number | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function topParam(params: unknown): number {
  if (!params || typeof params !== "object" || Array.isArray(params)) return 25;
  const parsed = Number((params as Record<string, unknown>).top);
  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(QUERY_DRIFT_ROW_CAP, Math.floor(parsed)))
    : 25;
}

function isoDateParam(params: unknown, key: "from" | "to"): string | undefined {
  const value = stringParam(params, key);
  if (!value) return undefined;
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`query_drift ${key} must be an ISO timestamp.`);
  }
  return value;
}

function changeKindParam(
  params: unknown,
): "added" | "removed" | "modified" | undefined {
  const value = stringParam(params, "changeKind");
  if (!value) return undefined;
  if (value !== "added" && value !== "removed" && value !== "modified") {
    throw new Error("query_drift changeKind must be added, removed, or modified.");
  }
  return value;
}

function actorLabel(
  attribution: DriftTimelineResult["entries"][number]["attribution"],
): string {
  const actor = attribution?.actor;
  return (
    actor?.userPrincipalName ??
    actor?.appDisplayName ??
    "unknown"
  );
}

function objectParam(params: unknown, key: string): Record<string, unknown> | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const value = (params as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeGraphPath(path: string | undefined): string {
  if (!path) throw new Error("graph_get path is required.");
  let next = path.trim();
  try {
    if (next.startsWith("https://")) {
      const url = new URL(next);
      next = url.pathname.replace(/^\/(?:beta|v1\.0)(?=\/)/, "");
    }
  } catch {
    throw new Error("graph_get path is not a valid Graph path.");
  }
  next = next.split("?")[0]!;
  if (!next.startsWith("/")) next = `/${next}`;
  if (next.includes("..") || /\s/.test(next)) {
    throw new Error("graph_get path contains unsupported characters.");
  }
  return next;
}
