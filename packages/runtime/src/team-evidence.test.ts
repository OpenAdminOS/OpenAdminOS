import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentSummary,
  RunLlmApi,
  RunGraphApi,
} from "@openadminos/agent-sdk";
import { createQueuedRun, executeRun } from "./index.js";
for (const slug of ["team-evidence-review", "team-script-draft"])
  test(`${slug} uses bounded host evidence without Graph access`, async () => {
    const agent: AgentSummary = {
      id: slug,
      slug,
      name: slug,
      description: "Evidence test",
      mode: "read",
      category: "devices",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: [],
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      author: { name: "Test", verified: false },
      registryPath: resolve(
        fileURLToPath(new URL("../../../agents/", import.meta.url)),
        slug,
      ),
    };
    let prompt = "";
    const llm: RunLlmApi = {
      available: true,
      complete: async (p) => {
        prompt = p.prompt;
        return { text: "Evidence reviewed.", model: "test" };
      },
      async *stream(p) {
        prompt = p.prompt;
        yield {
          delta: "Evidence reviewed.",
          accumulated: "Evidence reviewed.",
          done: true,
          model: "test",
        };
      },
    };
    const graph: RunGraphApi = {
      request: async () => {
        throw new Error("Evidence tasks must not collect Graph data.");
      },
      listManagedDevices: async () => {
        throw new Error("No Graph reads.");
      },
      retireManagedDevice: async () => {
        throw new Error("No writes.");
      },
    };
    const run = createQueuedRun({ agent, providerId: "ollama" });
    run.tenantId = "tenant-a";
    run.officeContext = {
      tenantId: "tenant-a",
      question: "Explain the change.",
      instructions: "Cite the source.",
      evidence: [
        {
          runId: "source-1",
          agentSlug: "compliance-overview",
          finishedAt: "2026-09-11T10:00:00Z",
          summary: "One noncompliant device.",
          result: { counts: { noncompliant: 1 } },
        },
      ],
    };
    const completed = await executeRun({
      run,
      agent,
      providerId: "ollama",
      llm,
      createGraph: () => graph,
      onProgress: () => {},
    });
    assert.equal(completed.status, "completed", completed.error);
    assert.equal(completed.summary, "Evidence reviewed.");
    assert.match(prompt, /source-1/);
    assert.match(prompt, /noncompliant/);
    assert.match(prompt, /Cite the source/);
  });

test('compliance assessment preserves every state and reconciles missing values with the total', async () => {
  const slug = 'compliance-overview';
  const agent = { id: slug, slug, name: slug, description: 'Test', mode: 'read', category: 'compliance', tier: 'dashboard', requiresEntraTier: 'free', scopes: ['DeviceManagementManagedDevices.Read.All'], version: '1.1.1', installedAt: new Date().toISOString(), author: { name: 'Test', verified: false }, settings: { staleSyncDays: 14 }, registryPath: resolve(fileURLToPath(new URL('../../../agents/', import.meta.url)), slug) } as AgentSummary;
  const states = ['compliant', 'noncompliant', 'inGracePeriod', 'error', 'conflict', 'notApplicable', 'futureState', null, undefined, ''];
  let prompt = '';
  const llm = { available: true, complete: async (p: any) => { prompt = p.prompt; return { text: 'Assessment reviewed.', model: 'test' }; }, async *stream(p: any) { prompt = p.prompt; yield { delta: 'Assessment reviewed.', accumulated: 'Assessment reviewed.', model: 'test', done: true }; } } as RunLlmApi;
  const graph = { request: async () => ({ value: states.map((complianceState, i) => ({ id: String(i), complianceState, lastSyncDateTime: new Date().toISOString() })) }) } as unknown as RunGraphApi;
  const completed = await executeRun({ run: createQueuedRun({ agent, providerId: 'ollama' }), agent, providerId: 'ollama', llm, createGraph: () => graph, onProgress: () => {} });
  assert.equal(completed.status, 'completed', completed.error);
  const result = completed.result as { data: { counts: Record<string, number>; totalDevices: number } };
  // Template results expose definition.result.data as the run result.
  const data = (result.data ?? result) as { counts: Record<string, number>; totalDevices: number };
  assert.equal(data.totalDevices, states.length);
  assert.equal(data.counts.inGracePeriod, 1);
  assert.equal(data.counts.futureState, 1);
  assert.equal(data.counts.unknown, 3);
  assert.equal(Object.values(data.counts).reduce((sum, n) => sum + n, 0), states.length);
  assert.match(prompt, /inGracePeriod/); assert.match(prompt, /futureState/);
});

test('an empty Team draft fails instead of claiming successful completion', async () => {
  const slug = 'team-script-draft';
  const agent = { id: slug, slug, name: slug, description: 'Test', mode: 'read', category: 'devices', tier: 'agent', requiresEntraTier: 'free', scopes: [], version: '1.0.1', installedAt: new Date().toISOString(), author: { name: 'Test', verified: false }, registryPath: resolve(fileURLToPath(new URL('../../../agents/', import.meta.url)), slug) } as AgentSummary;
  const llm = { available: true, async *stream() { yield { delta: '', accumulated: '', model: 'test', done: true }; } } as unknown as RunLlmApi;
  const completed = await executeRun({ run: createQueuedRun({ agent, providerId: 'ollama' }), agent, providerId: 'ollama', llm, createGraph: () => ({}) as RunGraphApi, onProgress: () => {} });
  assert.equal(completed.status, 'failed');
  assert.match(completed.error!, /no usable answer.*Retry/);
});
