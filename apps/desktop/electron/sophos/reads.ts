import type { SophosReadTool } from "@openadminos/agent-sdk";

import { SophosApiError, type SophosApi, type SophosIdentity } from "./api.js";

const endpointFilters = ["healthStatus", "type", "tamperProtectionEnabled", "lastSeenBefore", "lastSeenAfter", "isolationStatus", "search", "view"];
const alertFilters = ["from", "to", "product", "category", "severity"];

export const SOPHOS_READ_TOOLS = {
  sophos_list_endpoints: `List Sophos endpoints, health, OS, tamper protection and isolation. Optional filters: ${endpointFilters.join(", ")}. Pass the prior result’s page.next as next.`,
  sophos_list_alerts: `List Sophos Central alerts. Optional filters: ${alertFilters.join(", ")}. Pass the prior result’s page.next as next.`,
  sophos_get_alert: "Read one Sophos Central alert. Requires id from an alert result.",
  sophos_list_events: "Read Sophos SIEM events from the last 24 hours only. Pass the prior result’s page.next as next. Always say the events cover the last 24 hours.",
  sophos_list_siem_alerts: "Read Sophos SIEM alerts from the last 24 hours only. Pass the prior result’s page.next as next.",
  sophos_list_firewalls: "List Sophos firewalls. Pass the prior result’s page.next as next. Firewall traffic logs are unavailable through this API.",
  sophos_list_firewall_groups: "List Sophos firewall groups. Pass the prior result’s page.next as next. Firewall traffic logs are unavailable through this API.",
  sophos_get_health_check: "Read the Sophos account health check scores for protection, policy, exclusions and tamper protection.",
} as const;

export type { SophosReadTool };

export function isSophosReadTool(value: string): value is SophosReadTool {
  return Object.hasOwn(SOPHOS_READ_TOOLS, value);
}

function invalidInput() {
  return new SophosApiError("refused", "Use the supported Sophos Central filters and the continuation from the last page.");
}

export async function readSophos(api: SophosApi, identity: SophosIdentity, tool: SophosReadTool, input: unknown, signal?: AbortSignal) {
  const params = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (tool === "sophos_get_alert") return { records: [await api.alert(identity, String(params.id ?? ""), signal)] };
  if (tool === "sophos_get_health_check") return { records: [await api.read(identity, "healthCheck", undefined, signal)] };
  const paging = params.next;
  const query = new URLSearchParams();
  if (tool === "sophos_list_firewalls" || tool === "sophos_list_firewall_groups") {
    if (paging !== undefined && (typeof paging !== "number" || !Number.isSafeInteger(paging) || paging < 1)) throw invalidInput();
    query.set("page", String(paging ?? 1));
    query.set("pageSize", "50");
    query.set("pageTotal", "true");
    const response = await api.read(identity, tool === "sophos_list_firewalls" ? "firewalls" : "firewallGroups", query, signal);
    const pages = response.pages as { current?: number; total?: number } | undefined;
    return {
      records: items(response.items),
      page: { next: pages?.current && pages.total && pages.current < pages.total ? pages.current + 1 : undefined },
    };
  }
  if (paging !== undefined && (typeof paging !== "string" || paging.length > 2048)) throw invalidInput();
  if (tool === "sophos_list_events" || tool === "sophos_list_siem_alerts") {
    query.set("limit", "200");
    if (paging) query.set("cursor", paging);
    const response = await api.read(identity, tool === "sophos_list_events" ? "events" : "siemAlerts", query, signal);
    return {
      records: items(response.items),
      window: "Last 24 hours",
      page: { next: response.has_more === true && typeof response.next_cursor === "string" ? response.next_cursor : undefined },
    };
  }
  const endpoints = tool === "sophos_list_endpoints";
  for (const filter of endpoints ? endpointFilters : alertFilters) {
    const value = params[filter];
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    if (values.length > 25 || values.some((entry) =>
      (typeof entry !== "string" && typeof entry !== "boolean" && typeof entry !== "number") || String(entry).length > 2048,
    )) throw invalidInput();
    query.set(filter, values.join(","));
  }
  if (paging) query.set("pageFromKey", paging);
  query.set("pageSize", "50");
  const response = await api.read(identity, endpoints ? "endpoints" : "alerts", query, signal);
  const pages = response.pages as { nextKey?: unknown } | undefined;
  return { records: items(response.items), page: { next: typeof pages?.nextKey === "string" ? pages.nextKey : undefined } };
}

function items(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new SophosApiError("invalid-response", "Sophos Central did not return a list. Test the connection and try again.");
  }
  return value;
}
