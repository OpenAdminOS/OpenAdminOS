import { awaitWithSignal } from "./cancellation.js";
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

/**
 * The OpenAdminOS multi-tenant app registration: public client,
 * `http://localhost` loopback redirect, public-client flows enabled,
 * delegated read scopes only.
 *
 * An application (client) id is a public identifier, not a secret. It
 * appears in every authorization URL the browser sees, so shipping it
 * in the open is expected for a public client.
 */
export const OPENADMINOS_CLIENT_ID = "d1de0a94-f67a-421d-8804-a235955ffd69";

/** The client id the app signs in with when the user does not bring their own. */
export function defaultClientId(): string {
  return OPENADMINOS_CLIENT_ID || GRAPH_CLI_CLIENT_ID;
}

export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";

/**
 * Build the MSAL authority for a bring-your-own registration. Custom
 * apps registered as single-tenant must authenticate against their own
 * directory; multi-tenant apps use /common.
 */
export function authorityForDirectory(directoryTenantId?: string): string {
  const trimmed = directoryTenantId?.trim();
  if (!trimmed) return DEFAULT_AUTHORITY;
  if (!/^[0-9a-zA-Z.-]{1,100}$/.test(trimmed)) {
    throw new Error(
      "Directory (tenant) ID must be a GUID or a verified domain name.",
    );
  }
  return `https://login.microsoftonline.com/${trimmed}`;
}
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

// Marker in ERROR_TEMPLATE that the loopback listener replaces with the
// escaped error Microsoft sent back, or removes when there is none.
const ERROR_DETAIL_MARKER = "<!--oa:error-detail-->";

// Self-contained page served by the local loopback listener after Microsoft
// redirects back. No external fonts, scripts, or images: nothing leaves the
// device. Colors follow the production palette in apps/desktop/src/styles.
function authResultPage(input: {
  tone: "success" | "danger";
  title: string;
  status: string;
  heading: string;
  body: string;
  detail?: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #17191d; --card: #1e2126; --border: #343940;
        --text-0: #f4f5f7; --text-1: #c2c7ce; --text-3: #737c89;
        --kbd: #262a31; --success: #9cc88f; --danger: #f1a0a0;
      }
      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --bg: #f4f5f7; --card: #ffffff; --border: #dce0e6;
          --text-0: #17191d; --text-1: #3d434c; --text-3: #6b737f;
          --kbd: #eef0f3; --success: #3f7a34; --danger: #b23b3b;
        }
      }
      * { box-sizing: border-box; }
      html, body { margin: 0; height: 100%; }
      body {
        display: flex; align-items: center; justify-content: center; padding: 24px;
        background: var(--bg); color: var(--text-0);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        letter-spacing: -0.005em; -webkit-font-smoothing: antialiased;
      }
      .mono { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace; }
      main { width: 100%; max-width: 440px; }
      .brand { display: flex; align-items: center; gap: 10px; margin: 0 0 16px 2px; color: var(--text-1); font-weight: 600; font-size: 13px; }
      .brand svg { width: 22px; height: 15px; }
      .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
      .content { padding: 24px 24px 22px; }
      .status { display: inline-flex; align-items: center; gap: 8px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--tone); }
      .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--tone); box-shadow: 0 0 0 3px color-mix(in srgb, var(--tone) 22%, transparent); }
      h1 { margin: 12px 0 8px; font-size: 18px; font-weight: 600; letter-spacing: -0.01em; }
      p { margin: 0; color: var(--text-1); }
      .detail { margin-top: 16px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg); font-size: 12px; color: var(--text-1); word-break: break-word; }
      .detail strong { display: block; color: var(--danger); font-weight: 500; }
      .footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 24px; border-top: 1px solid var(--border); color: var(--text-3); font-size: 12px; }
      kbd { display: inline-block; min-width: 20px; padding: 1px 6px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; background: var(--kbd); color: var(--text-1); font-size: 11px; text-align: center; }
      .local { margin: 14px 0 0 2px; color: var(--text-3); font-size: 11px; }
    </style>
  </head>
  <body style="--tone: var(--${input.tone})">
    <main>
      <div class="brand">
        <svg viewBox="-0.5 11 64 42" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"><circle cx="17" cy="32" r="11.5"/><circle cx="46" cy="32" r="11.5"/><path d="M57.5 20.5v23"/></g></svg>
        OpenAdminOS
      </div>
      <div class="card" role="status">
        <div class="content">
          <span class="status">${input.status}</span>
          <h1>${input.heading}</h1>
          <p>${input.body}</p>
          ${input.detail ?? ""}
        </div>
        <div class="footer">
          <span>You can close this tab.</span>
          <span><kbd class="mono" id="mod">Ctrl</kbd> <kbd class="mono">W</kbd></span>
        </div>
      </div>
      <p class="local mono">Served by OpenAdminOS on this device</p>
    </main>
    <script>
      var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
      if (/mac/i.test(p)) document.getElementById("mod").textContent = "\\u2318";
    </script>
  </body>
