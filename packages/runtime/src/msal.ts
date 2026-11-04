import { awaitWithSignal } from "./cancellation.js";
import {
  AuthError,
  type AccountInfo,
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
  BASELINE_SCOPES,
  OPENADMINOS_APP_CLIENT_ID,
  toResourceScopes,
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
export const OPENADMINOS_CLIENT_ID = OPENADMINOS_APP_CLIENT_ID;

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

/**
 * The authority for one connected directory, on the host of the client's
 * configured authority. A guest account has one profile per directory under
 * the same homeAccountId. Requests for a stored tenant use this authority so
 * MSAL refreshes or signs in to that directory, never the home directory
 * that `/common` would pick.
 */
export function tenantAuthority(
  tenantId: string,
  configuredAuthority: string = DEFAULT_AUTHORITY,
): string {
  const trimmed = tenantId.trim();
  if (!/^[0-9a-zA-Z.-]{1,100}$/.test(trimmed)) {
    throw new Error("Tenant ID must be a GUID or a verified domain name.");
  }
  return `${new URL(configuredAuthority).origin}/${trimmed}`;
}
// Sign-in only: openid, profile, offline_access and User.Read. Callers
// add the scopes of the service parts the admin chose, and agents add
// their declared scopes when they run, each behind its own consent. Scope
// names, reasons and permission IDs live in the agent-sdk service registry.
export const DEFAULT_SCOPES = toResourceScopes(BASELINE_SCOPES);

/**
 * Own app registrations sign in with every permission the app was granted.
 * The granted set is then read from the token, see
 * `scopesFromAuthenticationResult`.
 */
export const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

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
  /** Prefills the Microsoft sign-in page with the connected account. */
  loginHint?: string;
  /** Signs in to this authority instead of the client's configured one. */
  authority?: string;
}

/** The account a stored tenant was connected with. */
export interface ExpectedTenantAccount {
  tenantId: string;
  homeAccountId: string;
  username: string;
}

/** An interactive sign-in returned an account other than the connected one. */
export class TenantAccountMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TenantAccountMismatchError";
  }
}

/**
 * Throws unless the sign-in returned the account and directory the tenant
 * was connected with. Callers check this before saving anything, so a
 * different account can never change a tenant's grants or tokens in use.
 */
export function assertSignedInAccount(
  result: AuthenticationResult,
  expected: ExpectedTenantAccount,
): void {
  const account = result.account;
  const signedInAs = account?.username || "an unknown account";
  const connectedAs = expected.username || expected.homeAccountId;
  const sameAccount =
    !!account &&
    account.homeAccountId.toLowerCase() === expected.homeAccountId.toLowerCase();
  if (!sameAccount) {
    throw new TenantAccountMismatchError(
      `Signed in as ${signedInAs}, but this tenant is connected as ${connectedAs}. Sign in as ${connectedAs} and try again.`,
    );
  }
  // The account profile and the token can each name a directory; both must
  // be the stored one.
  const signedInTenant = [account.tenantId || account.homeAccountId, result.tenantId]
    .filter((id): id is string => !!id)
    .find((id) => id.toLowerCase() !== expected.tenantId.toLowerCase());
  if (signedInTenant) {
    throw new TenantAccountMismatchError(
      `Signed in as ${signedInAs} to directory ${signedInTenant}, but this tenant is directory ${expected.tenantId}, connected as ${connectedAs}. Sign in as ${connectedAs} to that directory and try again.`,
    );
  }
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
  if (input.loginHint) request.loginHint = input.loginHint;
  if (input.authority) request.authority = input.authority;
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

/**
 * The cached profile of this account in this directory. `getAllAccounts`
 * returns one entry per tenant profile, and a guest shares one
 * homeAccountId across directories, so matching on homeAccountId alone can
 * pick another directory's profile.
 */
export async function findTenantAccount(input: {
  client: PublicClientApplication;
  homeAccountId: string;
  tenantId: string;
  /** Stops waiting for the token cache; the call rejects with the signal's reason. */
  signal?: AbortSignal;
}): Promise<AccountInfo | null> {
  const homeAccountId = input.homeAccountId.toLowerCase();
  const tenantId = input.tenantId.toLowerCase();
  const accounts = await awaitWithSignal(input.client.getTokenCache().getAllAccounts(), input.signal);
  return (
    accounts.find(
      (account) =>
        account.homeAccountId.toLowerCase() === homeAccountId &&
        account.tenantId?.toLowerCase() === tenantId,
    ) ?? null
  );
}

export async function acquireTokenSilent(input: {
  client: PublicClientApplication;
  /** The stored tenant: its directory, account and username. */
  account: ExpectedTenantAccount;
  /** The client's configured authority. Only its host is used. */
  authority?: string;
  scopes?: string[];
  /** Skip the cached access token, for example after admin consent changed. */
  forceRefresh?: boolean;
  /** Stops waiting for MSAL; the call rejects with the signal's reason. */
  signal?: AbortSignal;
}): Promise<AuthenticationResult> {
  input.signal?.throwIfAborted();
  const { homeAccountId, tenantId } = input.account;
  const account = await findTenantAccount({
    client: input.client,
    homeAccountId,
    tenantId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!account) {
    throw new Error(
      `No cached account for homeAccountId ${homeAccountId} in directory ${tenantId}. Reconnect the tenant.`,
    );
  }

  const request: SilentFlowRequest = {
    account,
    authority: tenantAuthority(tenantId, input.authority),
    scopes: input.scopes ?? DEFAULT_SCOPES,
    ...(input.forceRefresh ? { forceRefresh: true } : {}),
  };
  let result: AuthenticationResult | null;
  try {
    result = await awaitWithSignal(input.client.acquireTokenSilent(request), input.signal);
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    if (error instanceof InteractionRequiredAuthError) {
      throw new Error(
        `Cached refresh token is no longer valid for ${homeAccountId}. Reconnect the tenant.`,
      );
    }
    throw error;
  }
  if (!result) {
    throw new Error("MSAL silent acquisition returned no result.");
  }
  // A token for another directory must never be used or recorded.
  assertSignedInAccount(result, input.account);
  return result;
}

export interface CreateTenantSessionInput {
  client: PublicClientApplication;
  tenantId: string;
  username: string;
  homeAccountId: string;
  /** The client's configured authority. Only its host is used. */
  authority?: string;
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
  /** Stops silent acquisition; pass the same signal to `acquireInteractive`. */
  signal?: AbortSignal;
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
  const expected: ExpectedTenantAccount = {
    tenantId: input.tenantId,
    homeAccountId: input.homeAccountId,
    username: input.username,
  };
  const acquire = async (scopes: string[]): Promise<AuthenticationResult> => {
    try {
      return await acquireTokenSilent({
        client: input.client,
        account: expected,
        ...(input.authority ? { authority: input.authority } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        scopes,
      });
    } catch (silentError) {
      if (input.signal?.aborted) throw silentError;
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
      assertSignedInAccount(result, expected);
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
