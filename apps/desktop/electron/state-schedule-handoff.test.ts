import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentSummary, TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { createEnterpriseHost, type EnterpriseIpcRegistrar } from "@openadminos/enterprise";

import { SchedulePlacementMemory } from "./schedule-placements.js";
import { AppStateStore, ScheduleMoveInProgressError } from "./state.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };

const tenant = (id: string, displayName: string): TenantRecord => ({
  id,
  displayName,
  username: `admin@${id}.example`,
  homeAccountId: `home-${id}`,
  addedAt: "2026-07-05T00:00:00.000Z",
  lastUsedAt: "2026-07-05T00:00:00.000Z",
  entraTier: "p1",
});

const agent: AgentSummary = {
  id: "find-inactive-devices",
  slug: "find-inactive-devices",
  name: "Find inactive devices",
  description: "Schedule handoff fixture.",
  mode: "read",
  category: "devices",
  tier: "agent",
  requiresEntraTier: "free",
  scopes: [],
  author: { name: "OpenAdminOS", verified: true },
  version: "1.0.0",
  installedAt: "2026-07-05T00:00:00.000Z",
  schedule: {
    organizationId: "org-contoso",
    enabled: true,
    intervalSeconds: 7200,
    notifyOnSuccess: false,
    notifyOnFailure: true,
    notifyOnChangeOnly: true,
    lastScheduledRunAt: "2026-01-01T00:00:00.000Z",
  },
};

