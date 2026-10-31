import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertWritePlanLimits,
  DEFAULT_WRITE_MAX_ACTIONS,
  MAX_WRITE_ACTIONS,
  type RunContext,
  type WritePlan,
} from "@openadminos/agent-sdk";
import { agentTemplateToModule, agentTemplateToRegistrySummary, ManifestValidationError, parseAgentTemplate } from "./agent-template.js";
import { createSandboxBroker } from "./sandbox-broker.js";

function plan(kinds: string[]): WritePlan {
  return {
    summary: "Review proposed changes.",
    confirmationPhrase: `EXECUTE ${kinds.length} ACTIONS`,
    actions: kinds.map((kind, i) => ({ id: String(i), label: `Action ${i}`, kind })),
  };
}

function manifest(writeLimits: unknown, mode = "write"): string {
  return JSON.stringify({
    descriptor: { id: "limited-agent", name: "Limited agent", description: "Test limits.", version: "1.0.0", category: "devices", mode, author: { name: "OpenAdminOS" }, writeLimits },
    skills: [{ id: "write", format: "write", label: "Plan changes", settings: { kind: "retire-managed-device", source: "{{ items }}", confirmationPhrase: "RETIRE 1 DEVICE", actionTemplate: { label: "Retire device" } } }],
    definition: {},
  });
}

describe("manifest write limits", () => {
  for (const value of [null, [], 5, {}, { maxActions: 0 }, { maxActions: -1 }, { maxActions: 1.5 }, { maxActions: "10" }, { maxActions: MAX_WRITE_ACTIONS + 1 }, { maxActions: 1, typo: 2 }, { maxActions: 1, maxActionsPerOperation: [] }, { maxActions: 1, maxActionsPerOperation: { "": 1 } }, { maxActions: 1, maxActionsPerOperation: { " graph-write": 1 } }, { maxActions: 1, maxActionsPerOperation: { "graph-write": 0 } }, { maxActions: 1, maxActionsPerOperation: { "graph-write": 1.5 } }, { maxActions: 1, maxActionsPerOperation: { "graph-write": MAX_WRITE_ACTIONS + 1 } }]) {
    it(`rejects invalid limits ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseAgentTemplate(manifest(value)), (error: unknown) => {
        assert.ok(error instanceof ManifestValidationError);
        assert.match(error.path, /^descriptor\.writeLimits/);
        return true;
      });
    });
  }

  it("rejects limits on read agents", () => {
    assert.throws(() => parseAgentTemplate(manifest({ maxActions: 10 }, "read")), /read agents cannot declare write limits/);
  });

  it("preserves limits in module and registry metadata", () => {
    const limits = { maxActions: 20, maxActionsPerOperation: { "retire-managed-device": 5 } };
    const parsed = parseAgentTemplate(manifest(limits));
    assert.deepEqual(agentTemplateToModule(parsed).writeLimits, limits);
    assert.deepEqual(agentTemplateToRegistrySummary(parsed).writeLimits, limits);
    assert.equal(parseAgentTemplate(manifest(undefined)).descriptor.writeLimits, undefined);
  });
});

describe("write plan limits", () => {
  it("accepts the exact default boundary and empty plans", () => {
    assert.doesNotThrow(() => assertWritePlanLimits(plan([])));
    assert.doesNotThrow(() => assertWritePlanLimits(plan(Array(DEFAULT_WRITE_MAX_ACTIONS).fill("graph-write"))));
  });

  it("rejects a default overflow with actionable copy", () => {
    assert.throws(() => assertWritePlanLimits(plan(Array(DEFAULT_WRITE_MAX_ACTIONS + 1).fill("graph-write"))), /101 actions\. The host default allows at most 100 per run\. Nothing was changed\. Narrow the selection/);
  });

  for (const [label, limits, kinds, expected] of [
    ["total", { maxActions: 2 }, ["retire-managed-device", "graph-write", "graph-write"], /manifest allows at most 2 per run/],
    ["per operation", { maxActions: 5, maxActionsPerOperation: { "graph-write": 1 } }, ["retire-managed-device", "graph-write", "graph-write"], /2 actions of kind "graph-write"/],
    ["default", undefined, Array(DEFAULT_WRITE_MAX_ACTIONS + 1).fill("retire-managed-device"), /host default allows at most 100/],
  ] as const) {
    it(`refuses broker ${label} overflow without accepting a plan`, async () => {
      const broker = createSandboxBroker({
        agent: { slug: "limited-agent", mode: "write", ...(limits ? { writeLimits: limits } : {}) },
        ctx: {} as RunContext,
      });
      const response = await broker.handle({ id: "plan", method: "write.plan", params: plan([...kinds]) });
      assert.equal(response.ok, false);
      assert.equal(response.error.code, "policy_denied");
      assert.match(response.error.message, expected);
      assert.equal(broker.getWritePlan(), undefined);
    });
  }

  it("counts every action of a kind across differing Graph requests", () => {
    const proposed = plan(["graph-write", "graph-write", "retire-managed-device"]);
    proposed.actions[0]!.request = { method: "PATCH", path: "/users/one" };
    proposed.actions[1]!.request = { method: "DELETE", path: "/groups/two" };
    assert.throws(() => assertWritePlanLimits(proposed, { maxActions: 3, maxActionsPerOperation: { "graph-write": 1 } }), /2 actions of kind "graph-write"/);
    assert.doesNotThrow(() => assertWritePlanLimits(proposed, { maxActions: 3, maxActionsPerOperation: { "graph-write": 2 } }));
  });

  it("clears an earlier broker plan when a replacement exceeds limits", async () => {
    const broker = createSandboxBroker({ agent: { slug: "limited-agent", mode: "write", writeLimits: { maxActions: 1 } }, ctx: {} as RunContext });
    assert.equal((await broker.handle({ id: "first", method: "write.plan", params: plan(["graph-write"]) })).ok, true);
    assert.ok(broker.getWritePlan());
    assert.equal((await broker.handle({ id: "second", method: "write.plan", params: plan(["graph-write", "graph-write"]) })).ok, false);
    assert.equal(broker.getWritePlan(), undefined);
  });
});