</html>`;
}

const SUCCESS_TEMPLATE = authResultPage({
  tone: "success",
  title: "OpenAdminOS - sign-in complete",
  status: "Signed in",
  heading: "Sign-in complete",
  body: "Microsoft returned an authorization code to OpenAdminOS. The desktop app finishes connecting the tenant from here.",
});

const ERROR_TEMPLATE = authResultPage({
  tone: "danger",
  title: "OpenAdminOS - sign-in did not complete",
  status: "Not connected",
  heading: "Sign-in did not complete",
  body: "Microsoft returned an error instead of an authorization code. Return to OpenAdminOS and connect the tenant again.",
  detail: ERROR_DETAIL_MARKER,
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function renderSignInErrorPage(
  template: string,
  error?: { error?: string; error_description?: string },
): string {
  if (!error?.error) return template.replace(ERROR_DETAIL_MARKER, "");
  // Entra descriptions carry trace and correlation IDs on later lines; the
  // first line is the part an admin acts on.
  const description = (error.error_description ?? "").split(/\r?\n/)[0]!.trim().slice(0, 280);
  const detail = `<div class="detail mono"><strong>${escapeHtml(error.error)}</strong>${
    description ? escapeHtml(description) : ""
  }</div>`;
  return template.replace(ERROR_DETAIL_MARKER, detail);
}

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
      clientId: input.clientId ?? defaultClientId(),
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
    super("Microsoft sign-in timed out. Run the agent again and complete sign-in, or reconnect the tenant in Settings.");
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
          if (errorTemplate) response.setHeader("content-type", "text/html; charset=utf-8");
          response.end(
            errorTemplate
              ? renderSignInErrorPage(errorTemplate)
              : "Microsoft sign-in did not return a redirect URL.",
          );
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
          response.end(
            errorTemplate
              ? renderSignInErrorPage(errorTemplate, result)
              : "Microsoft sign-in did not complete.",
          );
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
    const server = this.server;
    if (server.listening) server.close();
    else server.once("listening", () => server.close());
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
  if (input.signal?.aborted) throw new TenantConnectCancelledError();
  const deadline = new AbortController();
  const timeoutMs = input.timeoutMs && input.timeoutMs > 0 ? input.timeoutMs : 300_000;
  const timer = setTimeout(() => deadline.abort(new TenantConnectTimeoutError()), timeoutMs);
  timer.unref?.();
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal;
  const loopbackClient = new AbortableLoopbackClient(signal);
  const request: InteractiveRequest = {
    scopes: input.scopes ?? DEFAULT_SCOPES,
    openBrowser: async (url) => {
      signal.throwIfAborted();
      await input.openBrowser(url);
    },
    successTemplate: SUCCESS_TEMPLATE,
    errorTemplate: ERROR_TEMPLATE,
    loopbackClient,
  };
  if (input.redirectUri) request.redirectUri = input.redirectUri;
  try {
    const result = await awaitWithSignal(input.client.acquireTokenInteractive(request), signal);
    signal.throwIfAborted();
    if (!result) throw new Error("MSAL returned no authentication result.");
    return result;
  } catch (error) {
    if (input.signal?.aborted) throw new TenantConnectCancelledError();
    if (deadline.signal.aborted) throw new TenantConnectTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
    loopbackClient.closeServer();
  }
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
  const acquire = async (scopes: string[]): Promise<AuthenticationResult> => {
    try {
      const result = await acquireTokenSilent({
        client: input.client,
        homeAccountId: input.homeAccountId,
        scopes,
      });
      return result;
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
      return result;
    }
  };
  return {
    tenantId: input.tenantId,
    username: input.username,
    async acquireTokenForScopes(scopes: string[]): Promise<string> {
      return (await acquire(scopes)).accessToken;
    },
    async acquireTokenWithScopes(scopes: string[]) {
      const result = await acquire(scopes);
      return { accessToken: result.accessToken, scopes: result.scopes };
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
