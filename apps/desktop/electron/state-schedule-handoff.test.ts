import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentSummary, TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

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
  const store = new AppStateStore({ filePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
  return {
    store,
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
      await f.store.setAgentScheduleEnabled(agent.id, false);
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
      // An agent without a schedule here has nothing to change.
      await f.store.setAgentScheduleEnabled("not-installed", true);
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
});
