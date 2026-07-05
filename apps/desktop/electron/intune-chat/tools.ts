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
      "Read cached rows for one resource kind with simple predicates, sort, and a hard return cap of 50 rows.",
    params: {
      type: "object",
      required: ["resource"],
      properties: {
        resource: {
          type: "string",
          enum: GRAPH_CACHE_RESOURCES.map((entry) => entry.resource),
        },
        filters: {
          type: "array",
          description:
            "Predicates: {field, op, value}. Ops: eq, neq, contains, startsWith, in, lt, lte, gt, gte.",
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
    name: "graph_get",
    description:
      "Perform a live Microsoft Graph GET when cache is not enough. Non-GET methods are rejected. $top is capped at 50.",
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
  return {
    resource,
    totalCount: result.totalCount,
    returnedRows: result.returnedRows,
    limit: result.limit,
    capped: result.totalCount > result.returnedRows,
    rows: result.rows.map((entry) => ({
      refreshedAt: entry.refreshedAt,
      row: compactValue(entry.row),
    })),
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
  const allowedScopes = new Set(
    GRAPH_CACHE_RESOURCES.flatMap((resource) => resource.scopes),
  );
  const endpointScopes = endpoint.scopesDelegated.filter((scope) =>
    allowedScopes.has(scope),
  );
  const resourceScopes = resourceScopesForPath(path);
  const scopes = [...new Set([...endpointScopes, ...resourceScopes])].sort();
  if (scopes.length === 0) {
    throw new Error(
      "Graph path is known, but it is outside Intune Chat's read-only scope allowlist.",
    );
  }
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
    return `${Number(record.returnedRows ?? 0).toLocaleString()} of ${Number(record.totalCount ?? 0).toLocaleString()} cached rows returned`;
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

function filtersParam(params: unknown): GraphCacheQueryPredicate[] | undefined {
  const filters =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>).filters
      : undefined;
  if (!Array.isArray(filters)) return undefined;
  return filters.slice(0, 8).map((filter) => {
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
      throw new Error("query_cache filters must be objects.");
    }
    const record = filter as Record<string, unknown>;
    const field = typeof record.field === "string" ? record.field : "";
    const op = typeof record.op === "string" ? record.op : "";
    if (!isGraphCacheQueryOperator(op)) {
      throw new Error(`Unsupported query_cache operator: ${op}`);
    }
    return {
      field,
      op,
      value: record.value as GraphCacheQueryPredicate["value"],
    };
  });
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
