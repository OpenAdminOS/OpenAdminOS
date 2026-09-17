import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunRecord, AgentSummary, GraphRequestInput } from "@openadminos/agent-sdk";
import { RunService, type RunPersistedState, type RunServiceHost } from "./runs.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  let state: RunPersistedState = { activeProviderId: "ollama", installedAgents: [], runs: [], tenants: [] };
  let tail: Promise<unknown> = Promise.resolve();
  const entered = deferred();
  const release = deferred();
  const requests: GraphRequestInput[] = [];
  let signal: AbortSignal | undefined;
  const host = {
    read: async () => structuredClone(state),
    write: async (next: RunPersistedState) => { state = structuredClone(next); },
    serialize: <T>(task: () => Promise<T>): Promise<T> => {
      const next = tail.then(task); tail = next.catch(() => undefined); return next;
    },
    buildGraph: async (_tenant, _scopes, execution) => {
      signal = execution?.signal;
      return { tenantId: "test", tenantSession: {} as never, createGraph: () => ({
        request: async (input: GraphRequestInput) => {
          requests.push(input); entered.resolve(); await release.promise;
        },
      }) as never };
    },
    listProviders: async () => { throw new Error("Provider discovery unavailable"); },
    recordLearningEventSafely: () => undefined,
    emitStateChanged: () => undefined,
    notifyRunFinished: () => undefined,
    enqueueRunDeliveries: async () => undefined,
    processPendingRunDeliveries: async () => undefined,
  } satisfies Partial<RunServiceHost>;
  return { service: new RunService(host as unknown as RunServiceHost), host, entered, release, requests,
    state: () => state, signal: () => signal };
}
async function queue(h: ReturnType<typeof harness>) {
  return h.service.startRollbackRun({ tenantId: "test", baselineId: "test", requiredScopes: [], manualCount: 0,
    plan: { summary: "Restore two objects", confirmationPhrase: "ROLLBACK 2 OBJECTS", actions: [0, 1].map((i) => ({
      id: String(i), kind: "graph-write", label: `Restore ${i}`, severity: "default" as const,
      request: { method: "PATCH" as const, path: `/test/${i}`, body: {} },
    })) },
  });
}
async function settle() { await new Promise((resolve) => setTimeout(resolve, 20)); }

describe("run lifecycle", () => {
  it("stops between approved actions and retains the outcome of the dispatched request", async () => {
    const h = harness(); const run = await queue(h);
    await h.service.confirmRun(run.id, "ROLLBACK 2 OBJECTS");
    await h.entered.promise;
    await h.service.cancelRun(run.id);
    assert.equal(h.signal()?.aborted, true);
    h.release.resolve(); await settle();
    assert.equal(h.requests.length, 1);
    const stored = h.state().runs[0]!;
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.steps[0]?.status, "completed");
    assert.match(stored.summary ?? "", /already sent/);
  });

  it("does not revive a cancellation when a snapshot was queued before cancel finished", async () => {
    const h = harness(); const run = await queue(h);
    const cancel = h.service.cancelRun(run.id);
    const progress = h.service.persistRunSnapshot({ ...run, status: "running" });
    await Promise.all([cancel, progress]);
    assert.equal(h.state().runs[0]?.status, "cancelled");
  });

  it("recovers interrupted work without replaying writes or removing pending approval", async () => {
    const h = harness(); const pending = await queue(h);
    const running: RunRecord = { ...pending, id: "interrupted", status: "running", confirmedAt: new Date().toISOString() };
    await h.host.write({ ...h.state(), runs: [pending, running, { ...pending, id: "queued", status: "queued" }] });
    await h.service.recoverInterruptedRuns();
    assert.deepEqual(h.state().runs.map((r) => r.status), ["awaiting-confirmation", "failed", "failed"]);
    assert.match(h.state().runs[1]?.summary ?? "", /Review the tenant/);
    assert.equal(h.requests.length, 0);
  });

  it("leaves approval pending if provider discovery fails before apply", async () => {
    const h = harness(); const run = await queue(h);
    const agent = { slug: "write-test", mode: "write" } as AgentSummary;
    await h.host.write({ ...h.state(), installedAgents: [agent], runs: [{ ...run, origin: undefined, agentSlug: agent.slug }] });
    await assert.rejects(h.service.confirmRun(run.id, "ROLLBACK 2 OBJECTS"), /Provider discovery/);
    assert.equal(h.state().runs[0]?.status, "awaiting-confirmation");
    assert.equal(h.requests.length, 0);
  });
});

