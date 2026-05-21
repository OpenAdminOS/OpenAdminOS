import {
  InteractionRequiredAuthError,
  LogLevel,
  PublicClientApplication,
  type AuthenticationResult,
  type ICachePlugin,
  type InteractiveRequest,
  type SilentFlowRequest,
  type TokenCacheContext,
} from "@azure/msal-node";
import type { TenantSession } from "@openadminos/agent-sdk";

export const GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";
// Bundled at initial sign-in so the admin sees ONE Microsoft consent
// screen and every bundled read-only agent can run without a second
// consent prompt. Audited against every agent manifest under /agents
// (see `DEFAULT_SCOPE_METADATA` for which agent uses which scope).
// Write scopes are deliberately excluded — each write-mode agent
// requests its specific scope at install/run time, with a separate
// consent screen, per the project's trust policy.
export const DEFAULT_SCOPES = [
  "https://graph.microsoft.com/DeviceManagementManagedDevices.Read.All",
  "https://graph.microsoft.com/Organization.Read.All",
  "https://graph.microsoft.com/Directory.Read.All",
  "https://graph.microsoft.com/User.Read.All",
  "https://graph.microsoft.com/Policy.Read.All",
  "https://graph.microsoft.com/Application.Read.All",
  "https://graph.microsoft.com/AuditLog.Read.All",
  "https://graph.microsoft.com/IdentityRiskyUser.Read.All",
  "https://graph.microsoft.com/SecurityEvents.Read.All",
];

export interface RequestedScopeMetadata {
  name: string;
  mode: "read" | "write";
  rationale: string;
}

// User-facing rationale for the scope set requested at initial sign-in.
// Ordered to mirror what a manager scanning the consent screen would
// want to grok first (operational → identity/users → security).
//
// Agents the admin installs later from the registry that declare a
// scope NOT in this set will trigger an incremental MSAL consent
// prompt at install time. MSAL also adds the reserved scopes
// `openid`, `profile`, and `offline_access` on every interactive
// request — those are not admin-consent permissions and are surfaced
// in the UI as a small footnote, not as separate rows.
export const DEFAULT_SCOPE_METADATA: readonly RequestedScopeMetadata[] = [
  {
    name: "DeviceManagementManagedDevices.Read.All",
    mode: "read",
    rationale:
      "Reads Intune-enrolled devices and their state (compliance, OS version, last sync). Used by Compliance overview, Find inactive devices, OS update posture, and Tenant health report.",
  },
  {
    name: "Organization.Read.All",
    mode: "read",
    rationale:
      "Reads /subscribedSkus so the status strip can show which Entra ID tier (Free / P1 / P2) the tenant is on and badge agents that need P1 or P2 features.",
  },
  {
    name: "Directory.Read.All",
    mode: "read",
    rationale:
      "Reads directory metadata (users, groups, roles) so audit entries and policy targets can be rendered with human-readable names rather than raw object IDs.",
  },
  {
    name: "User.Read.All",
    mode: "read",
    rationale:
      "Reads user profile data — license assignment, location, last sign-in. Used by User license overview and as a prerequisite read for Stale guest cleanup.",
  },
  {
    name: "Policy.Read.All",
    mode: "read",
    rationale:
      "Reads conditional access and related tenant policies so the Conditional access explainer can describe what's enforced and why.",
  },
  {
    name: "Application.Read.All",
    mode: "read",
    rationale:
      "Reads registered apps in Entra so the Dormant app registrations agent can flag apps that haven't been used.",
  },
  {
    name: "AuditLog.Read.All",
    mode: "read",
    rationale:
      "Reads sign-in logs and directory audit events. Used by Sign-in failure explainer, Tenant change audit, and as a prerequisite read for Stale guest cleanup.",
  },
  {
    name: "IdentityRiskyUser.Read.All",
    mode: "read",
    rationale:
      "Reads Entra ID Protection's risky-user signals so the Risky sign-in triage agent can group and explain risk events. Requires Entra ID P2 to return data — the scope can still be consented on Free/P1 tenants but the agent will surface no results.",
  },
  {
    name: "SecurityEvents.Read.All",
    mode: "read",
    rationale:
      "Reads Microsoft Secure Score controls so the Secure score prioritizer can rank improvement actions by impact.",
  },
];

