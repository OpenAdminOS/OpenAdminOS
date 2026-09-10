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

test("Office serializes different personas and purges tenant assignments", async () => {
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
    assert.deepEqual(f.service.state(), { personas: [], missions: [] });
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
