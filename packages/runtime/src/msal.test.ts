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
  acquireTokenSilent,
  createTenantSession,
  runInteractiveFlow,
  tenantAuthority,
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
    const account = { homeAccountId: "account", tenantId: "tenant", username: "reader" };
    const client = {
      getTokenCache: () => ({ getAllAccounts: async () => [account] }),
      acquireTokenSilent: async (request: { scopes: string[] }) => {
        requests.push(request.scopes);
        return { accessToken: "opaque-token", scopes: ["User.Read.All"], account, tenantId: "tenant" };
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

  it("serves branded result pages and escapes the error Microsoft returns", async () => {
    const client = {
      acquireTokenInteractive: async (request: InteractiveRequest) => {
        const authorization = request.loopbackClient!.listenForAuthCode(
          request.successTemplate,
          request.errorTemplate,
        );
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
        const success = await (await fetch(`${redirectUri}/`)).text();
        assert.match(success, /Sign-in complete/);

        const description = encodeURIComponent("AADSTS65004: <script>x</script>\r\nTrace ID: abc");
        const failure = await fetch(`${redirectUri}/?error=access_denied&error_description=${description}`);
        assert.match(failure.headers.get("content-type") ?? "", /text\/html/);
        const html = await failure.text();
        assert.match(html, /Sign-in did not complete/);
        assert.match(html, /<strong>access_denied<\/strong>AADSTS65004: &#60;script&#62;x&#60;\/script&#62;/);
        assert.doesNotMatch(html, /<script>x/);
        assert.doesNotMatch(html, /Trace ID/);
        assert.doesNotMatch(html, /oa:error-detail/);

        // String.replace expands $` $& $' $$ in a string replacement; the
        // untrusted text must be inserted literally.
        const patterns = encodeURIComponent("a$`b$&c$$d");
        const literal = await (
          await fetch(`${redirectUri}/?error=${patterns}&error_description=${patterns}`)
        ).text();
        assert.match(literal, /<strong>a\$`b\$&#38;c\$\$d<\/strong>a\$`b\$&#38;c\$\$d<\/div>/);
        assert.equal(literal.match(/<!doctype/g)?.length, 1);
        assert.doesNotMatch(literal, /oa:error-detail/);

        const response = await authorization;
        request.loopbackClient!.closeServer();
        assert.equal(response.error, "access_denied");
        return { accessToken: "unused" } as AuthenticationResult;
      },
    } as unknown as PublicClientApplication;

    await runInteractiveFlow({ client, openBrowser: async () => undefined });
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

describe("silent sign-in bound to the stored directory", () => {
  // A B2B guest: one homeAccountId, one cached profile per directory. MSAL
  // lists the home profile first, which is what getAccountByHomeId returns.
  const homeAccountId = "oid.home-tid";
  const homeProfile = { homeAccountId, tenantId: "home-tid", username: "admin@home.example" };
  const guestProfile = { homeAccountId, tenantId: "guest-tid", username: "admin@home.example" };
  const guestTenant = { tenantId: "guest-tid", homeAccountId, username: "admin@home.example" };

  function guestClient(
    respond: (request: { account: typeof homeProfile; authority?: string }) => typeof homeProfile,
  ) {
    const requests: Array<{ account: typeof homeProfile; authority?: string; scopes: string[] }> = [];
    const client = {
      getTokenCache: () => ({
        getAllAccounts: async () => [homeProfile, guestProfile],
        getAccountByHomeId: async (id: string) =>
          [homeProfile, guestProfile].find((profile) => profile.homeAccountId === id) ?? null,
      }),
      acquireTokenSilent: async (request: { account: typeof homeProfile; authority?: string; scopes: string[] }) => {
        requests.push(request);
        const account = respond(request);
        return { accessToken: `token-for-${account.tenantId}`, scopes: request.scopes, account, tenantId: account.tenantId };
      },
    } as unknown as PublicClientApplication;
    return { client, requests };
  }

  it("selects the profile of the stored directory and asks its authority", async () => {
    const { client, requests } = guestClient((request) => request.account);
    const session = createTenantSession({ client, ...guestTenant });
    assert.equal(await session.acquireTokenForScopes(["User.Read"]), "token-for-guest-tid");
    assert.equal(requests[0]!.account.tenantId, "guest-tid");
    assert.equal(requests[0]!.authority, "https://login.microsoftonline.com/guest-tid");
  });

  it("rejects a silent token for another directory and never falls back to sign-in", async () => {
    const { client } = guestClient(() => homeProfile);
    let interactive = 0;
    const session = createTenantSession({
      client,
      ...guestTenant,
      acquireInteractive: async () => {
        interactive += 1;
        throw new Error("not expected");
      },
    });
    await assert.rejects(
      session.acquireTokenWithScopes!(["User.Read"]),
      (error: unknown) =>
        error instanceof TenantAccountMismatchError &&
        error.message.includes("to directory home-tid, but this tenant is directory guest-tid"),
    );
    assert.equal(interactive, 0);
  });

  it("rejects an interactive fallback result for another directory", async () => {
    const client = {
      getTokenCache: () => ({ getAllAccounts: async () => [homeProfile] }),
    } as unknown as PublicClientApplication;
    const session = createTenantSession({
      client,
      ...guestTenant,
      acquireInteractive: async () =>
        ({ accessToken: "home-token", account: homeProfile, tenantId: "home-tid" }) as unknown as AuthenticationResult,
    });
    await assert.rejects(session.acquireTokenForScopes(["User.Read"]), TenantAccountMismatchError);
  });

  it("reports a missing profile for the stored directory as no cached account", async () => {
    const client = {
      getTokenCache: () => ({ getAllAccounts: async () => [homeProfile] }),
      acquireTokenSilent: async () => {
        throw new Error("not expected");
      },
    } as unknown as PublicClientApplication;
    await assert.rejects(
      acquireTokenSilent({ client, account: guestTenant }),
      /No cached account for homeAccountId oid.home-tid in directory guest-tid/,
    );
  });

  it("stops waiting for a stalled account cache read when the signal aborts", async () => {
    const client = {
      getTokenCache: () => ({ getAllAccounts: () => new Promise(() => undefined) }),
      acquireTokenSilent: async () => {
        throw new Error("not expected");
      },
    } as unknown as PublicClientApplication;
    const controller = new AbortController();
    const pending = acquireTokenSilent({ client, account: guestTenant, signal: controller.signal });
    controller.abort("timeout");
    await assert.rejects(pending, (reason: unknown) => reason === "timeout");
  });

  it("keeps the host of the configured authority", () => {
    assert.equal(
      tenantAuthority("guest-tid", "https://login.microsoftonline.us/organizations"),
      "https://login.microsoftonline.us/guest-tid",
    );
    assert.equal(tenantAuthority("guest-tid"), "https://login.microsoftonline.com/guest-tid");
    assert.throws(() => tenantAuthority("guest/../tid"), /Tenant ID must be a GUID/);
  });

  it("passes a tenant authority to interactive sign-in", async () => {
    let authority: string | undefined;
    const client = {
      acquireTokenInteractive: async (request: InteractiveRequest) => {
        authority = request.authority;
        return { accessToken: "token" } as AuthenticationResult;
      },
    } as unknown as PublicClientApplication;
    await runInteractiveFlow({
      client,
      openBrowser: async () => undefined,
      authority: "https://login.microsoftonline.com/guest-tid",
    });
    assert.equal(authority, "https://login.microsoftonline.com/guest-tid");
  });
});
