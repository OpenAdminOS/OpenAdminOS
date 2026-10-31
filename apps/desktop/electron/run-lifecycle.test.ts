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


it("rejects dry runs for read agents and schedules before provider or tenant work", async () => {
  const h = harness();
  const agent = { slug: "test", mode: "read" } as AgentSummary;
  await h.host.write({ ...h.state(), installedAgents: [agent] });
  await assert.rejects(h.service.startRun("test", { dryRun: true }), /only available for write agents/);
  agent.mode = "write";
  await h.host.write({ ...h.state(), installedAgents: [agent] });
  await assert.rejects(h.service.startRun("test", { dryRun: true, trigger: "schedule" }), /manual run options/);
  assert.deepEqual(h.state().runs, []);
});

it("starts Run for real from saved inputs with a fresh run id and no reusable plan", async () => {
  const h = harness();
  const original = { id: "dry", agentSlug: "test", status: "planned", dryRun: true,
    tenantId: "tenant-a", providerId: "ollama", model: "test", inputSettings: { cutoffDays: 90 },
    queuedAt: new Date().toISOString(), steps: [], logs: [],
    plan: { summary: "Old plan", confirmationPhrase: "CHANGE 1 OBJECT", actions: [] } } as RunRecord;
  const agent = { id: "test", slug: "test", name: "Test", mode: "write", version: "1.0.0", settings: { cutoffDays: 1 },
    installedAt: new Date().toISOString(), description: "Test dry runs", category: "devices", tier: "agent",
    requiresEntraTier: "free", scopes: [], author: { name: "Test" } } satisfies AgentSummary;
  Object.assign(h.host, { appVersion: "0.7.2", listProviders: async () => [{ id: "ollama", status: "connected", models: ["test"], isLocal: true }],
    providerCanRun: () => true, buildLlm: async () => new Promise(() => {}) });
  await h.host.write({ ...h.state(), installedAgents: [agent], runs: [original], activeTenantId: "tenant-b",
    tenants: [{ id: "tenant-a" }, { id: "tenant-b" }] as any });
  const fresh = await h.service.startRun("test", { runForRealOfRunId: original.id });
  assert.notEqual(fresh.id, original.id);
  assert.equal(fresh.status, "queued");
  assert.equal(fresh.tenantId, "tenant-a");
  assert.equal(fresh.providerId, "ollama");
  assert.equal(fresh.model, "test");
  assert.deepEqual(fresh.inputSettings, { cutoffDays: 90 });
  assert.equal(fresh.dryRun, undefined);
  assert.equal(fresh.plan, undefined);
  assert.equal(fresh.confirmedAt, undefined);
  assert.deepEqual(h.state().installedAgents[0]?.settings, { cutoffDays: 1 });
  await assert.rejects(h.service.startRun("test", { runForRealOfRunId: original.id, tenantId: "tenant-b" }), /must keep the dry run tenant/);
  await assert.rejects(h.service.startRun("test", { runForRealOfRunId: original.id, dryRun: true }), /fresh normal run/);
  await assert.rejects(h.service.startRun("test", { runForRealOfRunId: "missing" }), /completed dry run is unavailable/);
});

it("keeps planned runs terminal across restart and delayed progress", async () => {
  const h = harness();
  const pending = await queue(h);
  const planned = { ...pending, dryRun: true, status: "planned" as const, finishedAt: new Date().toISOString() };
  await h.host.write({ ...h.state(), runs: [planned] });
  await h.service.recoverInterruptedRuns();
  await h.service.persistRunSnapshot({ ...planned, status: "running" });
  assert.equal(h.state().runs[0]?.status, "planned");
  assert.equal((await h.service.cancelRun(planned.id)).status, "planned");
});

