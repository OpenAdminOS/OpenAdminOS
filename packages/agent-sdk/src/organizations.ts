import type {
  AgentSummary,
  OrganizationMigrationNotice,
  OrganizationRecord,
  TenantRecord,
} from "./index.js";

/** Longest organization name the host accepts. */
export const ORGANIZATION_NAME_MAX_LENGTH = 80;

/**
 * Organizations sit above `TenantRecord`, which stays the Microsoft 365
 * connection. An organization holds at most one tenant today, and the
 * active organization is the one that holds the active tenant, so every
 * store keyed by tenant id (runs, conversations, cache, drift, Agent
 * Team) keeps working unchanged.
 *
 * `read()` reconciles organizations on every read and does not persist,
 * so everything here is deterministic: organization ids derive from the
 * tenant id and creation times from the tenant's `addedAt`. Reading a
 * state file twice gives the same result, and the first write persists it.
 */

/** The id of the organization created by connecting this tenant. */
export function organizationIdForTenant(tenantId: string): string {
  return `org-${tenantId}`;
}

/** Trims and collapses whitespace; undefined when nothing usable is left. */
export function normalizeOrganizationName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters never belong in a name shown across the shell.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (name.length === 0) return undefined;
  // Count and cut by code points, so a character outside the basic plane
  // is never split into half a surrogate pair.
  const codePoints = [...name];
  return codePoints.length > ORGANIZATION_NAME_MAX_LENGTH
    ? codePoints.slice(0, ORGANIZATION_NAME_MAX_LENGTH).join("").trim()
    : name;
}

