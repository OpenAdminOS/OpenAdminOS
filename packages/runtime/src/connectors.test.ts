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
