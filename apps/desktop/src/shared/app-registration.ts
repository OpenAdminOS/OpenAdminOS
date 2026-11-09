import {
  OPENADMINOS_APP_CLIENT_ID,
  type SavedAppRegistration,
  type TenantRecord,
} from "./openAdminOS.js";

/**
 * Microsoft Graph Command Line Tools. Tenants connected before v0.5 are
 * pinned to this client so their refresh tokens keep working, and that is
 * the app their tenant lists in Enterprise applications and sign-in logs.
 */
const LEGACY_GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";

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
 * and the tenant menu.
 */
export function tenantRegistrationSummary(tenant: TenantRecord): RegistrationSummary | null {
  if (!tenant.appRegistration) return null;
  const { kind, clientId, authority, label } = tenant.appRegistration;
  if (kind === "openadminos") {
    if (clientId === OPENADMINOS_APP_CLIENT_ID) {
      return { text: "OpenAdminOS app", title: `OpenAdminOS app, client ID ${clientId}` };
    }
    if (clientId === LEGACY_GRAPH_CLI_CLIENT_ID) {
      return {
        text: "Microsoft Graph Command Line Tools",
        title: `Microsoft Graph Command Line Tools, client ID ${clientId}. Connected before v0.5. Reconnect to use the OpenAdminOS app or your own app registration.`,
      };
    }
    return { text: `App registration · ${shortClientId(clientId)}`, title: `App registration, client ID ${clientId}` };
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
