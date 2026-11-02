import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

const scheduledAgent = {
  id: "agent-1",
  slug: "agent-1",
  name: "Agent One",
  description: "Fixture",
  mode: "read",
  category: "devices",
  tier: "agent",
  requiresEntraTier: "free",
  scopes: [],
  author: { name: "OpenAdminOS", verified: true },
  version: "1.0.0",
  installedAt: "2025-01-01T00:00:00.000Z",
  schedule: {
    enabled: true,
    intervalSeconds: 3600,
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnChangeOnly: false,
    lastScheduledRunAt: "2025-01-01T00:00:00.000Z",
  },
};

const realTenant = {
  id: "tenant-real",
  displayName: "Fabrikam",
  username: "admin@fabrikam.example",
  homeAccountId: "home-account-real",
  addedAt: "2025-01-01T00:00:00.000Z",
};

async function makeStore(state: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-schedule-"));
  const filePath = join(dir, "state.json");
  await writeFile(
    filePath,
    `${JSON.stringify({ activeProviderId: "ollama", tenants: [], runs: [], installedAgents: [], ...state }, null, 2)}\n`,
    "utf8",
  );
  const store = new AppStateStore({ filePath, tokenStore, statsApiUrl: "" });
  return {
    store,
    filePath,
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function failedScheduledRun(id: string, tenantId?: string): RunRecord {
  const at = "2026-05-28T17:59:23.252Z";
  return {
    id,
    agentSlug: "agent-1",
    status: "failed",
    queuedAt: at,
    startedAt: at,
    finishedAt: at,
    trigger: "schedule",
    summary: "No tenant connected. Connect a Microsoft 365 tenant before running agents.",
    steps: [],
    logs: [],
    ...(tenantId ? { tenantId } : {}),
  } as RunRecord;
}

describe("agent scheduling", () => {
  it("anchors a newly enabled schedule so it does not fire immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-schedule-"));
    const filePath = join(dir, "state.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        activeProviderId: "ollama",
        tenants: [],
        runs: [],
        installedAgents: [{
          id: "agent-1",
          slug: "agent-1",
          name: "Agent One",
          description: "Fixture",
          mode: "read",
          category: "devices",
          tier: "agent",
          requiresEntraTier: "free",
          scopes: [],
          author: { name: "OpenAdminOS", verified: true },
          version: "1.0.0",
          installedAt: "2025-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );
    const store = new AppStateStore({ filePath, tokenStore, statsApiUrl: "" });
    try {
      const before = Date.now();
      await store.updateAgentSchedule("agent-1", {
        enabled: true,
        intervalSeconds: 3600,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        notifyOnChangeOnly: false,
      });
      const schedule = await store.getAgentSchedule("agent-1");
      const anchor = Date.parse(schedule?.lastScheduledRunAt ?? "");
      assert.ok(anchor >= before && anchor <= Date.now());

      await store.fireDueSchedules();
      assert.equal((await store.getAppState()).runs.length, 0);

      await store.updateAgentSchedule("agent-1", {
        enabled: false,
        intervalSeconds: 3600,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        notifyOnChangeOnly: false,
        lastScheduledRunAt: "2025-01-01T00:00:00.000Z",
      });
      const beforeReenable = Date.now();
      await store.updateAgentSchedule("agent-1", {
        enabled: true,
        intervalSeconds: 3600,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        notifyOnChangeOnly: false,
        lastScheduledRunAt: "2025-01-01T00:00:00.000Z",
      });
      const reenabled = await store.getAgentSchedule("agent-1");
      const reenabledAnchor = Date.parse(reenabled?.lastScheduledRunAt ?? "");
      assert.ok(reenabledAnchor >= beforeReenable && reenabledAnchor <= Date.now());

      await store.fireDueSchedules();
      assert.equal((await store.getAppState()).runs.length, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips due schedules without recording a run while no tenant is active", async () => {
    const fixture = await makeStore({ installedAgents: [scheduledAgent] });
    const originalInfo = console.info;
    const messages: string[] = [];
    console.info = (...values: unknown[]) => messages.push(values.map(String).join(" "));
    let startCalls = 0;
    (fixture.store as unknown as { startRun: () => Promise<never> }).startRun = async () => {
      startCalls += 1;
      throw new Error("No tenant connected. Connect a Microsoft 365 tenant before running agents.");
    };
    try {
      await fixture.store.fireDueSchedules();
      assert.equal(startCalls, 0);
      assert.equal((await fixture.store.getAppState()).runs.length, 0);
      assert.ok(
        messages.some((message) =>
          message.includes("[scheduler] skipped 1 due schedule because no tenant is connected"),
        ),
      );
    } finally {
      console.info = originalInfo;
      await fixture.close();
    }
  });

  it("records the active tenant on a scheduled run that fails to start", async () => {
    const fixture = await makeStore({
      tenants: [realTenant],
      activeTenantId: realTenant.id,
      installedAgents: [scheduledAgent],
    });
    (fixture.store as unknown as { startRun: () => Promise<never> }).startRun = async () => {
      throw new Error("Ollama isn't reachable. Start it with `ollama serve`, then try again.");
    };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await fixture.store.fireDueSchedules();
      const runs = (await fixture.store.getAppState()).runs;
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.status, "failed");
      assert.equal(runs[0]!.trigger, "schedule");
      assert.equal(runs[0]!.tenantId, realTenant.id);
    } finally {
      console.error = originalError;
      await fixture.close();
    }
  });

  it("drops legacy scheduled failures that never recorded a tenant", async () => {
    const manual = { ...failedScheduledRun("run-manual"), trigger: "manual" } as RunRecord;
    const fixture = await makeStore({
      tenants: [realTenant],
      activeTenantId: realTenant.id,
      runs: [
        failedScheduledRun("run-legacy"),
        failedScheduledRun("run-scoped", realTenant.id),
        manual,
      ],
      runDeliveryQueue: [],
    });
    try {
      const runs = (await fixture.store.getAppState()).runs.map((run) => run.id);
      assert.deepEqual(runs, ["run-scoped", "run-manual"]);
      await fixture.store.setActiveTenant(realTenant.id);
      const persisted = JSON.parse(await readFile(fixture.filePath, "utf8")) as { runs: RunRecord[] };
      assert.deepEqual(persisted.runs.map((run) => run.id), ["run-scoped", "run-manual"]);
    } finally {
      await fixture.close();
    }
  });
});
