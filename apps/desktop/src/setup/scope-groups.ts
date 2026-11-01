import {
  PERMISSION_AREAS,
  type PermissionAreaId,
  type RequestedScope,
} from "../shared/openAdminOS";

export interface ScopeGroup {
  id: PermissionAreaId | "other";
  title: string;
  summary: string;
  required: boolean;
  scopes: RequestedScope[];
}

export const SCOPE_GROUP_BY_NAME: Readonly<Record<string, PermissionAreaId>> =
  Object.fromEntries(
    PERMISSION_AREAS.flatMap((area) =>
      area.scopes.map((scope) => [scope, area.id] as const),
    ),
  );

export function groupRequestedScopes(scopes: RequestedScope[]): ScopeGroup[] {
  const grouped = new Map<ScopeGroup["id"], RequestedScope[]>();
  for (const scope of scopes) {
    const id = SCOPE_GROUP_BY_NAME[scope.name] ?? "other";
    grouped.set(id, [...(grouped.get(id) ?? []), scope]);
  }

  const result: ScopeGroup[] = PERMISSION_AREAS.map((group) => ({
    ...group,
    scopes: grouped.get(group.id) ?? [],
  })).filter((group) => group.scopes.length > 0);
  const other = grouped.get("other");
  if (other?.length) {
    result.push({
      id: "other",
      title: "Other requested access",
      summary: "Additional read scopes declared by this OpenAdminOS version.",
      required: false,
      scopes: other,
    });
  }
  return result;
}
