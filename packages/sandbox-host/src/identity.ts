import { classifyApplicationRoles, isSecretBearingRole, type ApplicationToken } from "@openadminos/runtime";

import { SandboxRefusal } from "./refusal.js";

const GRAPH_AUDIENCES = new Set(["https://graph.microsoft.com", "https://graph.microsoft.com/", "00000003-0000-0000-c000-000000000000"]);

/**
 * Every app-only Graph token carries this value in `wids`, also when the
 * service principal holds no directory role (verified in the lab tenant on
 * 2026-11-14: no role assignments, and no role definition with this id).
 * Any other value is a directory role assignment.
 */
const APP_ONLY_DEFAULT_WID = "0997a1d0-0d1d-4acb-b408-d5ca73121e90";

export interface IdentityExpectation {
  tenantId: string;
  clientId: string;
  /** The union of the scopes the configured agents declare; no other role is accepted. */
  allowedRoles: ReadonlySet<string>;
  /**
   * Configured agents that were refused this run, so their scopes are not
   * in `allowedRoles`. A role outside the allowlist is then named as that
   * gap, not as a permission to remove.
   */
  refusedAgents?: ReadonlyArray<{ id: string; reason: string }>;
}

/**
 * Checks a newly acquired app-only token before any Graph request uses
 * it. Runs on every token, so a permission granted between runs, or while
 * a run is going, refuses the next request.
 */
export function assertSandboxIdentity(token: ApplicationToken, expected: IdentityExpectation): void {
  const claims = token.claims;
  if (claims.idtyp !== "app") {
    throw new SandboxRefusal("identity-not-app", `The token is not an app-only token (idtyp is ${JSON.stringify(claims.idtyp ?? null)}). The sandbox signs in only as its own app registration.`);
  }
  if (typeof claims.tid !== "string" || claims.tid.toLowerCase() !== expected.tenantId) {
    throw new SandboxRefusal("identity-tenant-mismatch", `The token is for tenant ${String(claims.tid)}, not the configured tenant ${expected.tenantId}. Check tenantId in the sandbox config.`);
  }
  const appId = typeof claims.appid === "string" ? claims.appid : typeof claims.azp === "string" ? claims.azp : undefined;
  if (!appId || appId.toLowerCase() !== expected.clientId) {
    throw new SandboxRefusal("identity-client-mismatch", `The token is for app ${appId ?? "(none)"}, not the configured app ${expected.clientId}. Check clientId in the sandbox config.`);
  }
  if (typeof claims.aud !== "string" || !GRAPH_AUDIENCES.has(claims.aud)) {
    throw new SandboxRefusal("identity-audience-not-graph", `The token is for ${String(claims.aud)}, not Microsoft Graph. The sandbox requests Graph tokens only.`);
  }
  const directoryRoles = Array.isArray(claims.wids)
    ? claims.wids.filter((wid) => typeof wid !== "string" || wid.toLowerCase() !== APP_ONLY_DEFAULT_WID)
    : claims.wids === undefined ? [] : [claims.wids];
  if (directoryRoles.length > 0) {
    throw new SandboxRefusal(
      "identity-has-directory-roles",
      "The sandbox app holds a Microsoft Entra directory role. A directory role reaches far past the agents it runs. Remove the role assignment from the service principal, then run again.",
    );
  }
  const roles = token.roles;
  if (roles.length === 0) {
    throw new SandboxRefusal(
      "identity-has-no-roles",
      "The sandbox app holds no application permissions, so it can read nothing. Grant the Read permissions the configured agents need, with admin consent, then run again.",
    );
  }
  const { changing } = classifyApplicationRoles(roles);
  if (changing.length > 0) {
    throw new SandboxRefusal(
      "identity-can-change-tenant",
      `The sandbox app holds ${changing.length === 1 ? "a permission" : "permissions"} that can change the tenant: ${changing.join(", ")}. A sandbox runs only with Read permissions. Remove ${changing.length === 1 ? "it" : "them"} from the app registration and revoke admin consent, then run again.`,
    );
  }
  const secret = roles.filter(isSecretBearingRole);
  if (secret.length > 0) {
    throw new SandboxRefusal(
      "identity-holds-secret-permission",
      `The sandbox app holds ${secret.length === 1 ? "a permission" : "permissions"} that read secrets or personal content: ${secret.join(", ")}. No sandbox agent needs ${secret.length === 1 ? "it" : "them"}. Remove ${secret.length === 1 ? "it" : "them"}, then run again.`,
    );
  }
  const extra = roles.filter((role) => !expected.allowedRoles.has(role));
  if (extra.length > 0 && (expected.refusedAgents?.length ?? 0) > 0) {
    const refused = (expected.refusedAgents ?? []).map((agent) => `${agent.id} (${agent.reason})`).join(", ");
    throw new SandboxRefusal(
      "identity-allowlist-incomplete",
      `The sandbox app holds ${extra.join(", ")}, which no agent that passed its checks declares. These configured agents were refused, so their permissions could not be counted: ${refused}. Fix or re-pin them, then run again.`,
    );
  }
  if (extra.length > 0) {
    throw new SandboxRefusal(
      "identity-holds-unneeded-permission",
      `The sandbox app holds ${extra.length === 1 ? "a permission" : "permissions"} no configured agent declares: ${extra.join(", ")}. Grant only what the agents need. Remove ${extra.length === 1 ? "it" : "them"}, then run again.`,
    );
  }
}

/** Refuses an agent that declares a scope the identity was not granted. */
export function assertAgentPermissions(roles: readonly string[], agentName: string, scopes: readonly string[]): void {
  const held = new Set(roles);
  const missing = scopes.filter((scope) => !held.has(scope));
  if (missing.length > 0) {
    throw new SandboxRefusal(
      "identity-missing-permission",
      `${agentName} needs ${missing.join(", ")}, which the sandbox app was not granted. Add ${missing.length === 1 ? "it" : "them"} as application permissions with admin consent, then run again.`,
    );
  }
}
