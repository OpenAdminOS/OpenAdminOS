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

export const GRAPH_CLI_CLIENT_ID = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
export const DEFAULT_AUTHORITY = "https://login.microsoftonline.com/common";
export const DEFAULT_SCOPES = [
  "https://graph.microsoft.com/DeviceManagementManagedDevices.Read.All",
];

const SUCCESS_TEMPLATE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Open Agents - sign-in complete</title>
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
      <p>Open Agents has received the authorization code. You can close this tab and return to the desktop app.</p>
    </div>
  </body>
</html>`;

const ERROR_TEMPLATE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Open Agents - sign-in failed</title></head>
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
