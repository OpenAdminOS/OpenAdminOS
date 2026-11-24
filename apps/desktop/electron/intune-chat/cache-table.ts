import type { ChatDataTable, GraphCacheResourceKind, RunGraphApi } from "@openadminos/agent-sdk";
import { fetchGraphCachePages } from "../state-helpers.js";
import type { GraphCacheQueryPredicate } from "./sqlite-store.js";

const LIST_FIELDS: Partial<Record<GraphCacheResourceKind, readonly string[]>> = {
  managedDevices: ["id", "deviceName", "operatingSystem", "osVersion", "complianceState", "lastSyncDateTime", "userPrincipalName", "managedDeviceOwnerType", "isEncrypted"],
  entraDevices: ["id", "displayName", "operatingSystem", "operatingSystemVersion", "trustType", "isManaged", "isCompliant", "approximateLastSignInDateTime"],
  users: ["id", "displayName", "userPrincipalName", "accountEnabled", "userType"],
  mobileApps: ["id", "displayName", "publisher", "@odata.type", "isAssigned", "assignmentIntents", "availableInCompanyPortal"],
};

/** A listed row with its identifying fields, or the compacted row for resources without a field list. */
export function listedCacheRow(resource: GraphCacheResourceKind, row: unknown): unknown {
  const fields = LIST_FIELDS[resource];
  if (!fields || !row || typeof row !== "object") return compactValue(row);
  const record = row as Record<string, unknown>;
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(record, field)).map((field) => [field, record[field]]));
}

export const COUNT_CACHED_LIST_CAP = 50;
export const CHAT_TABLE_ROW_CAP = 10_000;
const CHAT_TABLE_BYTE_CAP = 4 * 1024 * 1024;

export function cacheMobileAppAssignments(row: unknown): unknown {
  if (!row || typeof row !== "object") return row;
  const {
    assignments,
    "assignments@odata.nextLink": nextLink,
    "assignments@odata.context": _context,
    "assignments@odata.count": count,
    ...app
  } = row as Record<string, unknown>;
  const incomplete = { ...app, assignmentIntents: null };
  if (!Array.isArray(assignments) || nextLink ||
    (typeof count === "number" && assignments.length < count) ||
    (app.isAssigned === true && assignments.length === 0)) return incomplete;
  const intents = assignments.map(assignment => assignment?.intent);
  if (intents.some(intent => typeof intent !== "string" || !intent)) return incomplete;
  const assignmentIntents = [...new Set<string>(intents)].sort();
  // TODO(ugur): confirm required assignments count as available in Company Portal (current rule: yes)
  const availableInCompanyPortal = assignmentIntents.some(intent =>
    ["available", "availableWithoutEnrollment", "required"].includes(intent),
  );
  return { ...app, assignmentIntents, availableInCompanyPortal };
}

export async function resolveCachedAppAssignments(graph: RunGraphApi, row: unknown, signal?: AbortSignal): Promise<unknown> {
  const cached = cacheMobileAppAssignments(row);
  if (!cached || typeof cached !== "object") return cached;
  const app = cached as Record<string, unknown>;
  if (app.assignmentIntents !== null || typeof app.id !== "string" || !app.id) return cached;
  try {
    const assignments = await fetchGraphCachePages(graph, {
      path: `/deviceAppManagement/mobileApps/${encodeURIComponent(app.id)}/assignments`,
      query: { $select: "intent" },
    }, signal, true);
    if (assignments.pageLimitReached ||
      (assignments.totalCount !== undefined && assignments.rows.length < assignments.totalCount)) return cached;
    return cacheMobileAppAssignments({ ...app, assignments: assignments.rows });
  } catch {
    signal?.throwIfAborted();
    return cached;
  }
}

export function describeCacheFilters(filters: readonly GraphCacheQueryPredicate[] = []): string {
  return filters.map(({ field, op, value }) => {
    if (op === "eq" && field === "appPlatform") return `${value} apps`;
    if (op === "eq" && field === "availableInCompanyPortal" && value === true) return "Available in Company Portal";
    return `${field} ${op} ${JSON.stringify(value)}`;
  }).sort().join(", ") || "All cached rows";
}

export function addCacheTable(tables: ChatDataTable[], table: ChatDataTable): boolean {
  if (tables.some(existing => existing.resource === table.resource &&
    existing.filters === table.filters && existing.totalCount === table.totalCount &&
    existing.refreshedAt === table.refreshedAt && existing.partial === table.partial)) return true;
  if (tables.length >= 3) return false;
  tables.push(table);
  return true;
}

export function cacheTableAnswer(content: string, tableCount: number, notices: Set<string>, usedCacheList: boolean): string {
  const attachmentClaim = /(?:^|(?<=[.!?\n]))[ \t]*(?:(?:I(?: have|'ve)? |we(?: have|'ve)? )(?:attached|exported)\b|attached (?:is|are)\b|(?:the )?attachment (?:follows|contains|includes)\b|(?:the |a )?(?:complete |full )?(?:cached )?(?:data|list|table|results|CSV|file)(?: of [^.!?\n]+?)? (?:is|are|has been|have been) attached\b|(?:you can )?download (?:the |a )?(?:complete |full )?(?:data|list|table|results|CSV|file)\b|(?:the )?CSV export (?:is ready|is available)\b)[^.!?\n]*(?:[.!?]|$)/gi;
  const stripped = usedCacheList && !tableCount ? content.replace(attachmentClaim, "").trim() : content;
  return [
    stripped || content,
    ...notices,
    tableCount ? "Open the cached results below or export them as CSV." : "",
  ].filter(Boolean).join("\n\n");
}

export function cacheListLimitNotice(total: number): string {
  const limit = total > CHAT_TABLE_ROW_CAP
    ? "Chat can list up to 10,000 rows in a table."
    : "The full list exceeds the table limits for this answer.";
  return `${total.toLocaleString("en-US")} cached rows match. ${limit} Narrow the question to see the full list.`;
}

export function chatCacheTable(
  resource: GraphCacheResourceKind,
  filters: string,
  refreshedAt: string,
  rawRows: unknown[],
  partial = false,
): ChatDataTable | undefined {
  const records = rawRows.map(row => listedCacheRow(resource, row) as Record<string, unknown>);
  const columns = [...new Set(records.flatMap(row => Object.keys(row)))];
  if (columns.length > 64) return undefined;
  let bytes = Buffer.byteLength(JSON.stringify(columns));
  const rows: string[][] = [];
  for (const record of records) {
    const row = columns.map(column => {
      const value = record[column];
      const cell = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
      return LIST_FIELDS[resource] || cell.length <= 800 ? cell : `${cell.slice(0, 800)}…`;
    });
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes > CHAT_TABLE_BYTE_CAP) return undefined;
    rows.push(row);
  }
  return { resource, filters, refreshedAt, partial, totalCount: rows.length, columns, rows };
}

export function chatTableNote(total: number, attached: boolean, attempted = true): string {
  if (attached) return `${total} cached rows match. Report the count. The host handles table and CSV notices.`;
  if (total > CHAT_TABLE_ROW_CAP) return `${total} cached rows match, exceeding the ${CHAT_TABLE_ROW_CAP}-row attachment limit. Narrow the filter or page through the results with query_cache.`;
  if (attempted) return `${total} cached rows match. The complete list exceeds the chat table size or per-answer table limit. Narrow the filter or page through the results with query_cache.`;
  return `${total} cached rows match. Use nextOffset from query_cache to read additional pages.`;
}

export function compactValue(value: unknown, depth = 0): unknown {
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