it('coalesces a streaming burst and persists its terminal state without a per-token backlog', async () => {
  const h = harness();
  const run = await queue(h);
  const entered = deferred(), release = deferred();
  const write = h.host.write;
  let writes = 0;
  h.host.write = async state => { if (++writes === 1) { entered.resolve(); await release.promise; } await write(state); };
  const first = h.service.queueRunSnapshot({ ...run, status: 'running', summary: 'first' });
  await entered.promise;
  const updates = Array.from({ length: 300 }, (_, index) => h.service.queueRunSnapshot({ ...run, status: 'running', summary: String(index) }));
  const final = h.service.queueRunSnapshot({ ...run, status: 'failed', error: 'Model timeout', summary: 'Model timeout', finishedAt: new Date().toISOString() });
  release.resolve();
  await Promise.all([first, ...updates, final]);
  assert.equal(writes, 2);
  assert.equal(h.state().runs[0]?.status, 'failed');
  assert.equal(h.state().runs[0]?.error, 'Model timeout');
});

it('retries a read-only Team task using host-owned evidence and rejects cross-tenant or missing sources', async () => {
  const h = harness();
  const source = { id: 'source', agentSlug: 'assessment', status: 'completed', tenantId: 'tenant-a', queuedAt: new Date().toISOString(), steps: [], logs: [] } as RunRecord;
  const original = { ...source, id: 'original', agentSlug: 'draft', status: 'failed', providerId: 'ollama', model: 'test', officeContext: { tenantId: 'tenant-a', question: 'Draft the diagnostics.', instructions: 'Read only.', evidence: [{ runId: 'source', agentSlug: 'assessment', finishedAt: new Date().toISOString(), summary: 'Assessment', result: { counts: { inGracePeriod: 1 } } }] } } as RunRecord;
  const agent = { id: 'draft', slug: 'draft', name: 'Draft', description: 'Evidence draft', requiresEntraTier: 'free', version: '1.0.0', mode: 'read', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  Object.assign(h.host, { appVersion: '0.6.3', listProviders: async () => [{ id: 'ollama', status: 'connected', models: ['test'], defaultModel: 'test', isLocal: true }], providerCanRun: () => true, buildLlm: async () => new Promise(() => {}) });
  const reset = async (runs = [original, source]) => h.host.write({ ...h.state(), runs, installedAgents: [agent], tenants: [{ id: 'tenant-a' }, { id: 'tenant-b' }] as any, activeTenantId: 'tenant-b' });
  await reset();
  const retried = await h.service.startRun('draft', { retryOfRunId: original.id });
  assert.equal(retried.tenantId, 'tenant-a');
  assert.equal(retried.providerId, 'ollama');
  assert.equal(retried.model, 'test');
  assert.deepEqual(retried.officeContext, original.officeContext);
  assert.equal(retried.retryOfRunId, original.id);
  assert.equal(retried.office, undefined, 'manual retry must not impersonate a mission child');
  await reset();
  await assert.rejects(h.service.startRun('draft', { retryOfRunId: original.id, tenantId: 'tenant-b' }), /another tenant/);
  await reset([original]);
  await assert.rejects(h.service.startRun('draft', { retryOfRunId: original.id }), /evidence is missing/);
  await reset([original, { ...source, tenantId: 'tenant-b' }]);
  await assert.rejects(h.service.startRun('draft', { retryOfRunId: original.id }), /another tenant/);
  await reset();
  Object.assign(h.host, { listProviders: async () => [{ id: 'ollama', status: 'connected', models: ['test'], isLocal: false }] });
  await assert.rejects(h.service.startRun('draft', { retryOfRunId: original.id }), /hosted provider destination/);
  agent.mode = 'write'; await reset();
  await assert.rejects(h.service.startRun('draft', { retryOfRunId: original.id }), /Retry write assignments from Agent Team/);
});
