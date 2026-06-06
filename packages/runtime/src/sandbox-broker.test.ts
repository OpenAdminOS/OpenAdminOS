import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  AgentSummary,
  GraphRequestInput,
  LlmOptions,
  RunContext,
  WritePlan,
} from "@openadminos/agent-sdk";

import { createSandboxBroker } from "./sandbox-broker.js";

describe("sandbox broker", () => {
  it("allows only manifest-declared Graph GET requests", async () => {
    const graphRequests: GraphRequestInput[] = [];
    const agent = fakeAgent({
      graphOperations: [
        {
          method: "GET",
          path: "/users",
          select: ["id", "displayName"],
        },
      ],
    });
    const broker = createSandboxBroker({
      agent,
      ctx: fakeContext(agent, {
        graphRequest: async (input) => {
          graphRequests.push(input);
          return { value: [{ id: "u1", displayName: "Ada" }] };
        },
      }),
    });

    const allowed = await broker.handle({
      id: "graph-1",
      method: "graph.request",
      params: {
        method: "GET",
        path: "/users",
        query: { $select: "id" },
      },
    });

    assert.equal(allowed.ok, true);
    assert.deepEqual(graphRequests, [
      {
        method: "GET",
        path: "/users",
        query: { $select: "id" },
      },
    ]);

    const undeclared = await broker.handle({
      id: "graph-2",
      method: "graph.request",
      params: {
        method: "GET",
        path: "/groups",
      },
    });
    assert.equal(undeclared.ok, false);
    assert.equal(undeclared.error.code, "policy_denied");

    const overSelect = await broker.handle({
      id: "graph-3",
      method: "graph.request",
      params: {
        method: "GET",
        path: "/users",
        query: { $select: "id,userPrincipalName" },
      },
    });
    assert.equal(overSelect.ok, false);
    assert.equal(overSelect.error.code, "policy_denied");
  });

  it("rejects direct Graph writes from sandboxed code", async () => {
    const agent = fakeAgent({
      mode: "write",
      graphOperations: [
        {
          method: "POST",
          path: "/users/{user-id}",
        },
      ],
    });
    const broker = createSandboxBroker({
      agent,
      ctx: fakeContext(agent),
    });

    const response = await broker.handle({
      id: "write-graph",
      method: "graph.request",
      params: {
        method: "POST",
        path: "/users/u1",
        body: { accountEnabled: false },
      },
    });

    assert.equal(response.ok, false);
    assert.equal(response.error.code, "policy_denied");
    assert.match(response.error.message, /write\.plan/);
  });

  it("prevents sandboxed code from changing the active LLM model", async () => {
    const completions: LlmOptions[] = [];
    const agent = fakeAgent();
    const broker = createSandboxBroker({
      agent,
      ctx: fakeContext(agent, {
        model: "approved-model",
        llmComplete: async (input) => {
          completions.push(input);
          return { text: "ok", model: input.model ?? "unknown" };
        },
      }),
    });

    const denied = await broker.handle({
      id: "llm-1",
      method: "llm.complete",
      params: {
        prompt: "Summarize the data.",
        model: "other-model",
      },
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, "policy_denied");

    const allowed = await broker.handle({
      id: "llm-2",
      method: "llm.complete",
      params: {
        prompt: "Summarize the data.",
      },
    });
    assert.equal(allowed.ok, true);
    assert.equal(completions[0]?.model, "approved-model");
  });

  it("stores validated write plans without applying them", async () => {
    const agent = fakeAgent({
      mode: "write",
      graphOperations: [
        {
          method: "PATCH",
          path: "/users/{user-id}",
        },
      ],
    });
    const broker = createSandboxBroker({
      agent,
      ctx: fakeContext(agent),
    });
    const plan: WritePlan = {
      summary: "Disable one guest.",
      confirmationPhrase: "DISABLE 1 GUEST",
      actions: [
        {
          id: "disable-u1",
          kind: "graph-write",
          label: "Disable guest u1",
          request: {
            method: "PATCH",
            path: "/users/u1",
            body: { accountEnabled: false },
          },
        },
      ],
    };

    const response = await broker.handle({
      id: "plan-1",
      method: "write.plan",
      params: plan,
    });

    assert.equal(response.ok, true);
    assert.deepEqual(broker.getWritePlan(), plan);
  });
});

function fakeAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "agent-id",
    slug: "agent-id",
    name: "Agent",
    description: "Test agent",
    mode: "read",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: ["User.Read.All"],
    author: { name: "openadminos" },
    version: "0.1.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeContext(
  agent: AgentSummary,
  overrides: {
    graphRequest?: (input: GraphRequestInput) => Promise<unknown>;
    llmComplete?: (input: LlmOptions) => Promise<{ text: string; model: string }>;
    model?: string;
  } = {},
): RunContext {
  return {
    agent,
    providerId: "ollama",
    model: overrides.model,
    graph: {
      listManagedDevices: async () => [],
      retireManagedDevice: async () => undefined,
      request: overrides.graphRequest ?? (async () => ({ value: [] })),
    },
    llm: {
      available: true,
      defaultModel: "default-model",
      complete:
        overrides.llmComplete ??
        (async (input) => ({ text: "ok", model: input.model ?? "default-model" })),
      stream: async function* () {
        yield {
          delta: "ok",
          accumulated: "ok",
          done: true,
          model: "default-model",
        };
      },
    },
    realWrites: false,
    log: () => undefined,
    step: async (_label, _detail, fn) => await fn(),
  };
}
