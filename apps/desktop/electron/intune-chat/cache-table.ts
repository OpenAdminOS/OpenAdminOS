import type { ChatDataTable, GraphCacheResourceKind } from "@openadminos/agent-sdk";
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
  const { assignments, ...app } = row as Record<string, unknown>;
  if (!Array.isArray(assignments) || app["assignments@odata.nextLink"]) return app;
  const intents = assignments.map(assignment => assignment?.intent);
  if (intents.some(intent => typeof intent !== "string")) return app;
  const assignmentIntents = [...new Set<string>(intents)].sort();
  // Required apps can appear in Company Portal, so include them in catalog-level availability.
  // TODO(ugur): Confirm whether Company Portal availability should exclude required installs.
  const availableInCompanyPortal = assignmentIntents.some(intent =>
    ["available", "availableWithoutEnrollment", "required"].includes(intent),
  );
  return { ...app, assignmentIntents, availableInCompanyPortal };
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
    existing.filters === table.filters && existing.totalCount === table.totalCount)) return true;
  if (tables.length >= 3) return false;
  tables.push(table);
  return true;
}

export function cacheTableAnswer(content: string, tableCount: number, notices: Set<string>): string {
  const attachmentClaim = /[^.!?\n]*\b(?:table|CSV|list|results|rows|export|file)\b[^.!?\n]*(?:\battached\b|\bbelow\b)[^.!?\n]*[.!?]?|[^.!?\n]*\battached\s+(?:the |a |as )?(?:full |complete )?(?:table|CSV|list|results|rows|export|file)\b[^.!?\n]*[.!?]?/gi;
  const cleaned = content.replace(attachmentClaim, "").trim();
  return [
    cleaned,
    ...notices,
    tableCount ? "Open the cached results below or export them as CSV." : "",
  ].filter(Boolean).join("\n\n") || (content ? "No complete cached table was attached." : content);
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
