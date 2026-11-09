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
  return name.length > ORGANIZATION_NAME_MAX_LENGTH
    ? name.slice(0, ORGANIZATION_NAME_MAX_LENGTH).trim()
    : name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function organizationFromTenant(tenant: TenantRecord): OrganizationRecord {
  return {
    id: organizationIdForTenant(tenant.id),
    name: normalizeOrganizationName(tenant.displayName) ?? "Organization",
    ...(tenant.kind === "sample" ? { kind: "sample" as const } : {}),
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
 * belongs to one organization, and the sample kind always follows the
 * tenant, never the stored record.
 *
 * Schedules: a state file from before organizations moves every schedule
 * to the organization of the real tenant that was active. With no tenant
 * active, or the pilot tenant active, schedules stay unassigned, which
 * pauses them until the admin assigns each one; they are never assigned
 * to the sample organization. After the move, a schedule whose
 * organization is gone or is the sample organization becomes unassigned.
 */
export function reconcileOrganizations(input: OrganizationReconcileInput): OrganizationReconcileResult {
  const migrated = !Array.isArray(input.rawOrganizations);
  const tenantsById = new Map(input.tenants.map((tenant) => [tenant.id, tenant]));
  const claimedTenants = new Set<string>();
  const usedIds = new Set<string>();
  const stored = new Map<string, OrganizationRecord>();
  const withoutMicrosoft365: OrganizationRecord[] = [];

  for (const raw of migrated ? [] : (input.rawOrganizations as unknown[])) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (id.length === 0 || id.length > 300 || usedIds.has(id)) continue;
    const connections = isRecord(raw.connections) ? raw.connections : undefined;
    const microsoft365 = connections && isRecord(connections.microsoft365) ? connections.microsoft365 : undefined;
    // Connections of services this version does not know stay untouched.
    const unknown: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(connections ?? {})) {
      if (key !== "microsoft365" && isRecord(value)) unknown[key] = value;
    }
    const tenantId = typeof microsoft365?.tenantId === "string" ? microsoft365.tenantId : undefined;
    const tenant = tenantId ? tenantsById.get(tenantId) : undefined;
    if (!tenant || claimedTenants.has(tenant.id)) {
      // An organization a newer version made without Microsoft 365 is kept
      // as it was; this version cannot select it.
      if (!tenant && Object.keys(unknown).length > 0) {
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
    usedIds.add(id);
    claimedTenants.add(tenant.id);
    stored.set(tenant.id, {
      id,
      // The sample organization always carries the pilot tenant's name.
      name: tenant.kind === "sample" ? fallback.name : normalizeOrganizationName(raw.name) ?? fallback.name,
      ...(tenant.kind === "sample" ? { kind: "sample" as const } : {}),
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
  const sampleIds = new Set(organizations.filter((organization) => organization.kind === "sample").map((organization) => organization.id));
  const activeTenant = input.activeTenantId ? tenantsById.get(input.activeTenantId) : undefined;
  const activeRealOrganization =
    activeTenant && activeTenant.kind !== "sample"
      ? organizations.find((organization) => organization.connections.microsoft365?.tenantId === activeTenant.id)
      : undefined;

  let assignedCount = 0;
  let unassignedCount = 0;
  const installedAgents = input.installedAgents.map((agent) => {
    const schedule = agent.schedule;
    if (!schedule) return agent;
    const { organizationId: current, ...rest } = schedule;
    const valid = typeof current === "string" && organizationIds.has(current) && !sampleIds.has(current);
    if (migrated) {
      // A schedule that already names a valid organization was assigned
      // by a newer version; keep it.
      const target = valid ? current : activeRealOrganization?.id;
      if (target) {
        assignedCount += 1;
        return { ...agent, schedule: { ...rest, organizationId: target } };
      }
      unassignedCount += 1;
      return { ...agent, schedule: rest };
    }
    if (valid) return agent;
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
          ? { unassignedReason: activeTenant?.kind === "sample" ? "pilot-active" as const : "no-active-tenant" as const }
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
    value.unassignedReason === "no-active-tenant" || value.unassignedReason === "pilot-active"
      ? value.unassignedReason
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
