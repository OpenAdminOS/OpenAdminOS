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
        for (let attempt = 0; attempt < 20 && !redirectUri; attempt += 1) {
          try {
            redirectUri = request.loopbackClient!.getRedirectUri();
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 1));
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
