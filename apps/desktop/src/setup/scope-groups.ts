import {
  AVAILABLE_SERVICES,
  SERVICE_PARTS,
  type RequestedScope,
  type ServiceId,
} from "../shared/openAdminOS";

export interface ScopePartGroup {
  id: string;
  title: string;
  summary: string;
  /** One row per scope name within the part. */
  scopes: RequestedScope[];
}

export interface ScopeGroup {
  id: ServiceId | "other";
  title: string;
  summary: string;
  parts: ScopePartGroup[];
  /** One row per scope name. A scope several parts share is listed once. */
  scopes: RequestedScope[];
}

/**
 * Groups the requested scope rows by service and part, in registry order.
 * A scope that several parts share, such as User.Read.All, is listed under
 * each part that requests it. Rows of a service or part this version does
 * not know land in an Other group so nothing requested is hidden.
 */
export function groupRequestedScopes(scopes: RequestedScope[]): ScopeGroup[] {
  const knownParts = new Map(SERVICE_PARTS.map((part) => [part.id, part]));
  const byPart = new Map<string, Map<string, RequestedScope>>();
  const other = new Map<string, RequestedScope>();
  for (const scope of scopes) {
    const part = knownParts.get(scope.partId);
    if (!part || part.service !== scope.service) {
      if (!other.has(scope.name)) other.set(scope.name, scope);
      continue;
    }
    const rows = byPart.get(part.id) ?? new Map<string, RequestedScope>();
    if (!rows.has(scope.name)) rows.set(scope.name, scope);
    byPart.set(part.id, rows);
  }

  const result: ScopeGroup[] = AVAILABLE_SERVICES.flatMap((service) => {
    const parts = SERVICE_PARTS.filter((part) => part.service === service.id).flatMap(
      (part) => {
        const rows = byPart.get(part.id);
        return rows
          ? [{ id: part.id, title: part.title, summary: part.summary, scopes: [...rows.values()] }]
          : [];
      },
    );
    if (parts.length === 0) return [];
    return [
      {
        id: service.id,
        title: service.title,
        summary: service.summary,
        parts,
        scopes: uniqueByName(parts.flatMap((part) => part.scopes)),
      },
    ];
  });
  if (other.size > 0) {
    const rows = [...other.values()];
    result.push({
      id: "other",
      title: "Other requested access",
      summary: "Additional read scopes declared by this OpenAdminOS version.",
      parts: [
        {
          id: "other",
          title: "Other",
          summary: "Scopes outside the known services.",
          scopes: rows,
        },
      ],
      scopes: rows,
    });
  }
  return result;
}

function uniqueByName(rows: RequestedScope[]): RequestedScope[] {
  return [...new Map(rows.map((row) => [row.name, row] as const)).values()];
}
