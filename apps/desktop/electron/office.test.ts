import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { OfficePersonaInput, RunRecord } from "@openadminos/agent-sdk";
import { OfficeService, type OfficeHost } from "./office.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "office-test-"));
  let now = Date.parse("2026-09-10T10:00:00Z");
  const context: Awaited<ReturnType<OfficeHost["context"]>> = {
    tenants: [
      {
        id: "tenant-a",
        displayName: "Test tenant",
        homeAccountId: "test",
        username: "test@example.invalid",
        addedAt: new Date(now).toISOString(),
      },
    ],
    providers: [
      {
        id: "ollama",
        name: "Local test",
        description: "Test",
        isLocal: true,
        status: "connected",
        models: ["test"],
      },
    ],
    agents: ["one", "two"].map((slug) => ({
      id: slug,
      slug,
      name: slug,
      description: "Test",
      category: "devices",
      mode: "read",
      tier: "agent",
      requiresEntraTier: "free",
      version: "1.0.0",
      scopes: [],
      author: { name: "Test", verified: false },
      installedAt: new Date(now).toISOString(),
    })),
    runs: [],
    providerConfigKey: "original",
  };
  const calls: string[] = [];
  const host: OfficeHost = {
    context: async () => context,
    startRun: async (slug, opts) => {
      calls.push(slug);
      const r: RunRecord = {
        id: `run-${calls.length}`,
        agentSlug: slug,
        status: "running",
        queuedAt: new Date(now).toISOString(),
        steps: [],
        logs: [],
        tenantId: opts.tenantId,
        providerId: opts.providerId,
        office: opts.office,
        officeContext: opts.officeContext,
      };
      context.runs.unshift(r);
      return r;
    },
    cancelRun: async (id) => {
      const r = context.runs.find((r) => r.id === id)!;
      r.status = "cancelled";
      return r;
    },
    changed() {},
  };
  let service = new OfficeService(join(dir, "office.db"), host, () => now);
  const input: OfficePersonaInput = {
    name: "Chief of Staff",
    responsibility: "Coordinate test checks",
    avatar: "robot",
    color: "amber",
    tenantId: "tenant-a",
    providerId: "ollama",
    agentSlugs: ["one", "two"],
    intervalMinutes: 5,
    maxMinutes: 30,
    enabled: true,
  };
  return {
    get service() {
      return service;
    },
    input,
    context,
    calls,
    host,
    advance(ms: number) {
      now += ms;
    },
    restart() {
      service.close();
      service = new OfficeService(join(dir, "office.db"), host, () => now);
    },
    async close() {
      service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test("Office runs ordered, tenant-pinned work and waits for human approval", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save(f.input);
    assert.equal(p.nextRunAt, "2026-09-10T10:05:00.000Z");
    await f.service.tick();
    assert.equal(f.calls.length, 0);
    await f.service.start(p.id);
    assert.deepEqual(f.calls, ["one"]);
    assert.equal(f.context.runs[0].tenantId, "tenant-a");
    f.context.runs[0].status = "awaiting-confirmation";
    await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
    assert.deepEqual(f.calls, ["one"]);
    await assert.rejects(f.service.start(p.id), /already has/);
    await assert.rejects(
      f.service.save({ ...f.input, id: p.id }),
      /Stop the current/,
    );
    f.context.runs[0].status = "completed";
    await f.service.tick();
    assert.deepEqual(f.calls, ["one", "two"]);
    f.context.runs[0].status = "completed";
    await f.service.tick();
    assert.equal(f.service.state().missions[0].status, "completed");
  } finally {
    await f.close();
  }
});

test("handoff budgets count UTF-8 bytes and preserve source references when omitting oversized evidence", async () => {
  const f = await fixture();
  try {
    const { personas: [p] } = await f.service.save(f.input);
    await f.service.start(p.id);
    const source = f.context.runs[0];
    Object.assign(source, {
      status: "completed",
      result: { report: "証".repeat(15000) },
      summary: "証".repeat(2000),
    });
    await f.service.tick();
    assert.deepEqual(f.calls, ["one", "two"]);
    const context = f.context.runs[0].officeContext!;
    assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= 36000);
    assert.equal(context.evidence[0].runId, source.id);
    assert.equal(context.evidence[0].result, undefined);
    assert.match(context.evidence[0].summary, /Result omitted/);
    assert.equal((source.result as { report: string }).report.length, 15000);
  } finally {
    await f.close();
  }
});

