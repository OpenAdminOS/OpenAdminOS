import type { ChatDataTable, GraphCacheResourceKind } from "@openadminos/agent-sdk";

const LIST_FIELDS: Partial<Record<GraphCacheResourceKind, readonly string[]>> = {
  managedDevices: ["id", "deviceName", "operatingSystem", "osVersion", "complianceState", "lastSyncDateTime", "userPrincipalName", "managedDeviceOwnerType", "isEncrypted"],
  entraDevices: ["id", "displayName", "operatingSystem", "operatingSystemVersion", "trustType", "isManaged", "isCompliant", "approximateLastSignInDateTime"],
  users: ["id", "displayName", "userPrincipalName", "accountEnabled", "userType"],
  mobileApps: ["id", "displayName", "publisher", "@odata.type", "isAssigned"],
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

export function chatCacheTable(
  resource: GraphCacheResourceKind,
  filters: string,
  refreshedAt: string,
  rawRows: unknown[],
): ChatDataTable {
  const records = rawRows.map(row => listedCacheRow(resource, row) as Record<string, unknown>);
  const columns = [...new Set(records.flatMap(row => Object.keys(row)))];
  return {
    resource,
    filters,
    refreshedAt,
    totalCount: records.length,
    columns,
    rows: records.map(row => columns.map(column => {
      const value = row[column];
      return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    })),
  };
}

export function chatTableNote(total: number, attached: boolean): string {
  if (attached) return `The complete list of ${total} matching cached rows is attached below the answer as a table with CSV export.`;
  return total > CHAT_TABLE_ROW_CAP
    ? `${total} cached rows match, exceeding the ${CHAT_TABLE_ROW_CAP}-row attachment limit. Narrow the filter or page through the results with query_cache.`
    : `${total} cached rows match. Use nextOffset from query_cache to read additional pages.`;
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
