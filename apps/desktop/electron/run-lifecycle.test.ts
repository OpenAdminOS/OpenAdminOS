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

it("blocks an installed agent whose declared services do not cover its scopes", async () => {
  const h = harness();
  const mismatched = { id: "mismatched", slug: "mismatched", name: "Device and group report", description: "Reads devices and groups",
    mode: "read", version: "1.0.0", installedAt: new Date().toISOString(), category: "compliance", tier: "agent",
    requiresEntraTier: "free", services: ["entra"],
    scopes: ["Group.Read.All", "DeviceManagementManagedDevices.Read.All", "User.Read"], author: { name: "Test" } } as AgentSummary;
  Object.assign(h.host, { appVersion: "0.7.2", listProviders: async () => [{ id: "ollama", status: "connected", models: ["test"], isLocal: true }],
    providerCanRun: () => true, buildLlm: async () => new Promise(() => {}) });
  // Entra is connected and Intune is not, so the declared services alone
  // would pass the service preflight.
  await h.host.write({ ...h.state(), installedAgents: [mismatched], activeTenantId: "tenant-a",
    tenants: [{ id: "tenant-a", displayName: "Contoso", grantedScopes: ["graph:User.Read", "graph:GroupMember.Read.All", "graph:Group.Read.All"] }] as any });
  await assert.rejects(
    h.service.startRun("mismatched", {}),
    /^Error: This agent uses DeviceManagementManagedDevices\.Read\.All, which its declared service Entra does not cover\. It cannot run until the agent also declares Intune\. Report it to the agent author\.$/,
  );
  assert.deepEqual(h.state().runs, []);
});

it("blocks a legacy agent that uses a scope no service lists", async () => {
  const h = harness();
  const legacy = { id: "legacy", slug: "legacy", name: "Legacy sites report", description: "Reads sites and groups",
    mode: "read", version: "1.0.0", installedAt: new Date().toISOString(), category: "compliance", tier: "agent",
    requiresEntraTier: "free", scopes: ["Group.Read.All", "Sites.Read.All"], author: { name: "Test" } } as AgentSummary;
  Object.assign(h.host, { appVersion: "0.7.2", listProviders: async () => [{ id: "ollama", status: "connected", models: ["test"], isLocal: true }],
    providerCanRun: () => true, buildLlm: async () => new Promise(() => {}) });
  await h.host.write({ ...h.state(), installedAgents: [legacy], activeTenantId: "tenant-a", tenants: [{ id: "tenant-a", displayName: "Contoso" }] as any });
  await assert.rejects(
    h.service.startRun("legacy", {}),
    /^Error: This agent uses Sites\.Read\.All, which OpenAdminOS does not map to a service yet\. It cannot run until that scope is added to the service registry\. Report it to the agent author or to OpenAdminOS\.$/,
  );
  assert.deepEqual(h.state().runs, []);

  // Group.Read.All alone maps to Entra, so a legacy manifest with it still
  // gets a service preflight instead of passing with no dependency.
  const groupsOnly = { ...legacy, scopes: ["Group.Read.All"] };
  await h.host.write({ ...h.state(), installedAgents: [groupsOnly], tenants: [{ id: "tenant-a", displayName: "Contoso", grantedScopes: ["graph:DeviceManagementApps.Read.All"] }] as any });
  await assert.rejects(
    h.service.startRun("legacy", {}),
    /^Error: Legacy sites report needs Entra, which is not connected for Contoso\./,
  );
});

it("refuses to start an agent whose service is not connected for the tenant", async () => {
  const h = harness();
  const agent = { id: "score", slug: "score", name: "Secure score prioritizer", description: "Ranks Secure Score actions",
    mode: "read", version: "1.0.0", installedAt: new Date().toISOString(), category: "compliance", tier: "agent",
    requiresEntraTier: "free", scopes: ["SecurityEvents.Read.All"], services: ["defender"], author: { name: "Test" } } as AgentSummary;
  Object.assign(h.host, { appVersion: "0.7.2", listProviders: async () => [{ id: "ollama", status: "connected", models: ["test"], isLocal: true }],
    providerCanRun: () => true, buildLlm: async () => new Promise(() => {}) });
  const intuneOnly = { id: "tenant-a", displayName: "Contoso", grantedScopes: ["graph:User.Read.All", "graph:GroupMember.Read.All", "graph:Organization.Read.All"] };
  await h.host.write({ ...h.state(), installedAgents: [agent], activeTenantId: "tenant-a", tenants: [intuneOnly] as any });
  await assert.rejects(
    h.service.startRun("score", {}),
    /^Error: Secure score prioritizer needs Defender, which is not connected for Contoso\. Add it in Connections, then run the agent again\.$/,
  );
  assert.deepEqual(h.state().runs, []);

  // Once any Defender part is granted the run is queued; a missing part is
  // consented at run time.
  await h.host.write({ ...h.state(), tenants: [{ ...intuneOnly, grantedScopes: [...intuneOnly.grantedScopes, "graph:SecurityAlert.Read.All", "graph:SecurityIncident.Read.All"] }] as any });
  const queued = await h.service.startRun("score", {});
  assert.equal(queued.status, "queued");
});