test("Office resumes persisted coordination without replaying a queued child", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save(f.input);
    await f.service.start(p.id);
    f.restart();
    await f.service.tick();
    assert.deepEqual(f.calls, ["one"]);
    f.context.runs[0].status = "completed";
    await f.service.tick();
    assert.deepEqual(f.calls, ["one", "two"]);
  } finally {
    await f.close();
  }
});

test("failure pauses schedules and does not execute subsequent tasks", async () => {
  const f = await fixture();
  try {
    await f.service.save(f.input);
    f.advance(300000);
    await f.service.tick();
    f.context.runs[0].status = "failed";
    f.context.runs[0].error = "Access expired. Reconnect the tenant.";
    await f.service.tick();
    f.advance(300000);
    await f.service.tick();
    assert.deepEqual(f.calls, ["one"]);
    assert.equal(f.service.state().personas[0].enabled, false);
    assert.match(f.service.state().missions[0].error!, /Access expired/);
  } finally {
    await f.close();
  }
});

test("time budget cancels work, stop pauses recurrence, and removal preserves child history", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save({ ...f.input, maxMinutes: 5 });
    await f.service.start(p.id);
    f.advance(300001);
    await f.service.tick();
    assert.equal(f.context.runs[0].status, "cancelled");
    assert.match(f.service.state().missions[0].error!, /time budget/);
    await f.service.save({ ...f.input, id: p.id });
    await f.service.start(p.id);
    await f.service.stop(p.id);
    f.advance(600000);
    await f.service.tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.service.state().personas[0].enabled, false);
    await f.service.remove(p.id);
    assert.equal(f.service.state().personas.length, 0);
    assert.equal(f.context.runs.length, 2);
  } finally {
    await f.close();
  }
});

test("host validates consent, tenant, workflow changes, and unsafe input", async () => {
  const f = await fixture();
  try {
    f.context.providers[0].isLocal = false;
    await assert.rejects(
      f.service.save(f.input),
      /Confirm that tenant context/,
    );
    const {
      personas: [p],
    } = await f.service.save({ ...f.input, confirmHosted: true });
    assert.equal("trustKey" in p, false);
    f.context.providerConfigKey = "new destination";
    await assert.rejects(
      f.service.start(p.id),
      /provider or assigned workflows changed/,
    );
    await assert.rejects(
      f.service.save({ ...f.input, confirmHosted: true, tenantId: "missing" }),
      /tenant is disconnected/,
    );
    for (const input of [
      { intervalMinutes: 0 },
      { maxMinutes: Infinity },
      { agentSlugs: [] },
      { agentSlugs: ["one", "one"] },
      { avatar: "invalid" },
      { enabled: "true" },
      { name: "" },
    ]) {
      await assert.rejects(
        f.service.save({ ...f.input, ...input, confirmHosted: true }),
      );
    }
  } finally {
    await f.close();
  }
});

test("Office serializes different teammates and purges tenant assignments", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save(f.input);
    const {
      personas: [, q],
    } = await f.service.save({ ...f.input, name: "Second" });
    await Promise.all([f.service.start(p.id), f.service.start(q.id)]);
    assert.deepEqual(f.calls, ["one"]);
    await f.service.purgeTenant("tenant-a");
    assert.equal(f.context.runs[0].status, "cancelled");
    assert.deepEqual(f.service.state(), {
      personas: [],
      missions: [],
      findings: [],
      handoffs: [],
      messages: [],
    });
  } finally {
    await f.close();
  }
});

test("missing retained evidence stops coordination instead of replaying a task", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save(f.input);
    await f.service.start(p.id);
    f.context.runs = [];
    await f.service.tick();
    assert.equal(f.calls.length, 1);
    assert.equal(f.service.state().missions[0].status, "failed");
  } finally {
    await f.close();
  }
});

