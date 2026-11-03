import type { SavedAppRegistration, TenantRecord } from "./openAdminOS.js";

export interface RegistrationSummary {
  /** Short text for rows and menus. */
  text: string;
  /** Full value, for the title attribute. */
  title: string;
}

function shortClientId(clientId: string): string {
  return `${clientId.slice(0, 8)}…`;
}

function directoryFromAuthority(authority: string | undefined): string | undefined {
  const segment = authority?.split("/").filter(Boolean).at(-1);
  return segment && segment !== "common" && segment !== "organizations" ? segment : undefined;
}

/**
 * Which app registration a tenant is connected with, as shown in Settings
 * and the tenant menu. The pilot tenant never signs in, so it has none.
 */
export function tenantRegistrationSummary(tenant: TenantRecord): RegistrationSummary | null {
  if (tenant.kind === "sample" || !tenant.appRegistration) return null;
  const { kind, clientId, authority, label } = tenant.appRegistration;
  if (kind === "openadminos") {
    // TODO(ugur): tenants connected before v0.5 are pinned to the Microsoft
    // Graph Command Line Tools client and show here as the OpenAdminOS app
    // with that client ID. Should they get their own name?
    return { text: "OpenAdminOS app", title: `OpenAdminOS app, client ID ${clientId}` };
  }
  const directory = directoryFromAuthority(authority);
  return {
    text: `Own app registration · ${label ?? shortClientId(clientId)}`,
    title: `Own app registration${label ? ` ${label}` : ""}, client ID ${clientId}${directory ? `, directory ${directory}` : ""}`,
  };
}

/** Display name of a remembered registration. */
export function savedRegistrationName(entry: SavedAppRegistration): string {
  return entry.label ?? entry.clientId;
}
