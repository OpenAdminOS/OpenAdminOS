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