const SUCCESS_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>OpenAdminOS - sign-in complete</title>
    <style>
      :root { color-scheme: light dark; }
      html, body { margin: 0; padding: 0; height: 100%; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif; }
      body { display: flex; align-items: center; justify-content: center; background: #0a0c10; color: #e6e2d9; }
      .card { max-width: 420px; padding: 32px; border-radius: 16px; background: #131418; box-shadow: 0 10px 40px rgba(0,0,0,0.4); }
      h1 { margin: 0 0 12px 0; font-size: 18px; }
      p { margin: 0; font-size: 13.5px; line-height: 1.5; color: #9b958a; }
      .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #6fb98f; margin-right: 8px; vertical-align: middle; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1><span class="dot"></span>Sign-in complete</h1>
      <p>OpenAdminOS has received the authorization code. You can close this tab and return to the desktop app.</p>
    </div>
  </body>
</html>`;

const ERROR_TEMPLATE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>OpenAdminOS - sign-in failed</title></head>
  <body style="margin:0;font-family:system-ui;background:#0a0c10;color:#e6e2d9;display:flex;align-items:center;justify-content:center;height:100vh">
    <div style="max-width:420px;padding:32px;border-radius:16px;background:#131418">
      <h1 style="margin:0 0 12px 0;font-size:18px">Sign-in failed</h1>
      <p style="margin:0;font-size:13.5px;color:#9b958a">Return to the desktop app and try connecting again.</p>
    </div>
  </body>
</html>`;

export interface TokenCacheStorage {
  read(): Promise<string>;
  write(serialized: string): Promise<void>;
}

export function createCachePlugin(storage: TokenCacheStorage): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      const cached = await storage.read();
      if (cached.length > 0) {
        context.tokenCache.deserialize(cached);
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (context.cacheHasChanged) {
        await storage.write(context.tokenCache.serialize());
      }
    },
  };
}

export function createMsalClient(input: {
  storage: TokenCacheStorage;
  clientId?: string;
  authority?: string;
}): PublicClientApplication {
  return new PublicClientApplication({
    auth: {
      clientId: input.clientId ?? GRAPH_CLI_CLIENT_ID,
      authority: input.authority ?? DEFAULT_AUTHORITY,
    },
    cache: {
      cachePlugin: createCachePlugin(input.storage),
    },
    system: {
      loggerOptions: {
        logLevel: LogLevel.Warning,
        loggerCallback: () => undefined,
        piiLoggingEnabled: false,
      },
    },
  });
}

export interface InteractiveFlowInput {
  client: PublicClientApplication;
  scopes?: string[];
  openBrowser(url: string): Promise<void>;
  redirectUri?: string;
}

export async function runInteractiveFlow(
  input: InteractiveFlowInput,
): Promise<AuthenticationResult> {
  const scopes = input.scopes ?? DEFAULT_SCOPES;

  const request: InteractiveRequest = {
    scopes,
    openBrowser: input.openBrowser,
    successTemplate: SUCCESS_TEMPLATE,
    errorTemplate: ERROR_TEMPLATE,
  };
  if (input.redirectUri) {
    request.redirectUri = input.redirectUri;
  }

  const result = await input.client.acquireTokenInteractive(request);
  if (!result) {
    throw new Error("MSAL returned no authentication result.");
  }
  return result;
}

export async function acquireTokenSilent(input: {
  client: PublicClientApplication;
  homeAccountId: string;
  scopes?: string[];
}): Promise<AuthenticationResult> {
  const account = await input.client
    .getTokenCache()
    .getAccountByHomeId(input.homeAccountId);
  if (!account) {
    throw new Error(
      `No cached account for homeAccountId ${input.homeAccountId}. Reconnect the tenant.`,
    );
  }

  const request: SilentFlowRequest = {
    account,
    scopes: input.scopes ?? DEFAULT_SCOPES,
  };
  try {
    const result = await input.client.acquireTokenSilent(request);
    if (!result) {
      throw new Error("MSAL silent acquisition returned no result.");
    }
    return result;
  } catch (error) {
    if (error instanceof InteractionRequiredAuthError) {
      throw new Error(
        `Cached refresh token is no longer valid for ${input.homeAccountId}. Reconnect the tenant.`,
      );
    }
    throw error;
  }
}

export interface CreateTenantSessionInput {
  client: PublicClientApplication;
  tenantId: string;
  username: string;
  homeAccountId: string;
  /**
   * Optional fallback invoked when silent token acquisition fails for a
   * scope set the cache cannot satisfy (typically because the user has
   * not yet consented to those scopes). When supplied, the session
   * delegates to it to trigger an interactive consent flow. When
   * omitted, the session throws — Phase 3 connectors surface this as
   * a `ConnectorAuthError` and the host catches it to drive the
   * Connectors UI re-consent state.
   */
  acquireInteractive?: (
    scopes: string[],
  ) => Promise<AuthenticationResult>;
}

/**
 * Builds a `TenantSession` for the agent-sdk connector contract.
 *
 * `acquireTokenForScopes` calls MSAL silent acquisition first. If the
 * cache cannot mint a token for the requested scopes (typically
 * because the user has not yet consented), it either delegates to the
 * caller-supplied `acquireInteractive` fallback or rethrows the
 * underlying MSAL error so the connector wrapper can surface a
 * `ConnectorAuthError` with the recovery hint.
 */
export function createTenantSession(
  input: CreateTenantSessionInput,
): TenantSession {
  return {
    tenantId: input.tenantId,
    username: input.username,
    async acquireTokenForScopes(scopes: string[]): Promise<string> {
      try {
        const result = await acquireTokenSilent({
          client: input.client,
          homeAccountId: input.homeAccountId,
          scopes,
        });
        return result.accessToken;
      } catch (silentError) {
        const needsInteractive =
          silentError instanceof InteractionRequiredAuthError ||
          (silentError instanceof Error &&
            silentError.message.includes("is no longer valid")) ||
          (silentError instanceof Error &&
            silentError.message.includes("No cached account"));
        if (!needsInteractive || !input.acquireInteractive) {
          throw silentError;
        }
        const result = await input.acquireInteractive(scopes);
        return result.accessToken;
      }
    },
  };
}

export async function removeAccount(input: {
  client: PublicClientApplication;
  homeAccountId: string;
}): Promise<void> {
  const account = await input.client
    .getTokenCache()
    .getAccountByHomeId(input.homeAccountId);
  if (account) {
    await input.client.getTokenCache().removeAccount(account);
  }
}
