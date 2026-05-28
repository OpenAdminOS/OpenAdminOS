import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  AgentSummary,
  RunGraphApi,
  RunLlmApi,
  RunStatus,
} from "@openadminos/agent-sdk";

import { createQueuedRun, executePlan } from "./index.js";

const llm: RunLlmApi = {
  available: true,
  defaultModel: "test-model",
  async complete() {
    return { text: "No stale devices matched the configured policy.", model: "test-model" };
  },
  async *stream() {
    yield {
      delta: "No stale devices matched the configured policy.",
      accumulated: "No stale devices matched the configured policy.",
      done: true,
      model: "test-model",
    };
  },
};

const graph: RunGraphApi = {
  async listManagedDevices() {
    return [];
  },
  async retireManagedDevice() {
    throw new Error("retireManagedDevice should not be called for an empty plan");
  },
  async request() {
    return { value: [] };
  },
};

describe("executePlan", () => {
  it("completes write agents whose plan has zero actions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openadminos-empty-write-plan-"));
    try {
      writeFileSync(
        join(dir, "manifest.yaml"),
        `descriptor:
  id: empty-write-agent
  name: Empty write agent
  description: Test write agent with no matching actions.
  version: 1.0.0
  author:
    name: OpenAdminOS
    verified: true
  category: devices
  mode: write
skills:
  - id: load
    format: graph
    label: Load matching devices
    detail: Returns no candidates.
    settings:
      method: GET
      path: /devices
  - id: explain
    format: llm
    label: Explain no-op plan
    detail: Required LLM step.
    settings:
      prompt: Explain the empty plan.
  - id: write
    format: write
    label: Build write plan
    detail: Builds zero actions.
    settings:
      kind: retire-managed-device
      source: "{{ load.output }}"
      confirmationPhrase: "OFFBOARD {{ actions | size }} DEVICES"
      summary: "{{ explain.output.text }}"
      actionTemplate:
        label: "Offboard {{ item.deviceName }}"
        metadata:
          deviceId: "{{ item.id }}"
definition:
  triggers:
    - id: manual
      kind: manual
`,
      );

      const agent: AgentSummary = {
        id: "empty-write-agent",
        slug: "empty-write-agent",
        name: "Empty write agent",
        description: "Test write agent with no matching actions.",
        mode: "write",
        category: "devices",
        tier: "agent",
        requiresEntraTier: "free",
        scopes: [],
        author: { name: "OpenAdminOS", verified: true },
        version: "1.0.0",
        registryPath: dir,
        installedAt: new Date("2026-05-27T00:00:00.000Z").toISOString(),
      };

      const run = createQueuedRun({ agent, providerId: "ollama", model: "test-model" });
      const progress: RunStatus[] = [];
      const completed = await executePlan({
        run,
        agent,
        providerId: "ollama",
        model: "test-model",
        llm,
        createGraph: () => graph,
        onProgress(next) {
          progress.push(next.status);
        },
      });

      assert.equal(completed.status, "completed");
      assert.equal(completed.plan?.actions.length, 0);
      assert.equal(completed.error, undefined);
      assert.deepEqual(completed.result, {
        mode: "simulated",
        total: 0,
        successCount: 0,
        failureCount: 0,
        skippedReason: "No write actions matched the current tenant inventory.",
      });
      assert.ok(!progress.includes("awaiting-confirmation"));
      assert.ok(
        completed.logs.some((log) =>
          log.message === "Plan ready (0 actions). No confirmation required.",
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