it("plans again from live inventory and saved effective settings when Run for real starts", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "openadminos-dry-replan-"));
  const h = harness();
  const agent = { id: "dry-replan", slug: "dry-replan", name: "Dry replan", mode: "write", version: "1.0.0",
    registryPath: dir, scopes: ["User.ReadWrite.All"] } as AgentSummary;
  let inventory = [{ id: "first" }];
  let reads = 0;
  const writes: GraphRequestInput[] = [];
  const dryFinished = deferred();
  const realPlanned = deferred();
  const realFinished = deferred();
  const persist = h.host.write;
  h.host.write = async state => {
    await persist(state);
    if (state.runs.some(run => run.dryRun && run.status === "planned")) dryFinished.resolve();
    if (state.runs.some(run => !run.dryRun && run.status === "awaiting-confirmation")) realPlanned.resolve();
    if (state.runs.some(run => !run.dryRun && run.status === "completed")) realFinished.resolve();
  };
  Object.assign(h.host, {
    appVersion: "0.7.2",
    listProviders: async () => [{ id: "ollama", name: "Ollama", status: "connected", models: ["test"], defaultModel: "test", isLocal: true }],
    providerCanRun: () => true,
    buildLlm: async () => ({ available: true, defaultModel: "test", complete: async () => ({ text: "Review changes", model: "test" }),
      stream: async function* () { yield { delta: "Review changes", accumulated: "Review changes", done: true, model: "test" }; } }),
    buildGraph: async () => ({ tenantId: "tenant-a", createGraph: () => ({
      listManagedDevices: async () => [], retireManagedDevice: async () => { throw new Error("Unexpected retire"); },
      request: async (input: GraphRequestInput) => {
        if (input.method !== "GET") { writes.push(input); return {}; }
        reads += 1; return { value: inventory };
      },
    }) }),
    selfTrainingPromptOverlay: () => undefined,
    readConnectorConfigs: async () => ({}),
  });
  const waitForPlan = async (ready: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([ready, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(JSON.stringify(h.state().runs))), 5000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    await writeFile(join(dir, "manifest.yaml"), `
descriptor:
  id: dry-replan
  name: Dry replan
  description: Test fresh planning.
  version: 1.0.0
  author: { name: OpenAdminOS }
  category: policies
  mode: write
skills:
  - id: load
    format: graph
    label: Read users
    settings:
      method: GET
      path: /users
      scopes: [User.Read.All]
  - id: explain
    format: llm
    label: Explain changes
    settings:
      prompt: Review the proposed changes.
  - id: disable
    format: write
    label: Prepare plan
    settings:
      kind: graph-write
      source: "{{ load.output }}"
      confirmationPhrase: "DISABLE {{ actions | size }} USERS"
      summary: "Review using threshold {{ settings.cutoffDays }}"
      scopes: [User.ReadWrite.All]
      actionTemplate:
        label: "Disable {{ item.id }}"
        severity: destructive
        request:
          method: PATCH
          path: "/users/{{ item.id }}"
          body: { accountEnabled: false }
definition:
  settings:
    - id: cutoffDays
      label: Cutoff days
      type: number
      default: 30
  result:
    summary: "{{ explain.output.text }}"
`);
    await persist({ ...h.state(), installedAgents: [agent], activeTenantId: "tenant-a", tenants: [{ id: "tenant-a" }] as any });
    const dry = await h.service.startRun(agent.slug, { dryRun: true });
    await waitForPlan(dryFinished.promise);
    assert.deepEqual(h.state().runs[0]?.inputSettings, { cutoffDays: 30 });
    assert.equal(h.state().runs[0]?.plan?.actions[0]?.request?.path, "/users/first");
    inventory = [{ id: "second" }];
    await persist({ ...h.state(), installedAgents: [{ ...agent, settings: { cutoffDays: 1 } }] });
    const real = await h.service.startRun(agent.slug, { runForRealOfRunId: dry.id });
    await waitForPlan(realPlanned.promise);
    const replanned = h.state().runs.find(run => run.id === real.id)!;
    assert.equal(replanned.plan?.actions[0]?.request?.path, "/users/second");
    assert.equal(replanned.plan?.summary, "Review using threshold 30");
    assert.equal(replanned.confirmedAt, undefined);
    assert.equal(reads, 2);
    assert.equal(writes.length, 0);
    await h.service.confirmRun(real.id, replanned.plan!.confirmationPhrase);
    await waitForPlan(realFinished.promise);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.path, "/users/second");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
