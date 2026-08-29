import {
  AuthError,
  type AuthorizeResponse,
  InteractionRequiredAuthError,
  LogLevel,
  PublicClientApplication,
  type AuthenticationResult,
  type ICachePlugin,
  type ILoopbackClient,
  type InteractiveRequest,
  type SilentFlowRequest,
  type TokenCacheContext,
} from "@azure/msal-node";
import { createServer, type Server } from "node:http";
import {
  DEFAULT_GRAPH_READ_SCOPE_NAMES,
  type TenantSession,
} from "@openadminos/agent-sdk";

export const GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";
// Bundled at initial sign-in so the admin sees ONE Microsoft consent
// screen, every bundled read-only agent can run without a second
// consent prompt, and Intune Chat can refresh its core read-only cache
// without discovering missing scopes during an answer. Audited against
// every agent manifest under /agents plus the Intune Chat Graph cache
// planner (see `DEFAULT_SCOPE_METADATA` for which feature uses which scope).
// Write scopes are deliberately excluded. Each write-mode agent
// requests its specific scope at install/run time, with a separate
// consent screen, per the project's trust policy.
export const DEFAULT_SCOPES = DEFAULT_GRAPH_READ_SCOPE_NAMES.map(
  (name) => `https://graph.microsoft.com/${name}`,
);

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
// request. Those are not admin-consent permissions and are surfaced
// in the UI as a small footnote, not as separate rows.
export const DEFAULT_SCOPE_METADATA: readonly RequestedScopeMetadata[] = [
  {
    name: "DeviceManagementManagedDevices.Read.All",
    mode: "read",
    rationale:
      "Reads Intune-enrolled devices, detected apps, troubleshooting events, and fleet status. Used by Compliance overview, Find inactive devices, OS update posture, Tenant health report, and Intune Chat device investigations.",
  },
  {
    name: "DeviceManagementConfiguration.Read.All",
    mode: "read",
    rationale:
      "Reads Intune compliance policies, configuration profiles, settings catalog policies, update policies, endpoint security intents, assignment filters, administrative templates, and encryption-state resources for Intune Chat.",
  },
  {
    name: "DeviceManagementApps.Read.All",
    mode: "read",
    rationale:
      "Reads Intune apps, managed app policies, app protection policies, and app configuration policies so Intune Chat can answer deployment, Company Portal, and mobile app protection questions.",
  },
  {
    name: "DeviceManagementServiceConfig.Read.All",
    mode: "read",
    rationale:
      "Reads Intune service configuration resources including Windows Autopilot devices, Autopilot deployment profiles, and enrollment configurations.",
  },
  {
    name: "DeviceManagementScripts.Read.All",
    mode: "read",
    rationale:
      "Reads Intune remediation scripts and platform scripts so Intune Chat can explain assignment, execution, and reporting gaps without requesting write permissions.",
  },
  {
    name: "DeviceManagementRBAC.Read.All",
    mode: "read",
    rationale:
      "Reads Intune role scope tags so Intune Chat can explain policy visibility and scope-tag targeting.",
  },
  {
    name: "Device.Read.All",
    mode: "read",
    rationale:
      "Reads Entra device objects for stale-device correlation, Autopilot matching, and Intune-vs-Entra inventory comparisons.",
  },
  {
    name: "GroupMember.Read.All",
    mode: "read",
    rationale:
      "Reads group objects and membership signals used by Intune assignments, app targeting, filters, and policy coverage questions.",
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
      "Reads user profile data: license assignment, location, and last sign-in. Used by User license overview and as a prerequisite read for Stale guest cleanup.",
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
      "Reads Entra ID Protection's risky-user signals so the Risky sign-in triage agent can group and explain risk events. Requires Entra ID P2 to return data; the scope can still be consented on Free/P1 tenants but the agent will surface no results.",
  },
  {
    name: "SecurityEvents.Read.All",
    mode: "read",
    rationale:
      "Reads Microsoft Secure Score controls so the Secure score prioritizer can rank improvement actions by impact.",
  },
  {
    name: "RoleManagement.Read.Directory",
    mode: "read",
    rationale:
      "Reads Entra directory roles so Chat can answer which admin roles exist and how policies target privileged users. Never modifies role assignments.",
  },
  {
    name: "AdministrativeUnit.Read.All",
    mode: "read",
    rationale:
      "Reads administrative units so scoped-administration questions can be answered with the tenant's actual delegation structure.",
  },
  {
    name: "Domain.Read.All",
    mode: "read",
    rationale:
      "Reads verified domains and their authentication type so Chat can explain federation and domain configuration questions.",
  },
  {
    name: "SecurityAlert.Read.All",
    mode: "read",
    rationale:
      "Reads Microsoft Defender alerts so Chat can summarize open alerts by severity and service. Alert data is read-only; triage actions are never taken.",
  },
  {
    name: "SecurityIncident.Read.All",
    mode: "read",
    rationale:
      "Reads Microsoft Defender incidents so Chat can report incident status, classification, and assignment. Incidents are never modified.",
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
  clear?(): Promise<void>;
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
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class TenantConnectCancelledError extends Error {
  constructor() {
    super("Tenant sign-in was cancelled.");
    this.name = "TenantConnectCancelledError";
  }
}

export class TenantConnectTimeoutError extends Error {
  constructor() {
    super("Tenant sign-in timed out while waiting for Microsoft.");
    this.name = "TenantConnectTimeoutError";
  }
}

class AbortableLoopbackClient implements ILoopbackClient {
  private server: Server | undefined;
  private settled = false;
  private rejectListener: ((reason: Error) => void) | undefined;
  private timeout: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly signal?: AbortSignal,
    private readonly timeoutMs?: number,
  ) {}

  listenForAuthCode(
    successTemplate?: string,
    errorTemplate?: string,
  ): Promise<AuthorizeResponse> {
    if (this.server) throw new Error("A tenant sign-in listener is already running.");

    return new Promise<AuthorizeResponse>((resolve, reject) => {
      this.rejectListener = reject;
      const finish = (result: AuthorizeResponse) => {
        if (this.settled) return;
        this.settled = true;
        this.cleanupWaiters();
        resolve(result);
      };
      const fail = (error: Error) => {
        if (this.settled) return;
        this.settled = true;
        this.cleanupWaiters();
        this.closeServer();
        reject(error);
      };

      this.server = createServer((request, response) => {
        const requestUrl = request.url;
        if (!requestUrl) {
          response.end(errorTemplate ?? "Microsoft sign-in did not return a redirect URL.");
          fail(new Error("Microsoft sign-in did not return a redirect URL."));
          return;
        }
        if (requestUrl === "/") {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(successTemplate ?? "Sign-in complete. You can close this window.");
          return;
        }

        const parsed = new URL(requestUrl, this.getRedirectUri());
        const result = Object.fromEntries(parsed.searchParams.entries()) as AuthorizeResponse;
        if (result.code) {
          response.writeHead(302, { location: this.getRedirectUri() });
          response.end();
          finish(result);
        } else if (result.error) {
          response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(errorTemplate ?? "Microsoft sign-in did not complete.");
          finish(result);
        } else {
          // Browsers often request /favicon.ico while the authorization tab is
          // open. It is not an OAuth response and must not settle the flow.
          response.writeHead(204);
          response.end();
        }
      });
      this.server.once("error", (error) => fail(error));
      this.server.listen(0, "localhost");

      if (this.signal?.aborted) {
        fail(new TenantConnectCancelledError());
        return;
      }
      this.signal?.addEventListener("abort", this.handleAbort, { once: true });
      if (this.timeoutMs && this.timeoutMs > 0) {
        this.timeout = setTimeout(
          () => fail(new TenantConnectTimeoutError()),
          this.timeoutMs,
        );
        this.timeout.unref?.();
      }
    });
  }

  getRedirectUri(): string {
    const address = this.server?.address();
    if (!this.server?.listening || !address) {
      // MSAL polls getRedirectUri while the ephemeral listener starts and only
      // retries this documented error code.
      throw new AuthError(
        "no_loopback_server_exists",
        "",
        "The local Microsoft sign-in listener is not ready.",
      );
    }
    if (typeof address === "string") {
      throw new Error("The local Microsoft sign-in listener did not bind to a TCP port.");
    }
    return `http://localhost:${address.port}`;
  }

  closeServer(): void {
    this.cleanupWaiters();
    if (!this.server) return;
    if (this.server.listening) this.server.close();
    this.server.closeAllConnections?.();
    this.server.unref();
    this.server = undefined;
  }

  private readonly handleAbort = () => {
    if (this.settled) return;
    const reject = this.rejectListener;
    this.settled = true;
    this.cleanupWaiters();
    this.closeServer();
    reject?.(new TenantConnectCancelledError());
  };

  private cleanupWaiters(): void {
    this.signal?.removeEventListener("abort", this.handleAbort);
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = undefined;
    this.rejectListener = undefined;
  }
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
    loopbackClient: new AbortableLoopbackClient(input.signal, input.timeoutMs),
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
   * omitted, the session throws. Phase 3 connectors surface this as
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