/** Length of a name in code points, as the limit counts it. */
export function organizationNameLength(name: string): number {
  return [...name].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function organizationFromTenant(tenant: TenantRecord): OrganizationRecord {
  return {
    id: organizationIdForTenant(tenant.id),
    name: normalizeOrganizationName(tenant.displayName) ?? "Organization",
    createdAt: tenant.addedAt,
    connections: { microsoft365: { tenantId: tenant.id } },
  };
}

export interface OrganizationReconcileInput {
  /** `parsed.organizations`. Not an array means a state file from before organizations. */
  rawOrganizations: unknown;
  rawNotice: unknown;
  /** Already sanitized tenants. */
  tenants: readonly TenantRecord[];
  activeTenantId?: string | undefined;
  installedAgents: readonly AgentSummary[];
}

export interface OrganizationReconcileResult {
  organizations: OrganizationRecord[];
  installedAgents: AgentSummary[];
  notice?: OrganizationMigrationNotice;
  /** True when the input had no organizations list and was migrated now. */
  migrated: boolean;
}

/**
 * Validates stored organizations against the tenants and creates one for
 * every tenant without one. A stored record is kept only when it is well
 * formed and its Microsoft 365 tenant still exists; an organization with
 * no connection left is removed, as a tenant's data is today. Each tenant
 * belongs to one organization.
 *
 * Schedules: a state file from before organizations moves every schedule
 * to the organization of the tenant that was active. With no tenant
 * active, schedules stay unassigned, which pauses them until the admin
 * assigns each one. After the move, a schedule whose organization is gone
 * becomes unassigned.
 */
export function reconcileOrganizations(input: OrganizationReconcileInput): OrganizationReconcileResult {
  const migrated = !Array.isArray(input.rawOrganizations);
  const tenantsById = new Map(input.tenants.map((tenant) => [tenant.id, tenant]));
  const claimedTenants = new Set<string>();
  const usedIds = new Set<string>();
  const stored = new Map<string, OrganizationRecord>();
  const withoutMicrosoft365: OrganizationRecord[] = [];

  // A record whose id is missing, too long or already taken keeps its
  // connections under a fresh, deterministic id instead of being dropped.
  const freshId = (base: string) => {
    let id = base;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
    return id;
  };
  // An over-long id replaced here maps to its new id, so a schedule that
  // named it stays with the same record. A duplicate id is ambiguous and
  // is not remapped: a short one stays with the first record, which keeps
  // it, and an over-long one shared by several kept records leaves a
  // schedule naming it unassigned. Only records that are kept count: a
  // dropped record never makes an id ambiguous.
  const keptLongIds = new Map<string, number>();
  const replacedIds = new Map<string, string>();
  // An over-long id that raw records use for different tenants, or for a
  // tenant and for none, is ambiguous even when only one of them is kept.
  const longIdTenants = new Map<string, Set<string>>();
  for (const raw of migrated ? [] : (input.rawOrganizations as unknown[])) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim().length <= 300) continue;
    const connections = isRecord(raw.connections) ? raw.connections : undefined;
    const microsoft365 = connections && isRecord(connections.microsoft365) ? connections.microsoft365 : undefined;
    const tenantKey = typeof microsoft365?.tenantId === "string" ? `tenant:${microsoft365.tenantId}` : "none";
    const id = raw.id.trim();
    longIdTenants.set(id, (longIdTenants.get(id) ?? new Set()).add(tenantKey));
  }
  const keepId = (rawId: string, idUsable: boolean, base: string) => {
    if (idUsable) return rawId;
    const id = freshId(base);
    if (rawId.length > 300 && (longIdTenants.get(rawId)?.size ?? 0) <= 1) {
      const seen = (keptLongIds.get(rawId) ?? 0) + 1;
      keptLongIds.set(rawId, seen);
      if (seen === 1) replacedIds.set(rawId, id);
      else replacedIds.delete(rawId);
    }
    return id;
  };
  let kept = 0;
  for (const raw of migrated ? [] : (input.rawOrganizations as unknown[])) {
    if (!isRecord(raw)) continue;
    const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
    const idUsable = rawId.length > 0 && rawId.length <= 300 && !usedIds.has(rawId);
    const connections = isRecord(raw.connections) ? raw.connections : undefined;
    const microsoft365 = connections && isRecord(connections.microsoft365) ? connections.microsoft365 : undefined;
    // Connections of services this version does not know stay untouched,
    // whatever their shape.
    const unknown: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(connections ?? {})) {
      if (key !== "microsoft365" && value !== undefined) unknown[key] = value;
    }
    const tenantId = typeof microsoft365?.tenantId === "string" ? microsoft365.tenantId : undefined;
    const tenant = tenantId ? tenantsById.get(tenantId) : undefined;
    // A second record for a tenant that is already claimed loses, but its
    // unknown connections move to the winner instead of being dropped.
    if (tenant && claimedTenants.has(tenant.id)) {
      const winner = stored.get(tenant.id);
      if (winner) {
        for (const [key, value] of Object.entries(unknown)) {
          if (!(key in winner.connections)) winner.connections[key] = value;
        }
      }
      continue;
    }
    if (!tenant) {
      // An organization a newer version made without Microsoft 365 is kept
      // as it was; this version cannot select it.
      if (Object.keys(unknown).length > 0) {
        kept += 1;
        const id = keepId(rawId, idUsable, `org-kept-${kept}`);
        usedIds.add(id);
        withoutMicrosoft365.push({
          id,
          name: normalizeOrganizationName(raw.name) ?? "Organization",
          createdAt: typeof raw.createdAt === "string" && raw.createdAt.length > 0 ? raw.createdAt : "",
          connections: unknown,
        });
      }
      continue;
    }
    const fallback = organizationFromTenant(tenant);
    const id = keepId(rawId, idUsable, fallback.id);
    usedIds.add(id);
    claimedTenants.add(tenant.id);
    stored.set(tenant.id, {
      id,
      name: normalizeOrganizationName(raw.name) ?? fallback.name,
      createdAt: typeof raw.createdAt === "string" && raw.createdAt.length > 0 ? raw.createdAt : fallback.createdAt,
      connections: { ...unknown, microsoft365: { tenantId: tenant.id } },
    });
  }

  const fromTenants = input.tenants.map((tenant) => {
    const existing = stored.get(tenant.id);
    if (existing) return existing;
    const created = organizationFromTenant(tenant);
    // A hand-edited file could already use the derived id for another
    // tenant; keep ids unique without dropping either organization.
    let id = created.id;
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${created.id}-${suffix}`;
    usedIds.add(id);
    return { ...created, id };
  });
  const organizations = [...fromTenants, ...withoutMicrosoft365];

  const organizationIds = new Set(organizations.map((organization) => organization.id));
  const activeTenant = input.activeTenantId ? tenantsById.get(input.activeTenantId) : undefined;
  const activeRealOrganization = activeTenant
    ? organizations.find((organization) => organization.connections.microsoft365?.tenantId === activeTenant.id)
    : undefined;

  let assignedCount = 0;
  let unassignedCount = 0;
  const installedAgents = input.installedAgents.map((agent) => {
    const schedule = agent.schedule;
    if (!schedule) return agent;
    const { organizationId: current, ...rest } = schedule;
    const valid = typeof current === "string" && organizationIds.has(current);
    if (migrated) {
      // A schedule that already names a valid organization was assigned
      // by a newer version; keep it, and do not count it as moved.
      if (valid) return agent;
      if (activeRealOrganization) {
        assignedCount += 1;
        return { ...agent, schedule: { ...rest, organizationId: activeRealOrganization.id } };
      }
      unassignedCount += 1;
      return { ...agent, schedule: rest };
    }
    if (valid) return agent;
    const replacement = typeof current === "string" ? replacedIds.get(current) : undefined;
    if (replacement) return { ...agent, schedule: { ...rest, organizationId: replacement } };
    return current === undefined ? agent : { ...agent, schedule: rest };
  });

  let notice: OrganizationMigrationNotice | undefined;
  if (migrated) {
    if (assignedCount + unassignedCount > 0) {
      notice = {
        assignedCount,
        ...(assignedCount > 0 && activeRealOrganization ? { assignedOrganizationId: activeRealOrganization.id } : {}),
        unassignedCount,
        ...(unassignedCount > 0
          ? { unassignedReason: "no-active-tenant" as const }
          : {}),
      };
    }
  } else {
    notice = sanitizeMigrationNotice(input.rawNotice, organizationIds);
  }

  return { organizations, installedAgents, ...(notice ? { notice } : {}), migrated };
}

function sanitizeMigrationNotice(
  value: unknown,
  organizationIds: ReadonlySet<string>,
): OrganizationMigrationNotice | undefined {
  if (!isRecord(value)) return undefined;
  const count = (raw: unknown) =>
    typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 10_000 ? raw : undefined;
  const assignedCount = count(value.assignedCount);
  const unassignedCount = count(value.unassignedCount);
  if (assignedCount === undefined || unassignedCount === undefined) return undefined;
  if (assignedCount + unassignedCount === 0) return undefined;
  const reason =
    // "pilot-active" from before pilot mode was removed reads as no active tenant.
    value.unassignedReason === "no-active-tenant" || value.unassignedReason === "pilot-active"
      ? ("no-active-tenant" as const)
      : undefined;
  return {
    assignedCount,
    ...(typeof value.assignedOrganizationId === "string" && organizationIds.has(value.assignedOrganizationId)
      ? { assignedOrganizationId: value.assignedOrganizationId }
      : {}),
    unassignedCount,
    ...(unassignedCount > 0 && reason ? { unassignedReason: reason } : {}),
  };
}

/** The organization that holds the tenant, when there is one. */
export function organizationForTenant(
  organizations: readonly OrganizationRecord[],
  tenantId: string | undefined,
): OrganizationRecord | undefined {
  if (!tenantId) return undefined;
  return organizations.find((organization) => organization.connections.microsoft365?.tenantId === tenantId);
}

/**
 * Organizations for display: the stored list reconciled with the tenants,
 * so a tenant always has an organization even before the host has sent
 * one, and an organization whose tenant is gone is never shown.
 */
export function resolveOrganizations(state: {
  organizations?: readonly OrganizationRecord[] | undefined;
  tenants: readonly TenantRecord[];
}): OrganizationRecord[] {
  return reconcileOrganizations({
    rawOrganizations: state.organizations ? [...state.organizations] : [],
    rawNotice: undefined,
    tenants: state.tenants,
    installedAgents: [],
  }).organizations;
}

/** The organization that holds the active tenant, or undefined for "No organization". */
export function activeOrganizationOf(state: {
  organizations?: readonly OrganizationRecord[] | undefined;
  tenants: readonly TenantRecord[];
  activeTenantId?: string | undefined;
}): OrganizationRecord | undefined {
  return organizationForTenant(resolveOrganizations(state), state.activeTenantId);
}

/**
 * True when a schedule may run now: it is assigned, and its organization
 * is the active one. Unassigned schedules and other organizations' wait.
 */
export function scheduleRunsInActiveOrganization(
  schedule: { organizationId?: string | undefined } | undefined,
  activeOrganizationId: string | undefined,
): boolean {
  return Boolean(schedule?.organizationId) && schedule?.organizationId === activeOrganizationId;
}
