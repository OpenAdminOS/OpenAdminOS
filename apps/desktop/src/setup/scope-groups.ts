import {
  AVAILABLE_SERVICES,
  type RequestedScope,
  type ServiceId,
} from "../shared/openAdminOS";

export interface ScopeGroup {
  id: ServiceId | "other";
  title: string;
  summary: string;
  /** One row per scope name. A scope several parts share is listed once. */
  scopes: RequestedScope[];
}

/**
 * Groups the requested scope rows by service, in registry order. Rows of
 * a service this version does not know land in an Other group so nothing
 * requested is hidden.
 */
export function groupRequestedScopes(scopes: RequestedScope[]): ScopeGroup[] {
  const known = new Set<string>(AVAILABLE_SERVICES.map((service) => service.id));
  const grouped = new Map<ScopeGroup["id"], Map<string, RequestedScope>>();
  for (const scope of scopes) {
    const id = known.has(scope.service) ? scope.service : "other";
    const rows = grouped.get(id) ?? new Map<string, RequestedScope>();
    if (!rows.has(scope.name)) rows.set(scope.name, scope);
    grouped.set(id, rows);
  }

  const result: ScopeGroup[] = AVAILABLE_SERVICES.flatMap((service) => {
    const rows = grouped.get(service.id);
    return rows
      ? [{ id: service.id, title: service.title, summary: service.summary, scopes: [...rows.values()] }]
      : [];
  });
  const other = grouped.get("other");
  if (other?.size) {
    result.push({
      id: "other",
      title: "Other requested access",
      summary: "Additional read scopes declared by this OpenAdminOS version.",
      scopes: [...other.values()],
    });
  }
  return result;
}
