import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary, RunLlmApi } from "@openadminos/agent-sdk";
import { createQueuedRun, executeRun } from "./index.js";
import { accumulateRunUsage } from "./run-usage.js";

it("sums per-call tokens and provider-reported cost across run phases", () => {
  const first = accumulateRunUsage(null, "azure-openai", "deployment", { promptTokens: 100, completionTokens: 20, costUsd: 0.01 });
  const total = accumulateRunUsage(first, "azure-openai", "deployment", { promptTokens: 200, completionTokens: 40, costUsd: 0.02 });
  assert.deepEqual(total, { providerId: "azure-openai", model: "deployment", calls: 2, mixedModels: false, promptTokens: 300, completionTokens: 60, totalTokens: 360, costUsd: 0.03 });
});

it("leaves incomplete counts and costs unknown regardless of call order", () => {
  const reported = { promptTokens: 100, completionTokens: 20, costUsd: 0.01 };
  for (const calls of [[reported, undefined], [undefined, reported]]) {
    const first = accumulateRunUsage(null, "openai", "model", calls[0]);
    const result = accumulateRunUsage(first, "openai", "model", calls[1]);
    assert.equal(result.totalTokens, undefined);
    assert.equal(result.costUsd, undefined);
    assert.equal(result.calls, 2);
  }
});

it("retains zero usage, rejects malformed values and flags model overrides", () => {
  const first = accumulateRunUsage(null, "ollama", "one", { promptTokens: 0, completionTokens: 0, costUsd: 0 });
  assert.equal(first.totalTokens, 0);
  const result = accumulateRunUsage(first, "ollama", "two", { promptTokens: -1, completionTokens: Infinity, totalTokens: NaN });
  assert.equal(result.mixedModels, true);
  assert.equal(result.promptTokens, undefined);
  assert.equal(result.totalTokens, undefined);
});

it("records every completion once in runtime snapshots, including calls without usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-usage-runtime-"));
  const agent: AgentSummary = {
    id: "usage-report", slug: "usage-report", name: "Usage report", description: "Usage fixture.",
    mode: "read", category: "devices", tier: "agent", requiresEntraTier: "free", scopes: [],
    author: { name: "OpenAdminOS", verified: true }, version: "1.0.0", installedAt: new Date().toISOString(), registryPath: dir,
  };
  await writeFile(join(dir, "manifest.yaml"), `descriptor:
  id: usage-report
  name: Usage report
  description: Usage fixture.
  version: 1.0.0
  author:
    name: OpenAdminOS
  category: devices
  mode: read
skills:
  - id: first
    format: llm
    label: First pass
    settings:
      prompt: First pass.
  - id: second
    format: llm
    label: Second pass
    settings:
      prompt: Second pass.
definition:
  result:
    summary: "{{ second.output.text }}"
`);
  try {
    for (const reportsAllCalls of [true, false]) {
      let calls = 0;
      const llm: RunLlmApi = {
        available: true, defaultModel: "deployment",
        async complete() { throw new Error("Runtime should wrap the stream."); },
        async *stream() {
          calls += 1;
          const tokenUsage = { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.01 };
          yield { delta: "Report", accumulated: "Report", model: "deployment-version", done: false, tokenUsage };
          yield { delta: "", accumulated: "Report", model: "deployment-version", done: true, ...(reportsAllCalls || calls === 1 ? { tokenUsage } : {}) };
        },
      };
      const snapshots: Array<unknown> = [];
      const result = await executeRun({
        run: createQueuedRun({ agent, providerId: "azure-openai", model: "deployment" }),
        agent, providerId: "azure-openai", model: "deployment", llm,
        createGraph: () => ({ listManagedDevices: async () => [], retireManagedDevice: async () => undefined, request: async () => { throw new Error("This fixture does not read tenant data."); } }),
        onProgress: (run) => { snapshots.push(structuredClone(run.usage)); },
      });
      assert.equal(result.status, "completed", result.error);
      assert.equal(result.usage?.calls, 2);
      assert.equal(result.usage?.model, "deployment");
      assert.equal(result.usage?.totalTokens, reportsAllCalls ? 240 : undefined);
      assert.equal(result.usage?.costUsd, reportsAllCalls ? 0.02 : undefined);
      assert.deepEqual(snapshots.at(-1), result.usage);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
