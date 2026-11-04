import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  AuthenticationResult,
  InteractiveRequest,
  PublicClientApplication,
} from "@azure/msal-node";
import {
  DEFAULT_SCOPE_METADATA,
  DEFAULT_SCOPES,
  createTenantSession,
  runInteractiveFlow,
  TenantConnectCancelledError,
  TenantConnectTimeoutError,
} from "./msal.js";

describe("default tenant consent scopes", () => {
  it("keeps the MSAL request and consent-preview metadata in exact sync", () => {
    const requested = DEFAULT_SCOPES.map((scope) =>
      scope.replace("https://graph.microsoft.com/", ""),
    ).sort();
    const described = DEFAULT_SCOPE_METADATA.map((scope) => scope.name).sort();
    assert.deepEqual(requested, described);
    assert.equal(new Set(requested).size, requested.length);
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
