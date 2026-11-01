import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { AgentSummary, RunRecord, WritePlan } from "@openadminos/agent-sdk";
import { RunService, type RunPersistedState, type RunServiceHost } from "./runs.js";

const agent: AgentSummary = {
  id: "review", slug: "review", name: "Review", description: "Review fixture.",
  mode: "write", category: "devices", tier: "agent", requiresEntraTier: "free",
  scopes: [], author: { name: "OpenAdminOS", verified: true }, version: "1.0.0",
  installedAt: "2026-10-31T00:00:00Z",
  graphOperations: [{ method: "DELETE", path: "/users/{id}" }],
};

function plan(count = 1): WritePlan {
  return { summary: "Delete reviewed users.", confirmationPhrase: `DELETE ${count} USERS`,
    actions: Array.from({ length: count }, (_, index) => ({ id: `action-${index}`, kind: "graph-write", label: `Delete user ${index}`, request: { method: "DELETE", path: `/users/user-${index}` } })) };
}
function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return { id: "current", agentSlug: "review", tenantId: "tenant-1", status: "awaiting-confirmation",
    queuedAt: "2026-10-31T00:00:00Z", steps: [], logs: [], plan: plan(), ...overrides };
}

async function fixture(history: RunRecord[] = [], installed: AgentSummary = agent) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-risk-flags-"));
  const path = join(dir, "state.json");
  await writeFile(path, JSON.stringify({ activeProviderId: "ollama", installedAgents: [installed], tenants: [], runs: history }));
  const read = async () => JSON.parse(await readFile(path, "utf8")) as RunPersistedState;
  const host = {
    read,
    write: async (state: RunPersistedState) => { await writeFile(path, JSON.stringify(state)); },
    serialize: async <T>(fn: () => Promise<T>) => fn(),
    recordLearningEventSafely() {}, notifyRunFinished() {}, emitStateChanged() {},
    enqueueRunDeliveries: async () => {}, processPendingRunDeliveries: async () => {},
  } as unknown as RunServiceHost;
  return { service: new RunService(host), read, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

describe("host write plan risk assessment", () => {
  it("assesses accepted plans before persistence and preserves flags in terminal history", async () => {
    const f = await fixture();
    try {
      const pending = run({ riskAssessment: { status: "complete", flags: [] } });
      await f.service.persistRunSnapshot(pending);
      const stored = (await f.read()).runs[0]!;
      assert.equal(stored.riskAssessment?.status, "complete");
      if (stored.riskAssessment?.status !== "complete") assert.fail("Missing assessment");
      assert.deepEqual(stored.riskAssessment.flags.map((flag) => flag.id), ["directory-object-deletion"]);
      await f.service.persistRunSnapshot({ ...pending, status: "completed", riskAssessment: undefined });
      assert.deepEqual((await f.read()).runs[0]?.riskAssessment, stored.riskAssessment);
    } finally { await f.cleanup(); }
  });

  it("uses only confirmed plans for the same agent and tenant, excluding the current run", async () => {
    const f = await fixture([
      run({ id: "confirmed", status: "failed", confirmedAt: "2026-10-30T00:00:00Z" }),
      run({ id: "other-tenant", tenantId: "tenant-2", confirmedAt: "yes", plan: plan(100) }),
      run({ id: "other-agent", agentSlug: "another", confirmedAt: "yes", plan: plan(100) }),
      run({ id: "rejected", status: "rejected", plan: plan(100) }),
      run({ id: "empty", confirmedAt: "yes", plan: plan(0) }),
      run({ confirmedAt: "yes", plan: plan(100) }),
    ]);
    try {
      await f.service.persistRunSnapshot(run({ plan: plan(4) }));
      const risk = (await f.read()).runs.find((candidate) => candidate.id === "current")?.riskAssessment;
      assert.equal(risk?.status, "complete");
      if (risk?.status !== "complete") assert.fail("Missing assessment");
      assert.ok(risk.flags.some((flag) => flag.id === "unusual-plan-size"));
    } finally { await f.cleanup(); }
  });

  it("records assessor failure as a failure verdict while keeping the run awaiting confirmation", async () => {
    const f = await fixture();
    try {
      const pending = run();
      pending.plan!.actions[0]!.request!.path = "/users/%invalid";
      await f.service.persistRunSnapshot(pending);
      const stored = (await f.read()).runs[0]!;
      assert.equal(stored.status, "awaiting-confirmation");
      assert.deepEqual(stored.riskAssessment, { status: "failed", reason: "A proposed Graph request path contains invalid encoding" });
      assert.deepEqual(stored.plan, pending.plan);
    } finally { await f.cleanup(); }
  });

  it("assesses rollback and external proposals without treating them as undeclared agent requests", async () => {
    const f = await fixture();
    try {
      const rollback = await f.service.startRollbackRun({ tenantId: "tenant-1", baselineId: "baseline", plan: plan(), requiredScopes: [], manualCount: 0 });
      const external = await f.service.startExternalProposalRun({ tenantId: "tenant-1", clientName: "External client", plan: plan(), requiredScopes: [] });
      for (const pending of [rollback, external]) {
        assert.equal(pending.riskAssessment?.status, "complete");
        if (pending.riskAssessment?.status !== "complete") assert.fail("Missing assessment");
        assert.deepEqual(pending.riskAssessment.flags.map((flag) => flag.id), ["directory-object-deletion"]);
        assert.deepEqual((await f.read()).runs.find((candidate) => candidate.id === pending.id)?.riskAssessment, pending.riskAssessment);
      }
    } finally { await f.cleanup(); }
  });

  it("skips declaration matching when an installed agent has no Graph operation list", async () => {
    const f = await fixture([], { ...agent, graphOperations: undefined });
    try {
      await f.service.persistRunSnapshot(run({ plan: { summary: "Disable guests.", confirmationPhrase: "DISABLE 1 GUESTS",
        actions: [{ id: "a", kind: "graph-write", label: "Disable guest", request: { method: "PATCH", path: "/users/guest-1", body: { accountEnabled: false } } }] } }));
      assert.deepEqual((await f.read()).runs[0]?.riskAssessment, { status: "complete", flags: [] });
    } finally { await f.cleanup(); }
  });
  it("assesses dry-run plans so the preview shows the same flags", async () => {
    const f = await fixture();
    try {
      await f.service.persistRunSnapshot(run({ status: "planned", dryRun: true }));
      const risk = (await f.read()).runs[0]?.riskAssessment;
      assert.equal(risk?.status, "complete");
      if (risk?.status !== "complete") assert.fail("Missing assessment");
      assert.deepEqual(risk.flags.map((flag) => flag.id), ["directory-object-deletion"]);
    } finally { await f.cleanup(); }
  });
});
