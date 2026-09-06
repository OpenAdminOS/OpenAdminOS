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