it('refuses a run reviewed with no organization once an organization became active (model fit rerun)', async () => {
  const h = harness();
  const agent = { id: 'docs', slug: 'docs', name: 'Docs', description: 'No service calls', requiresEntraTier: 'free', version: '1.0.0', mode: 'read', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  await h.host.write({ ...h.state(), installedAgents: [agent], tenants: [{ id: 'tenant-b' }] as any, activeTenantId: 'tenant-b' });
  await assert.rejects(h.service.startRun('docs', { expectNoTenant: true, providerId: 'anthropic' }), /organization became active after you reviewed this run/);
  assert.equal(h.state().runs.length, 0);
});

it('refuses an Ollama run whose reviewed destination changed and records an accepted Cloud alias', async () => {
  const h = harness();
  const agent = { id: 'docs', slug: 'docs', name: 'Docs', description: 'No service calls', requiresEntraTier: 'free', version: '1.0.0', mode: 'read', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  Object.assign(h.host, {
    appVersion: '0.7.2',
    listProviders: async () => [{ id: 'ollama', name: 'Ollama', status: 'connected', models: ['alias'], remoteModels: ['alias'], isLocal: true }],
    providerCanRun: () => true,
  });
  await h.host.write({ ...h.state(), installedAgents: [agent] });
  const options = { providerId: 'ollama' as const, model: 'alias' };
  await assert.rejects(h.service.startRun('docs', { ...options, expectedOllamaCloud: false }), /model destination changed/);
  assert.equal(h.state().runs.length, 0);
  const run = await h.service.startRun('docs', { ...options, expectedOllamaCloud: true });
  assert.equal(run.ollamaCloud, true);
});

it('admits a model fit rerun on a model on this device only after a fresh check that it runs here', async () => {
  const h = harness();
  const agent = { id: 'docs', slug: 'docs', name: 'Docs', description: 'No service calls', requiresEntraTier: 'free', version: '1.0.0', mode: 'read', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  Object.assign(h.host, {
    appVersion: '0.7.2',
    listProviders: async () => [{ id: 'ollama', name: 'Ollama', status: 'connected', models: ['gpt-oss:20b'], defaultModel: 'gpt-oss:20b', isLocal: true }],
    providerCanRun: () => true,
    verifyOnDeviceModel: async () => false,
  });
  await h.host.write({ ...h.state(), installedAgents: [agent], tenants: [] });
  await assert.rejects(h.service.startRun('docs', { requireOnDeviceModel: true, providerId: 'ollama', model: 'gpt-oss:20b' }), /could not confirm that gpt-oss:20b runs on this device/);
  // Without a model named, each phase could run another one: the rerun does not start.
  Object.assign(h.host, { listProviders: async () => [{ id: 'lm-studio', name: 'LM Studio', status: 'connected', models: [], isLocal: true }], verifyOnDeviceModel: async () => true });
  await assert.rejects(h.service.startRun('docs', { requireOnDeviceModel: true, providerId: 'lm-studio' }), /could not tell which LM Studio model this run uses/);
  assert.equal(h.state().runs.length, 0);
});

it('binds a model fit rerun to its endpoint and checks the model again when a phase builds it', async () => {
  const h = harness();
  const agent = { id: 'docs', slug: 'docs', name: 'Docs', description: 'No service calls', requiresEntraTier: 'free', version: '1.0.0', mode: 'read', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  const checks: boolean[] = [];
  const builds: Array<{ endpoint: string | undefined } | undefined> = [];
  Object.assign(h.host, {
    appVersion: '0.7.2',
    listProviders: async () => [{ id: 'ollama', name: 'Ollama', status: 'connected', models: ['gpt-oss:20b'], defaultModel: 'gpt-oss:20b', isLocal: true }],
    providerCanRun: () => true,
    // On this device at admission; a remote-backed alias by the time the run builds its model.
    verifyOnDeviceModel: async () => { const onDevice = checks.length === 0; checks.push(onDevice); return onDevice; },
    providerTarget: async () => ({ endpoint: 'http://127.0.0.1:11434', destination: 'dest-a' }),
    buildLlm: async (_id: string, _model: string | undefined, binding?: { endpoint: string | undefined }) => { builds.push(binding); return new Promise(() => {}); },
  });
  await h.host.write({ ...h.state(), installedAgents: [agent], tenants: [] });
  const run = await h.service.startRun('docs', { requireOnDeviceModel: true, bindProviderEndpoint: true, expectedProviderDestination: 'dest-a', providerId: 'ollama', model: 'gpt-oss:20b' });
  assert.equal(run.requireOnDeviceModel, true);
  assert.deepEqual(run.providerEndpointBinding, { endpoint: 'http://127.0.0.1:11434', scope: 'model-fit' });
  await settle();
  assert.deepEqual(checks, [true, false]);
  assert.deepEqual(builds, [], 'nothing was built once the model could not be confirmed');
  const failed = h.state().runs.find((entry) => entry.id === run.id);
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error ?? '', /still runs on this device/);
});

it('refuses a model fit rerun on a hosted provider that reports no model', async () => {
  const h = harness();
  const agent = { id: 'docs', slug: 'docs', name: 'Docs', description: 'No service calls', requiresEntraTier: 'free', version: '1.0.0', mode: 'read', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  let built = 0;
  Object.assign(h.host, {
    appVersion: '0.7.2',
    listProviders: async () => [{ id: 'openai', name: 'Codex', status: 'connected', models: [], isLocal: false }],
    providerCanRun: () => true,
    providerTarget: async () => ({ endpoint: undefined, destination: 'dest-openai' }),
    buildLlm: async () => { built += 1; return new Promise(() => {}); },
  });
  await h.host.write({ ...h.state(), installedAgents: [agent], tenants: [] });
  await assert.rejects(
    h.service.startRun('docs', { bindProviderEndpoint: true, expectedProviderDestination: 'dest-openai', providerId: 'openai', expectNoTenant: true }),
    /Codex does not report a model yet, so the run did not start/,
  );
  // A named model while the provider lists none, or a CLI default placeholder, is refused too.
  await assert.rejects(
    h.service.startRun('docs', { bindProviderEndpoint: true, expectedProviderDestination: 'dest-openai', providerId: 'openai', model: 'gpt-5', expectNoTenant: true }),
    /Codex does not report a model yet, so the run did not start/,
  );
  Object.assign(h.host, { listProviders: async () => [{ id: 'gemini', name: 'Gemini CLI', status: 'connected', models: ['gemini-default'], defaultModel: 'gemini-default', isLocal: false }] });
  await assert.rejects(
    h.service.startRun('docs', { bindProviderEndpoint: true, expectedProviderDestination: 'dest-openai', providerId: 'gemini', model: 'gemini-default', expectNoTenant: true }),
    /Gemini CLI does not report a model yet/,
  );
  assert.equal(built, 0);
});

it('keeps Run for real of a model fit dry run on the endpoint its dry run planned with', async () => {
  const h = harness();
  const agent = { id: 'writer', slug: 'writer', name: 'Writer', description: 'Writes', requiresEntraTier: 'free', version: '1.0.0', mode: 'write', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  Object.assign(h.host, {
    appVersion: '0.7.2',
    listProviders: async () => [{ id: 'azure-openai', name: 'Azure OpenAI', status: 'available', models: ['dep'], defaultModel: 'dep', isLocal: false }],
    providerCanRun: () => true,
    // The admin configured another resource with the same deployment name in setup.
    providerTarget: async () => ({ endpoint: 'https://b.openai.azure.com#dep', destination: 'dest-b' }),
    buildLlm: async () => new Promise(() => {}),
  });
  const planned = { id: 'dry-az', agentSlug: 'writer', dryRun: true, status: 'planned', tenantId: 'tenant-a', providerId: 'azure-openai', model: 'dep', inputSettings: {},
    providerEndpointBinding: { endpoint: 'https://a.openai.azure.com#dep', scope: 'model-fit' }, queuedAt: new Date().toISOString(), steps: [], logs: [] } as unknown as RunRecord;
  await h.host.write({ ...h.state(), installedAgents: [agent], tenants: [{ id: 'tenant-a' }] as any, activeTenantId: 'tenant-a', runs: [planned] });
  await assert.rejects(
    h.service.startRun('writer', { runForRealOfRunId: 'dry-az', bindProviderEndpoint: true, expectedProviderDestination: 'dest-b', providerId: 'azure-openai', model: 'dep', tenantId: 'tenant-a' }),
    /reached somewhere else than when the dry run planned/,
  );
});

it('refuses a model fit rerun whose destination changed after its review, and keeps the safeguards into Run for real', async () => {
  const h = harness();
  const agent = { id: 'writer', slug: 'writer', name: 'Writer', description: 'Writes', requiresEntraTier: 'free', version: '1.0.0', mode: 'write', category: 'devices', tier: 'agent', scopes: [], author: { name: 'Test' }, installedAt: new Date().toISOString() } as AgentSummary;
  let onDevice = true;
  Object.assign(h.host, {
    appVersion: '0.7.2',
    listProviders: async () => [{ id: 'ollama', name: 'Ollama', status: 'connected', models: ['gpt-oss:20b'], defaultModel: 'gpt-oss:20b', isLocal: true }],
    providerCanRun: () => true,
    verifyOnDeviceModel: async () => onDevice,
    providerTarget: async () => ({ endpoint: 'http://127.0.0.1:11434', destination: 'dest-b' }),
    buildLlm: async () => new Promise(() => {}),
  });
  await h.host.write({ ...h.state(), installedAgents: [agent], tenants: [{ id: 'tenant-a' }] as any, activeTenantId: 'tenant-a' });
  await assert.rejects(
    h.service.startRun('writer', { bindProviderEndpoint: true, expectedProviderDestination: 'dest-a', providerId: 'ollama', model: 'gpt-oss:20b', tenantId: 'tenant-a' }),
    /settings changed after this run was reviewed/,
  );
  // A review that could not read the destination does not start, and says so.
  await assert.rejects(
    h.service.startRun('writer', { bindProviderEndpoint: true, providerId: 'ollama', model: 'gpt-oss:20b', tenantId: 'tenant-a' }),
    /could not read where the provider is reached when the run was reviewed/,
  );
  // A model fit dry run that planned on this device: Run for real keeps the on-device requirement.
  const planned = { id: 'dry-1', agentSlug: 'writer', dryRun: true, status: 'planned', tenantId: 'tenant-a', providerId: 'ollama', model: 'gpt-oss:20b', inputSettings: {},
    requireOnDeviceModel: true, providerEndpointBinding: { endpoint: 'http://127.0.0.1:11434', scope: 'model-fit' }, queuedAt: new Date().toISOString(), steps: [], logs: [] } as unknown as RunRecord;
  await h.host.write({ ...h.state(), runs: [planned] });
  onDevice = false;
  await assert.rejects(h.service.startRun('writer', { runForRealOfRunId: 'dry-1' }), /could not confirm that gpt-oss:20b runs on this device/);
  onDevice = true;
  const real = await h.service.startRun('writer', { runForRealOfRunId: 'dry-1' });
  assert.equal(real.requireOnDeviceModel, true);
  assert.deepEqual(real.providerEndpointBinding, { endpoint: 'http://127.0.0.1:11434', scope: 'model-fit' });
});

it('records a fit issue on a failed run only after confirming its model ran on this device', async () => {
  const h = harness();
  let onDevice = true;
  Object.assign(h.host, {
    listProviders: async () => [{ id: 'ollama', name: 'Ollama', status: 'connected', models: ['gpt-oss:20b'], defaultModel: 'gpt-oss:20b', isLocal: true }],
    verifyOnDeviceModel: async () => onDevice,
  });
  const failed = (id: string) => ({ id, agentSlug: 'docs', status: 'failed', providerId: 'ollama', model: 'gpt-oss:20b', queuedAt: new Date().toISOString(), steps: [], logs: [],
    error: 'Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could only give gpt-oss:20b 16,384, usually because free memory ran out.' }) as unknown as RunRecord;
  // Both runs are still running when their failure is saved.
  await h.host.write({ ...h.state(), runs: [{ ...failed('r1'), status: 'running' }, { ...failed('r2'), status: 'running' }] as RunRecord[] });
  await h.service.persistRunSnapshot(failed('r1'));
  assert.deepEqual(h.state().runs.find((run) => run.id === 'r1')?.modelFit, { reason: 'context-too-small', neededTokens: 40652, limitTokens: 16384, providerId: 'ollama', model: 'gpt-oss:20b' });
  // A later snapshot of the same failure, with Ollama no longer answering, keeps the confirmed issue
  // (and a later check never decides it).
  onDevice = false;
  await h.service.persistRunSnapshot(failed('r1'));
  assert.equal(h.state().runs.find((run) => run.id === 'r1')?.modelFit?.reason, 'context-too-small');
  // The alias is remote-backed when the run fails: nothing is offered.
  await h.service.persistRunSnapshot(failed('r2'));
  assert.equal(h.state().runs.find((run) => run.id === 'r2')?.modelFit, undefined);
  // A later snapshot, once the model is confirmed again, does not stamp it after the fact.
  onDevice = true;
  await h.service.persistRunSnapshot(failed('r2'));
  assert.equal(h.state().runs.find((run) => run.id === 'r2')?.modelFit, undefined);
});

it('offers no model fit for a reply with reasoning and no answer whose text reads like a context failure', async () => {
  const h = harness();
  Object.assign(h.host, {
    listProviders: async () => [{ id: 'ollama', name: 'Ollama', status: 'connected', models: ['exceed_context_size_error:latest'], defaultModel: 'exceed_context_size_error:latest', isLocal: true }],
    verifyOnDeviceModel: async () => true,
  });
  const failed = { id: 'r5', agentSlug: 'docs', status: 'failed', providerId: 'ollama', model: 'exceed_context_size_error:latest', queuedAt: new Date().toISOString(), steps: [], logs: [],
    failureCause: 'reasoning-without-answer',
    error: 'Ollama context size too small: This request needs 40,652 tokens of context, but Ollama could only give exceed_context_size_error:latest 16,384, usually because free memory ran out.' } as unknown as RunRecord;
  await h.host.write({ ...h.state(), runs: [{ ...failed, status: 'running' }] as RunRecord[] });
  await h.service.persistRunSnapshot(failed);
  assert.equal(h.state().runs.find((run) => run.id === 'r5')?.modelFit, undefined);
});

it('offers nothing for a hosted provider failure that reads like a context failure', async () => {
  const h = harness();
  Object.assign(h.host, {
    listProviders: async () => [{ id: 'openai', name: 'Codex', status: 'connected', models: ['gpt-5'], defaultModel: 'gpt-5', isLocal: false }],
    verifyOnDeviceModel: async () => true,
  });
  const failed = { id: 'r4', agentSlug: 'docs', status: 'failed', providerId: 'openai', model: 'gpt-5', queuedAt: new Date().toISOString(), steps: [], logs: [],
    error: 'Context size has been exceeded.' } as unknown as RunRecord;
  await h.host.write({ ...h.state(), runs: [{ ...failed, status: 'running' }] as RunRecord[] });
  await h.service.persistRunSnapshot(failed);
  assert.equal(h.state().runs.find((run) => run.id === 'r4')?.modelFit, undefined);
});

it('saves an unrelated run failure without waiting on provider discovery', async () => {
  const h = harness();
  let listed = 0;
  Object.assign(h.host, { listProviders: async () => { listed += 1; return []; }, verifyOnDeviceModel: async () => true });
  const failed = { id: 'r3', agentSlug: 'docs', status: 'failed', providerId: 'ollama', model: 'gpt-oss:20b', queuedAt: new Date().toISOString(), steps: [], logs: [],
    error: 'Graph returned 403 Forbidden for /deviceManagement/managedDevices.' } as unknown as RunRecord;
  await h.host.write({ ...h.state(), runs: [{ ...failed, status: 'running' }] as RunRecord[] });
  await h.service.persistRunSnapshot(failed);
  assert.equal(h.state().runs.find((run) => run.id === 'r3')?.status, 'failed');
  assert.equal(listed, 0);
});