test("queue and review time do not consume execution budget or block an independent teammate", async () => {
  const f = await fixture();
  try {
    const {
      personas: [a],
    } = await f.service.save({ ...f.input, intervalMinutes: null });
    const {
      personas: [, b],
    } = await f.service.save({
      ...f.input,
      name: "Second",
      maxMinutes: 5,
      intervalMinutes: null,
    });
    await f.service.start(a.id);
    await f.service.start(b.id);
    f.advance(600000);
    f.context.runs[0].status = "awaiting-confirmation";
    await f.service.tick();
    assert.equal(f.calls.length, 2);
    assert.equal(
      f.service.state().missions.find((m) => m.personaId === a.id)?.status,
      "awaiting-review",
    );
    assert.equal(
      f.service.state().missions.find((m) => m.personaId === b.id)?.status,
      "executing",
    );
    assert.equal(
      f.service.state().missions.find((m) => m.personaId === b.id)?.executionMs,
      0,
    );
    f.restart();
    await f.service.tick();
    assert.equal(f.calls.length, 2);
  } finally {
    await f.close();
  }
});

test("approval expires independently and rejects changed workflow consent", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save({ ...f.input, approvalMinutes: 10 });
    await f.service.start(p.id);
    const run = f.context.runs[0];
    run.status = "awaiting-confirmation";
    await f.service.tick();
    await f.service.validateApproval(run);
    f.context.providerConfigKey = "changed";
    await assert.rejects(f.service.validateApproval(run), /changed/);
    f.advance(600001);
    await f.service.tick();
    assert.equal(run.status, "cancelled");
    assert.match(f.service.state().missions[0].error!, /Approval expired/);
  } finally {
    await f.close();
  }
});

test("unrelated provider edits and offline cosmetic edits preserve the assignment", async () => {
  const f = await fixture();
  try {
    f.context.providerConfigKeys = { ollama: "local", openai: "remote" };
    const {
      personas: [p],
    } = await f.service.save(f.input);
    f.context.providerConfigKeys.openai = "changed";
    f.context.providers[0].status = "unavailable" as never;
    await f.service.save({ ...p, name: "Renamed" });
    assert.equal(f.service.state().personas[0].nextRunAt, p.nextRunAt);
    f.context.providers[0].status = "connected";
    await f.service.start(p.id);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});

test("changed evidence hands off once, carries previous/current sources, and survives restart", async () => {
  const f = await fixture();
  try {
    const {
      personas: [source],
    } = await f.service.save({
      ...f.input,
      agentSlugs: ["one"],
      intervalMinutes: null,
      assessment: { metricPath: "counts.noncompliant", threshold: 1 },
    });
    const {
      personas: [, target],
    } = await f.service.save({
      ...f.input,
      name: "Research",
      agentSlugs: ["two"],
      intervalMinutes: null,
      watch: { personaId: source.id, event: "changed", cooldownMinutes: 5 },
    });
    const finish = async (n: number) => {
      await f.service.start(source.id);
      Object.assign(f.context.runs[0], {
        status: "completed",
        result: {
          counts: { noncompliant: n },
          llmSummary: `Different prose ${f.calls.length}`,
        },
      });
      await f.service.tick();
    };
    await finish(1);
    assert.equal(f.service.state().handoffs?.length, 0);
    await finish(1);
    assert.equal(f.service.state().findings?.[0].revision, 1);
    await finish(2);
    assert.equal(f.service.state().handoffs?.length, 1);
    const handoff = f.service.state().handoffs![0];
    assert.equal(handoff.sourceRunIds.length, 2);
    f.restart();
    await f.service.tick();
    await f.service.tick();
    const run = f.context.runs[0];
    assert.equal(run.office?.personaId, target.id);
    assert.equal(
      run.officeContext?.evidence[0].result &&
        (run.officeContext.evidence[0].result as any).counts.noncompliant,
      2,
    );
    assert.equal(
      run.officeContext?.evidence[1].result &&
        (run.officeContext.evidence[1].result as any).counts.noncompliant,
      1,
    );
    assert.equal(f.calls.filter((c) => c === "two").length, 1);
    assert.equal(f.service.state().handoffs?.length, 1);
    Object.assign(run, {
      status: "completed",
      result: { report: "Investigation with source references" },
    });
    await f.service.tick();
    const finding = f.service
      .state()
      .findings!.find((f) => f.personaId === target.id)!;
    assert.ok(finding);
    assert.match(finding.coverage, /source workflow/);
  } finally {
    await f.close();
  }
});

test("finding review lifecycle preserves snooze, reopens a recurrence and purges tenant memory", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save({
      ...f.input,
      agentSlugs: ["one"],
      intervalMinutes: null,
    });
    const finish = async (n: number) => {
      await f.service.start(p.id);
      Object.assign(f.context.runs[0], {
        status: "completed",
        result: { count: n },
      });
      await f.service.tick();
    };
    await finish(1);
    let finding = f.service.state().findings![0];
    await f.service.reviewFinding({ id: finding.id, state: "acknowledged" });
    await finish(1);
    assert.equal(f.service.state().findings![0].state, "acknowledged");
    await f.service.reviewFinding({
      id: finding.id,
      state: "snoozed",
      snoozeMinutes: 5,
    });
    await finish(2);
    assert.equal(f.service.state().findings![0].state, "snoozed");
    f.advance(300001);
    await f.service.tick();
    assert.equal(f.service.state().findings![0].state, "open");
    await f.service.reviewFinding({ id: finding.id, state: "resolved" });
    await finish(2);
    assert.equal(f.service.state().findings![0].state, "resolved");
    await finish(3);
    finding = f.service.state().findings![0];
    assert.equal(finding.state, "open");
    assert.equal(finding.revision, 3);
    assert.equal(finding.runIds.length, 5);
    await f.service.purgeTenant(p.tenantId);
    assert.equal(f.service.state().findings!.length, 0);
  } finally {
    await f.close();
  }
});

