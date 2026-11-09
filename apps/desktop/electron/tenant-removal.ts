import type { RunRecord, TenantAppRegistration, TenantRecord } from "@openadminos/agent-sdk";

/**
 * A disconnect whose cleanup has not finished. Written in the same state
 * write that removes the tenant, so the organization is gone at once and
 * cleanup (drain, sign-in removal, local data) resumes at the next launch
 * if it fails or the app quits. Holds only what cleanup needs.
 */
export interface TenantRemovalRecord {
  tenantId: string;
  displayName: string;
  kind?: "sample";
  appRegistration?: TenantAppRegistration;
  homeAccountId?: string;
  removedAt: string;
  /** Runs of the tenant at removal, so their report deliveries can be drained. */
  runIds?: string[];
  /** Why the last cleanup attempt did not finish. */
  error?: string;
}

export function tenantRemovalFor(
  tenant: TenantRecord,
  removedAt: string,
  runIds: readonly string[],
  options: { legacySample?: boolean } = {},
): TenantRemovalRecord {
  return {
    tenantId: tenant.id,
    displayName: tenant.displayName,
    // The sample tenant of removed pilot mode never signed in: nothing to remove at Microsoft.
    ...(options.legacySample ? { kind: "sample" as const } : {}),
    ...(tenant.appRegistration ? { appRegistration: tenant.appRegistration } : {}),
    ...(tenant.homeAccountId ? { homeAccountId: tenant.homeAccountId } : {}),
    removedAt,
    ...(runIds.length > 0 ? { runIds: [...runIds] } : {}),
  };
}

export function sanitizeTenantRemovals(raw: unknown): TenantRemovalRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const removals: TenantRemovalRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.tenantId !== "string" || !record.tenantId || typeof record.removedAt !== "string") continue;
    const registration = record.appRegistration;
    removals.push({
      tenantId: record.tenantId,
      displayName: typeof record.displayName === "string" ? record.displayName : record.tenantId,
      ...(record.kind === "sample" ? { kind: "sample" as const } : {}),
      ...(registration && typeof registration === "object" && !Array.isArray(registration) &&
        typeof (registration as { clientId?: unknown }).clientId === "string"
        ? { appRegistration: registration as TenantAppRegistration }
        : {}),
      ...(typeof record.homeAccountId === "string" ? { homeAccountId: record.homeAccountId } : {}),
      removedAt: record.removedAt,
      ...(Array.isArray(record.runIds) ? { runIds: record.runIds.filter((id): id is string => typeof id === "string") } : {}),
      ...(typeof record.error === "string" ? { error: record.error } : {}),
    });
  }
  return removals.length > 0 ? removals : undefined;
}

/** The tenant-scoped parts of the state file the write filter guards. */
export interface TenantScopedState {
  tenants: TenantRecord[];
  runs: RunRecord[];
  activeTenantId?: string;
  runDeliveryQueue?: Array<{ runId: string }>;
  novaConnectorAudit?: Array<{ tenantId: string }>;
  gateway?: { boundTenantId?: string };
}

/**
 * The persistence choke point of the state file. A write may remove
 * anything, but it may not add or change a record of a tenant that is
 * not writable for the calling work (closing, removed, or written by
 * work of an older generation): such a record keeps its previous
 * version, or is dropped when it had none. Returns what it dropped.
 */
export function filterClosedTenantChanges<T extends TenantScopedState>(
  next: T,
  before: TenantScopedState | undefined,
  writable: (tenantId: string) => boolean,
): { state: T; dropped: string[] } {
  const dropped: string[] = [];
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const guardList = <R extends { id: string }>(items: R[], previous: R[] | undefined, tenantOf: (item: R) => string | undefined, label: string): R[] => {
    const prior = new Map((previous ?? []).map((item) => [item.id, item]));
    const out: R[] = [];
    for (const item of items) {
      const tenantId = tenantOf(item);
      if (!tenantId || writable(tenantId)) { out.push(item); continue; }
      const old = prior.get(item.id);
      if (old && same(old, item)) { out.push(item); continue; }
      dropped.push(`${label} ${item.id}`);
      if (old && tenantOf(old) === tenantId) out.push(old);
    }
    return out;
  };
  const state = { ...next };
  state.tenants = guardList(next.tenants, before?.tenants, (tenant) => tenant.id, "tenant");
  state.runs = guardList(next.runs, before?.runs, (run) => run.tenantId, "run");
  const runTenant = new Map<string, string | undefined>();
  for (const run of [...(before?.runs ?? []), ...next.runs]) runTenant.set(run.id, run.tenantId);
  if (next.runDeliveryQueue) {
    const prior = new Set((before?.runDeliveryQueue ?? []).map((item) => JSON.stringify(item)));
    state.runDeliveryQueue = next.runDeliveryQueue.filter((item) => {
      const tenantId = runTenant.get(item.runId);
      if (!tenantId || writable(tenantId) || prior.has(JSON.stringify(item))) return true;
      dropped.push(`delivery ${item.runId}`);
      return false;
    });
  }
  if (next.novaConnectorAudit) {
    const prior = new Set((before?.novaConnectorAudit ?? []).map((item) => JSON.stringify(item)));
    state.novaConnectorAudit = next.novaConnectorAudit.filter((item) => {
      if (writable(item.tenantId) || prior.has(JSON.stringify(item))) return true;
      dropped.push("nova connector audit entry");
      return false;
    });
  }
  if (next.activeTenantId && !writable(next.activeTenantId) && next.activeTenantId !== before?.activeTenantId) {
    dropped.push(`active tenant ${next.activeTenantId}`);
    if (before?.activeTenantId && state.tenants.some((tenant) => tenant.id === before.activeTenantId)) state.activeTenantId = before.activeTenantId;
    else delete state.activeTenantId;
  }
  const bound = next.gateway?.boundTenantId;
  if (bound && !writable(bound) && bound !== before?.gateway?.boundTenantId) {
    dropped.push(`gateway binding ${bound}`);
    const { boundTenantId: _dropped, ...gateway } = next.gateway!;
    state.gateway = before?.gateway?.boundTenantId ? { ...gateway, boundTenantId: before.gateway.boundTenantId } : gateway;
  }
  return { state, dropped };
}

/**
 * Said when the same tenant is connected again while its earlier disconnect
 * is still cleaning up. The renderer offers Retry cleanup with it.
 */
export function tenantCleanupPendingMessage(removal: Pick<TenantRemovalRecord, "displayName" | "error">): string {
  return `Disconnecting ${removal.displayName} has not finished on this device${removal.error ? `: ${removal.error}` : "."} Retry cleanup on Connections, then connect again.`;
}
