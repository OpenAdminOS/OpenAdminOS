import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentSummary, TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { createEnterpriseHost, type EnterpriseIpcRegistrar } from "@openadminos/enterprise";

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
        return true;
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
          setEnabled: (agentId, enabled) => f.store.setAgentScheduleEnabled(agentId, enabled),
          beginMove: (agentId) => f.store.beginScheduleMove(agentId),
          endMove: (agentId) => f.store.endScheduleMove(agentId),
        },
      },
    });
    try {
      const targets = [{ id: "mini-pc", label: "Office mini PC" }];
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
});