test("watchers reject cross-tenant/cyclic dependencies and threshold watches require a crossing", async () => {
  const f = await fixture();
  try {
    f.context.tenants.push({ ...f.context.tenants[0], id: "tenant-b" });
    const {
      personas: [a],
    } = await f.service.save({
      ...f.input,
      agentSlugs: ["one"],
      intervalMinutes: null,
      assessment: { metricPath: "count", threshold: 1 },
    });
    await assert.rejects(
      f.service.save({
        ...f.input,
        tenantId: "tenant-b",
        watch: { personaId: a.id, event: "new", cooldownMinutes: 5 },
      }),
      /same tenant/,
    );
    const {
      personas: [, b],
    } = await f.service.save({
      ...f.input,
      name: "Threshold",
      agentSlugs: ["two"],
      intervalMinutes: null,
      watch: {
        personaId: a.id,
        event: "threshold",
        threshold: 3,
        cooldownMinutes: 5,
      },
    });
    await assert.rejects(
      f.service.save({
        ...a,
        watch: { personaId: b.id, event: "new", cooldownMinutes: 5 },
      }),
      /acyclic/,
    );
    const finish = async (n: number) => {
      await f.service.start(a.id);
      Object.assign(f.context.runs[0], {
        status: "completed",
        result: { count: n },
      });
      await f.service.tick();
    };
    await finish(2);
    assert.equal(f.service.state().handoffs!.length, 0);
    await finish(3);
    assert.equal(f.service.state().handoffs!.length, 1);
    await f.service.tick();
    f.context.runs[0].status = "completed";
    await f.service.tick();
    f.advance(300001);
    await finish(4);
    assert.equal(f.service.state().handoffs!.length, 1);
    await finish(1);
    await finish(3);
    assert.equal(f.service.state().handoffs!.length, 2);
  } finally {
    await f.close();
  }
});

test("Chief planner accepts only assigned subsets and visibly falls back from invented tools", async () => {
  const f = await fixture();
  try {
    let answer = JSON.stringify({
      agentSlugs: ["two"],
      reason: "The first assessment already collected evidence.",
    });
    f.host.complete = async () => answer;
    const {
      personas: [a],
    } = await f.service.save({
      ...f.input,
      agentSlugs: ["one"],
      intervalMinutes: null,
    });
    const {
      personas: [, b],
    } = await f.service.save({
      ...f.input,
      intervalMinutes: null,
      planning: "model",
      watch: { personaId: a.id, event: "changed", cooldownMinutes: 5 },
    });
    const finish = async (n: number) => {
      await f.service.start(a.id);
      Object.assign(f.context.runs[0], {
        status: "completed",
        result: { count: n },
      });
      await f.service.tick();
    };
    await finish(1);
    await finish(2);
    let m = f.service.state().missions.find((m) => m.personaId === b.id)!;
    assert.deepEqual(m.agentSlugs, ["two"]);
    assert.deepEqual(m.skippedAgentSlugs, ["one"]);
    await f.service.tick();
    f.context.runs[0].status = "completed";
    await f.service.tick();
    f.advance(300001);
    answer = JSON.stringify({
      agentSlugs: ["delete-tenant"],
      reason: "Not allowed",
    });
    await finish(3);
    m = f.service.state().missions.find((m) => m.personaId === b.id)!;
    assert.deepEqual(m.agentSlugs, ["one", "two"]);
    assert.match(m.planningReason!, /invalid.*approved ordered/);
  } finally {
    await f.close();
  }
});

