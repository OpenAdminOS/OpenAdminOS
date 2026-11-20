import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConnectorInstance } from "@openadminos/agent-sdk";
import { wrapConnector } from "./connectors.js";

function options(confirmInvocation?: () => Promise<{ approved: true }>) {
  return {
    runId: "run-1",
    currentStepId: () => "step-1",
    nextIteration: () => 0,
    ...(confirmInvocation ? { confirmInvocation } : {}),
  };
}

describe("connector invocation confirmation", () => {
  it("fails closed when a side-effect capability has no confirmation handler", async () => {
    let invoked = false;
    const instance: ConnectorInstance<unknown> = {
      descriptor: {
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        authSource: "external",
        scopes: [],
        capabilities: [
          { id: "send-message", version: 1, kind: "notify", scopes: [] },
        ],
        configSchema: { type: "object" },
        trust: { label: "Fixture", detail: "Fixture", staysInTenant: false },
      },
      status: "connected",
      capabilities: {
        async sendMessage() {
          invoked = true;
          return { ok: true };
        },
      },
      async healthCheck() { return { healthy: true }; },
      async dispose() {},
    };
    const wrapped = wrapConnector("fixture", instance, options());
    const capabilities = wrapped.capabilities as { sendMessage(): Promise<unknown> };
    await assert.rejects(() => capabilities.sendMessage(), /No confirmation handler/);
    assert.equal(invoked, false);
  });

  it("blocks methods that have no matching descriptor", async () => {
    let invoked = false;
    const instance: ConnectorInstance<unknown> = {
      descriptor: {
        id: "fixture",
        name: "Fixture",
        version: "1.0.0",
        authSource: "external",
        scopes: [],
        capabilities: [],
        configSchema: { type: "object" },
        trust: { label: "Fixture", detail: "Fixture", staysInTenant: false },
      },
      status: "connected",
      capabilities: {
        async undeclaredMethod() {
          invoked = true;
        },
      },
      async healthCheck() { return { healthy: true }; },
      async dispose() {},
    };
    const wrapped = wrapConnector("fixture", instance, options(async () => ({ approved: true })));
    const capabilities = wrapped.capabilities as { undeclaredMethod(): Promise<void> };
    await assert.rejects(() => capabilities.undeclaredMethod(), /without a matching capability descriptor/);
    assert.equal(invoked, false);
  });
});

import { graphAccessDenialFromError, graphAccessDenialFromStoredText } from "@openadminos/agent-sdk";
import { preflightConnectors } from "./connectors.js";

describe("required connector preflight", () => {
  it("keeps the Teams health check's Graph 403 as the cause of the preflight failure", async () => {
    const failure = await preflightConnectors({
      runId: "run",
      requirements: [{ id: "teams", minVersion: "1.0.0", required: true, capabilities: [{ id: "list-teams", version: 1 }] }],
      tenant: { tenantId: "tenant", username: "admin@contoso.example", acquireTokenForScopes: async () => "token" },
      configFor: () => ({}),
      secretsFor: () => undefined as never,
      transport: {
        fetch: (async () => new Response('{"error":{"code":"Forbidden","message":"Insufficient privileges to complete the operation."}}', { status: 403, headers: { "content-type": "application/json" } })) as typeof fetch,
      },
      log: () => undefined,
    }).then(() => undefined, (error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /failed its health check/);
    assert.equal(graphAccessDenialFromError(failure)?.cause, "unknown");
    // The emitted message, as a stored run keeps it, still reads as a Graph 403.
    assert.equal(graphAccessDenialFromStoredText(failure.message)?.cause, "unknown");
  });
});