async function fixture(activeTenantId: string) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-schedule-handoff-"));
  const filePath = join(dir, "state.json");
  await writeFile(
    filePath,
    JSON.stringify({
      activeProviderId: "ollama",
      installedAgents: [agent],
      runs: [],
      tenants: [tenant("contoso", "Contoso"), tenant("fabrikam", "Fabrikam")],
      organizations: [
        { id: "org-contoso", name: "Contoso", createdAt: "2026-07-05T00:00:00.000Z", connections: { microsoft365: { tenantId: "contoso" } } },
        { id: "org-fabrikam", name: "Fabrikam", createdAt: "2026-07-05T00:00:00.000Z", connections: { microsoft365: { tenantId: "fabrikam" } } },
      ],
      activeTenantId,
    }),
  );
  const changes: string[] = [];
  const store = new AppStateStore({ filePath, tokenStore, userDataPath: dir, statsApiUrl: "", onStateChanged: (info) => changes.push(info.reason) });
  return {
    store,
    changes,
    async schedule() {
      return (await store.listAgents()).find((entry) => entry.id === agent.id)?.schedule;
    },
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("schedule handoff on this computer", () => {
  it("turns the schedule off and back on in place, keeping its organization through a switch", async () => {
    const f = await fixture("contoso");
    try {
      assert.equal(await f.store.hasAgentSchedule(agent.id), true);
      assert.equal(await f.store.setAgentScheduleEnabled(agent.id, false), true);
      // The window hears of it, so the switch shows the real state.
      assert.ok(f.changes.includes("agent-schedule-changed"));
      const off = await f.schedule();
      assert.equal(off?.enabled, false, "turned off, not deleted");
      assert.equal(off?.organizationId, "org-contoso");
      assert.equal(off?.intervalSeconds, 7200);
      assert.equal(off?.notifyOnChangeOnly, true);
      assert.equal(off?.notifyOnSuccess, false);

      // Another organization becomes active before the schedule comes back.
      await f.store.setActiveTenant("fabrikam");
      await f.store.setAgentScheduleEnabled(agent.id, true);
      const on = await f.schedule();
      assert.equal(on?.enabled, true);
      assert.equal(on?.organizationId, "org-contoso", "Contoso's schedule stays Contoso's");
      assert.equal(on?.intervalSeconds, 7200);
      assert.equal(on?.notifyOnChangeOnly, true);
      // An agent without a schedule here has nothing to change, and says so.
      assert.equal(await f.store.setAgentScheduleEnabled("not-installed", true), false);
      assert.equal(await f.store.hasAgentSchedule("not-installed"), false);
      // The same state again writes nothing.
      const before = f.changes.length;
      assert.equal(await f.store.setAgentScheduleEnabled(agent.id, true), true);
      assert.equal(f.changes.length, before, "nothing was written or announced");
    } finally {
      await f.close();
    }
  });

  it("does not run a due schedule that a team features module reports running in another place", async () => {
    const f = await fixture("contoso");
    try {
      const asked: string[] = [];
      f.store.setScheduleRunsElsewhere((agentId) => {
        asked.push(agentId);
        return { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" };
      });
      await f.store.fireDueSchedules();
      assert.deepEqual(asked, [agent.id]);
      assert.deepEqual((await f.store.getAppState()).runs, []);
      assert.equal((await f.schedule())?.lastScheduledRunAt, "2026-01-01T00:00:00.000Z", "not counted as fired");
    } finally {
      await f.close();
    }
  });

  it("refuses deleting the schedule here while a move runs, then completes the move", async () => {
    const f = await fixture("contoso");
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const ipc: EnterpriseIpcRegistrar = { handle: (channel, listener) => handlers.set(channel, listener), removeHandler: (channel) => handlers.delete(channel) };
    const controller = createEnterpriseHost({
      entitlement: () => ({ state: "active", licenseeId: "x", features: [], notBefore: 0, expiresAt: Number.MAX_SAFE_INTEGER, graceEndsAt: Number.MAX_SAFE_INTEGER }),
      ipc,
      storage: { read: async () => undefined, write: async () => undefined },
      log: () => undefined,
      capabilities: {
        localSchedules: {
          has: (agentId) => f.store.hasAgentSchedule(agentId),
          organizationOf: (agentId) => f.store.agentScheduleOrganization(agentId),
          setEnabled: (agentId, enabled) => f.store.setAgentScheduleEnabled(agentId, enabled),
          beginMove: (agentId) => f.store.beginScheduleMove(agentId),
          endMove: (agentId) => f.store.endScheduleMove(agentId),
        },
      },
    });
    try {
      const targets = [{ id: "mini-pc", label: "Office mini PC", organizationId: "org-contoso" }];
      let release!: () => void;
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => (release = resolve));
      const atHandler = new Promise<void>((resolve) => (reached = resolve));
      controller.host.registerUiAction("sandboxes.schedule", async (input) => {
        reached();
        await paused;
        if (input.kind === "schedule") controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets, current: { [input.agentId]: input.targetId } });
        return { notice: { type: "notice", tone: "success", title: "Moved", message: "The schedule moved." } };
      });
      controller.host.setScheduleTargets({ action: "sandboxes.schedule", targets });
      const move = handlers.get("openadminos-enterprise-ui:sandboxes.schedule")!({ kind: "schedule", agentId: agent.id, targetId: "mini-pc", intervalSeconds: 7200 });
      await atHandler;
      // The switch turned off by deleting the schedule, while the module is moving it: refused.
      await assert.rejects(f.store.updateAgentSchedule(agent.slug, null), (error: unknown) => error instanceof ScheduleMoveInProgressError);
      release();
      const reply = (await move) as { notice: { title: string } };
      assert.equal(reply.notice.title, "Moved");
      const after = await f.schedule();
      assert.equal(after?.enabled, false, "turned off in place by the move");
      assert.equal(after?.organizationId, "org-contoso");
      // Once the move ended, deleting is allowed again.
      await f.store.updateAgentSchedule(agent.slug, null);
      assert.equal(await f.schedule(), undefined);
    } finally {
      controller.dispose();
      await f.close();
    }
  });

  it("reads the organization of a schedule here, and keeps it while a module place runs it", async () => {
    const f = await fixture("contoso");
    try {
      assert.equal(await f.store.agentScheduleOrganization(agent.id), "org-contoso");
      assert.equal(await f.store.agentScheduleOrganization("not-installed"), undefined);
      const runs = { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" as const };
      f.store.setScheduleRunsElsewhere(() => runs);
      await assert.rejects(f.store.assignAgentSchedule(agent.slug, "org-fabrikam"), /runs on Office mini PC, which is paired for its organization\. Bring it back here first, then assign it\./);
      // The reason and the step follow the kind of placement.
      f.store.setScheduleRunsElsewhere(() => ({ ...runs, reason: "configuration" }));
      await assert.rejects(f.store.assignAgentSchedule(agent.slug, "org-fabrikam"), /also runs Find inactive devices from its own configuration\. Remove it there first/);
      f.store.setScheduleRunsElsewhere(() => ({ ...runs, reason: "uncertain" }));
      await assert.rejects(f.store.assignAgentSchedule(agent.slug, "org-fabrikam"), /not certain whether Office mini PC runs/);
      assert.equal((await f.schedule())?.organizationId, "org-contoso");
      // While a move runs, assigning waits too.
      f.store.setScheduleRunsElsewhere(undefined);
      f.store.beginScheduleMove(agent.id);
      await assert.rejects(f.store.assignAgentSchedule(agent.slug, "org-fabrikam"), (error: unknown) => error instanceof ScheduleMoveInProgressError);
      f.store.endScheduleMove(agent.id);

      // No schedule here, a Contoso place runs it, Fabrikam active: a new schedule here is refused.
      await f.store.updateAgentSchedule(agent.slug, null);
      await f.store.setActiveTenant("fabrikam");
      f.store.setScheduleRunsElsewhere(() => runs);
      await assert.rejects(f.store.updateAgentSchedule(agent.slug, { enabled: true, intervalSeconds: 3600 }), /Bring it back here first, then schedule it here under another organization/);
      assert.equal(await f.schedule(), undefined);
      // Under Contoso it can be made.
      await f.store.setActiveTenant("contoso");
      await f.store.updateAgentSchedule(agent.slug, { enabled: true, intervalSeconds: 3600 });
      assert.equal((await f.schedule())?.organizationId, "org-contoso");
    } finally {
      await f.close();
    }
  });

  const contosoPc = { targetId: "mini-pc", label: "Office mini PC", organizationId: "org-contoso", reason: "runs" as const };

  it("holds a schedule after a crash between the start of a move and its outcome, with no module and the licence off", async () => {
    const f = await fixture("contoso");
    const dir = await mkdtemp(join(tmpdir(), "openadminos-placements-"));
    try {
      const path = join(dir, "placements.json");
      // The move away was recorded before the module was asked; then the app stopped.
      new SchedulePlacementMemory(path).begin(agent.id, { ...contosoPc, reason: "uncertain" });

      // Restart: no module report, team features off.
      const memory = new SchedulePlacementMemory(path);
      f.store.setScheduleRunsElsewhere((agentId) => {
        const placement = memory.placementFor(agentId);
        return placement ? { ...placement, teamFeaturesOff: true } : undefined;
      });
      await f.store.fireDueSchedules();
      assert.deepEqual((await f.store.getAppState()).runs, [], "the agent is skipped");
      assert.equal(memory.view().placements[agent.id]?.label, "Office mini PC", "the card can say where it was last known to run");
      // With team features off, the step is Run it here.
      await assert.rejects(f.store.assignAgentSchedule(agent.slug, "org-fabrikam"), /Choose Run it here on the schedule card first/);
      memory.clear(agent.id);
      assert.equal(new SchedulePlacementMemory(path).placementFor(agent.id), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await f.close();
    }
  });

  it("loosens a kept placement only when the module reports it here for a place it still offers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-placements-"));
    try {
      const memory = new SchedulePlacementMemory(join(dir, "placements.json"));
      memory.publish({ placements: { [agent.id]: contosoPc }, offered: ["mini-pc"], here: [] });
      // A report that leaves the agent out is a gap: kept.
      memory.publish({ placements: {}, offered: ["mini-pc"], here: [] });
      assert.equal(memory.placementFor(agent.id)?.targetId, "mini-pc");
      // The place is no longer offered (unpaired): kept, and shown as no longer paired here.
      memory.publish({ placements: {}, offered: [], here: [agent.id] });
      assert.equal(memory.placementFor(agent.id)?.targetId, "mini-pc");
      assert.equal(memory.view().placements[agent.id]?.stale, true);
      // Reported here for a place it still offers: removed.
      memory.publish({ placements: {}, offered: ["mini-pc"], here: [agent.id] });
      assert.equal(memory.placementFor(agent.id), undefined);
      // Settled outcomes: a move away replaces the not certain one; unknown keeps it; here removes it.
      memory.begin(agent.id, { ...contosoPc, reason: "uncertain" });
      memory.settle(agent.id, "unknown");
      assert.equal(memory.placementFor(agent.id)?.reason, "uncertain");
      memory.settle(agent.id, contosoPc);
      assert.equal(memory.placementFor(agent.id)?.reason, "runs");
      memory.settle(agent.id, "here");
      assert.equal(memory.placementFor(agent.id), undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses the last good copy of a damaged file, and holds every schedule when neither can be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-placements-"));
    try {
      const path = join(dir, "placements.json");
      new SchedulePlacementMemory(path).publish({ placements: { [agent.id]: contosoPc }, offered: ["mini-pc"], here: [] });
      await writeFile(path, "{ not json");
      const logs: string[] = [];
      const fromBackup = new SchedulePlacementMemory(path, (message) => logs.push(message));
      assert.equal(fromBackup.placementFor(agent.id)?.label, "Office mini PC");
      assert.ok(logs.some((message) => message.includes("last good copy")));

      await writeFile(path, "{ not json");
      await writeFile(`${path}.bak`, "{ not json either");
      const held = new SchedulePlacementMemory(path, (message) => logs.push(message));
      assert.ok(held.placementFor("any-agent"), "fails closed for every agent");
      assert.equal(held.view().problem?.kind, "unreadable");
      assert.match(held.view().problem?.message ?? "", /cannot read where schedules last ran/);
      assert.deepEqual(held.view().held, { released: [] });

      // No module report ends the hold, empty or not.
      held.publish({ placements: {}, offered: [], here: [] });
      held.publish({ placements: {}, offered: ["mini-pc"], here: [] });
      assert.ok(held.placementFor("any-agent"), "an empty report keeps every agent held");
      assert.ok(held.placementFor("another-agent"));
      // The damaged files are kept aside, not overwritten.
      assert.equal(await readFile(`${path}.damaged`, "utf8"), "{ not json");
      assert.equal(await readFile(`${path}.bak.damaged`, "utf8"), "{ not json either");

      // Run it here releases that one agent only.
      held.clear("any-agent");
      assert.equal(held.placementFor("any-agent"), undefined);
      assert.ok(held.placementFor("another-agent"));
      assert.deepEqual(held.view().held, { released: ["any-agent"] });

      // A restart keeps every other agent held.
      const restarted = new SchedulePlacementMemory(path, (message) => logs.push(message));
      assert.equal(restarted.placementFor("any-agent"), undefined);
      assert.ok(restarted.placementFor("another-agent"), "a restart keeps the others held");
      assert.equal(restarted.view().problem?.kind, "unreadable");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("releases a held agent only when the module reports it here", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-placements-"));
    try {
      const path = join(dir, "placements.json");
      await writeFile(path, "{ not json");
      const held = new SchedulePlacementMemory(path, () => undefined);
      // Left out of the report is not here: still held.
      held.publish({ placements: {}, offered: ["mini-pc"], here: ["reported-here"] });
      assert.equal(held.placementFor("reported-here"), undefined);
      assert.ok(held.placementFor("left-out"));
      // A place the module names is kept as that place, and stays after the module stops naming it.
      held.publish({ placements: { named: contosoPc }, offered: ["mini-pc"], here: [] });
      held.publish({ placements: {}, offered: ["mini-pc"], here: [] });
      assert.equal(held.placementFor("named")?.targetId, "mini-pc");
      assert.deepEqual(new SchedulePlacementMemory(path, () => undefined).view().held, { released: ["reported-here"] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses to start a move it cannot keep on disk, and says so on the card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-placements-"));
    try {
      // The data folder is a file, so nothing can be written under it.
      const blocked = join(dir, "blocked");
      await writeFile(blocked, "x");
      const memory = new SchedulePlacementMemory(join(blocked, "placements.json"), () => undefined);
      assert.throws(() => memory.begin(agent.id, { ...contosoPc, reason: "uncertain" }));
      assert.equal(memory.view().problem?.kind, "unwritable");
      assert.match(memory.view().problem?.message ?? "", /could not save where schedules last ran/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