test("teammate questions remain evidence-scoped without blocking schedules or editing instructions", async () => {
  const f = await fixture();
  try {
    const {
      personas: [a],
    } = await f.service.save({
      ...f.input,
      agentSlugs: ["one"],
      intervalMinutes: null,
      instructions: "Explain evidence gaps.",
    });
    await f.service.start(a.id);
    f.context.runs[0].status = "completed";
    await f.service.tick();
    let finish!: (text: string) => void;
    let context: any;
    f.host.complete = async (p, _q, c) => {
      assert.equal(p.tenantId, "tenant-a");
      context = c;
      return new Promise((resolve) => (finish = resolve));
    };
    const answer = f.service.ask({ id: a.id, question: "Why?" });
    await new Promise((resolve) => setImmediate(resolve));
    await f.service.tick(); // would deadlock if ask held the Office serial lock
    assert.equal(context.evidence.length, 1);
    assert.equal(context.evidence[0].runId, "run-1");
    finish("Source run-1. Collection coverage is limited.");
    await answer;
    assert.equal(f.service.state().messages!.length, 2);
    assert.equal(
      f.service.state().personas[0].instructions,
      "Explain evidence gaps.",
    );
    f.host.complete = async (_p, _q, c) => {
      assert.equal(c.conversation?.length, 2);
      return "No settings changed.";
    };
    await f.service.ask({ id: a.id, question: "What changed?" });
    assert.equal(f.service.state().messages!.length, 4);
  } finally {
    await f.close();
  }
});

test("watch quiet hours defer a fresh event and transient readiness retries are bounded", async () => {
  const f = await fixture();
  try {
    const {
      personas: [a],
    } = await f.service.save({
      ...f.input,
      agentSlugs: ["one"],
      intervalMinutes: null,
    });
    const {
      personas: [, b],
    } = await f.service.save({
      ...f.input,
      agentSlugs: ["two"],
      intervalMinutes: null,
      quietHours: { start: 10, end: 11, timeZone: "UTC" },
      watch: { personaId: a.id, event: "new", cooldownMinutes: 5 },
    });
    await f.service.start(a.id);
    f.context.runs[0].status = "completed";
    await f.service.tick();
    assert.equal(f.service.state().handoffs!.length, 0);
    f.advance(3600000);
    await f.service.tick();
    assert.equal(f.service.state().handoffs!.length, 1);
    await f.service.stop(b.id);
    const {
      personas: [, , c],
    } = await f.service.save({
      ...f.input,
      name: "Retry",
      agentSlugs: ["one"],
      intervalMinutes: 5,
    });
    f.context.providers[0].status = "unavailable" as never;
    for (let i = 0; i < 4; i++) {
      f.advance(600000);
      await f.service.tick();
    }
    const paused = f.service.state().personas.find((p) => p.id === c.id)!;
    assert.equal(paused.enabled, false);
    assert.match(paused.lastError!, /provider is unavailable/);
  } finally {
    await f.close();
  }
});

test("saving an unchanged work order renews its review after an assigned provider change", async () => {
  const f = await fixture();
  try {
    const {
      personas: [p],
    } = await f.service.save(f.input);
    f.context.providerConfigKey = "new provider destination";
    await assert.rejects(
      f.service.start(p.id),
      /assigned provider destination/,
    );
    await f.service.save(p);
    await f.service.start(p.id);
    assert.equal(f.calls.length, 1);
  } finally {
    await f.close();
  }
});
