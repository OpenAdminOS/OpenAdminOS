import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AuthenticationResult,
  InteractiveRequest,
  PublicClientApplication,
} from "@azure/msal-node";
import {
  DEFAULT_SCOPES,
  TenantAccountMismatchError,
  assertSignedInAccount,
  createTenantSession,
  runInteractiveFlow,
  TenantConnectCancelledError,
  TenantConnectTimeoutError,
} from "./msal.js";

describe("default tenant consent scopes", () => {
  it("asks for the four sign-in scopes only when no scopes are given", () => {
    assert.deepEqual(DEFAULT_SCOPES, [
      "openid",
      "profile",
      "offline_access",
      "https://graph.microsoft.com/User.Read",
    ]);
  });
  it("retains the scopes actually returned by MSAL without changing token requests", async () => {
    const requests: string[][] = [];
    const client = {
      getTokenCache: () => ({ getAccountByHomeId: async () => ({ homeAccountId: "account" }) }),
      acquireTokenSilent: async (request: { scopes: string[] }) => {
        requests.push(request.scopes);
        return { accessToken: "opaque-token", scopes: ["User.Read.All"] };
      },
    } as unknown as PublicClientApplication;
    const session = createTenantSession({ client, tenantId: "tenant", username: "reader", homeAccountId: "account" });
    assert.deepEqual(await session.acquireTokenWithScopes!(["User.Read.All", "AuditLog.Read.All"]), { accessToken: "opaque-token", scopes: ["User.Read.All"] });
    assert.equal(await session.acquireTokenForScopes(["User.Read.All"]), "opaque-token");
    assert.deepEqual(requests, [["User.Read.All", "AuditLog.Read.All"], ["User.Read.All"]]);
  });
});

function listenerClient(): PublicClientApplication {
  return {
    acquireTokenInteractive: async (request: InteractiveRequest) => {
      await request.loopbackClient?.listenForAuthCode();
      return null;
    },
  } as unknown as PublicClientApplication;
}

describe("interactive tenant sign-in listener", () => {
  it("closes and rejects when the caller cancels", async () => {
    const controller = new AbortController();
    const result = runInteractiveFlow({
      client: listenerClient(),
      openBrowser: async () => undefined,
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(result, TenantConnectCancelledError);
  });

  it("closes and rejects after the configured hard timeout", async () => {
    await assert.rejects(
      runInteractiveFlow({
        client: listenerClient(),
        openBrowser: async () => undefined,
        timeoutMs: 5,
      }),
      TenantConnectTimeoutError,
    );
  });

  it("ignores unrelated browser requests and resolves only an OAuth response", async () => {
    const client = {
      acquireTokenInteractive: async (request: InteractiveRequest) => {
        const authorization = request.loopbackClient!.listenForAuthCode();
        let redirectUri: string | undefined;
        const readyDeadline = Date.now() + 2_000;
        while (!redirectUri && Date.now() < readyDeadline) {
          try {
            redirectUri = request.loopbackClient!.getRedirectUri();
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        assert.ok(redirectUri);
        assert.equal((await fetch(`${redirectUri}/favicon.ico`)).status, 204);
        await fetch(`${redirectUri}/?code=authorization-code`);
        const response = await authorization;
        request.loopbackClient!.closeServer();
        assert.equal(response.code, "authorization-code");
        return {
          accessToken: "test-token",
        } as AuthenticationResult;
      },
    } as unknown as PublicClientApplication;

    const result = await runInteractiveFlow({
      client,
      openBrowser: async () => undefined,
    });
    assert.equal(result.accessToken, "test-token");
  });
});

describe("incremental sign-in lifecycle", () => {
  it("uses a five-minute default even when the agent does not supply a timeout", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const client = { acquireTokenInteractive: () => new Promise(() => {}) } as unknown as PublicClientApplication;
    const result = runInteractiveFlow({ client, openBrowser: async () => undefined });
    const rejected = assert.rejects(result, TenantConnectTimeoutError);
    t.mock.timers.tick(300_001);
    await rejected;
  });

  it("cancels the complete MSAL wait and ignores a late successful result", async () => {
    const controller = new AbortController();
    let finish!: (result: AuthenticationResult) => void;
    const client = { acquireTokenInteractive: () => new Promise<AuthenticationResult>((resolve) => { finish = resolve; }) } as unknown as PublicClientApplication;
    const result = runInteractiveFlow({ client, signal: controller.signal, openBrowser: async () => undefined });
    controller.abort();
    await assert.rejects(result, TenantConnectCancelledError);
    finish({ accessToken: "late-token" } as AuthenticationResult);
  });
});

describe("connected account check", () => {
  const expected = {
    tenantId: "contoso-tid",
    homeAccountId: "oid.contoso-tid",
    username: "admin@contoso.example",
  };
  const signedIn = (account: { homeAccountId: string; tenantId: string; username: string }) =>
    ({ account, tenantId: account.tenantId }) as unknown as AuthenticationResult;

  it("accepts the connected account in its own directory", () => {
    assert.doesNotThrow(() =>
      assertSignedInAccount(
        signedIn({ homeAccountId: "OID.CONTOSO-TID", tenantId: "contoso-tid", username: "Admin@contoso.example" }),
        expected,
      ),
    );
  });

  it("names both accounts when a different account signs in", () => {
    assert.throws(
      () =>
        assertSignedInAccount(
          signedIn({ homeAccountId: "other.fabrikam-tid", tenantId: "fabrikam-tid", username: "it@fabrikam.example" }),
          expected,
        ),
      (error: unknown) =>
        error instanceof TenantAccountMismatchError &&
        error.message ===
          "Signed in as it@fabrikam.example, but this tenant is connected as admin@contoso.example. Sign in as admin@contoso.example and try again.",
    );
  });

  it("rejects the same account signed in to another directory", () => {
    assert.throws(
      () =>
        assertSignedInAccount(
          signedIn({ homeAccountId: "oid.contoso-tid", tenantId: "fabrikam-tid", username: "admin@contoso.example" }),
          expected,
        ),
      (error: unknown) =>
        error instanceof TenantAccountMismatchError &&
        error.message.startsWith("Signed in as admin@contoso.example to directory fabrikam-tid, but this tenant is directory contoso-tid"),
    );
  });

  it("rejects a sign-in without an account", () => {
    assert.throws(
      () => assertSignedInAccount({ account: null } as unknown as AuthenticationResult, expected),
      /Signed in as an unknown account, but this tenant is connected as admin@contoso.example/,
    );
  });

  it("passes the login hint to MSAL", async () => {
    let loginHint: string | undefined;
    const client = {
      acquireTokenInteractive: async (request: InteractiveRequest) => {
        loginHint = request.loginHint;
        return { accessToken: "token" } as AuthenticationResult;
      },
    } as unknown as PublicClientApplication;
    await runInteractiveFlow({ client, openBrowser: async () => undefined, loginHint: "admin@contoso.example" });
    assert.equal(loginHint, "admin@contoso.example");
  });
});
