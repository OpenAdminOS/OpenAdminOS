export interface SophosConnectionRecord {
  tenantId: string;
  connectionId: string;
  host: string;
  connectedAt: string;
  lastCheckedAt: string;
  issue?: "credentials" | "forbidden" | "rate-limit";
}

export interface SophosConnectionSummary extends SophosConnectionRecord {
  organizationId: string;
  region: string;
  unreadable?: true;
}

export interface ConnectSophosInput {
  organizationId: string;
  clientId: string;
  clientSecret: string;
}

export function isSophosRegionHost(value: unknown): value is string {
  return typeof value === "string" && /^api-[a-z]{2}[0-9]{2}\.central\.sophos\.com$(?![\s\S])/.test(value);
}

export function isSophosId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$(?![\s\S])/i.test(value);
}

export type SophosReadTool =
  | "sophos_list_endpoints"
  | "sophos_list_alerts"
  | "sophos_get_alert"
  | "sophos_list_events"
  | "sophos_list_siem_alerts"
  | "sophos_list_firewalls"
  | "sophos_list_firewall_groups"
  | "sophos_get_health_check";

export type SophosChangeKind = "isolate" | "release" | "scan";

export interface PrepareSophosChangeInput {
  organizationId: string;
  kind: SophosChangeKind;
  targetIds: string[];
  comment?: string;
}

export interface SophosTarget {
  id: string;
  hostname: string;
  isolationStatus: string;
}
