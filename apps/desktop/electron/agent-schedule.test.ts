import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { providerCatalog, type ProviderSummary, type RunRecord } from "@openadminos/agent-sdk";
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

async function makeStore(state: Record<string, unknown>, providers?: ProviderSummary[]) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-schedule-"));
  const filePath = join(dir, "state.json");
  await writeFile(
    filePath,
    `${JSON.stringify({ activeProviderId: "ollama", tenants: [], runs: [], installedAgents: [], ...state }, null, 2)}\n`,
    "utf8",
  );
  const store = new AppStateStore({ filePath, tokenStore, statsApiUrl: "", appVersion: "0.7.2", ...(providers ? { providerListFactory: () => providers } : {}) });
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

  it("migrates an enabled schedule, skips a newly cloud-backed alias, and waits for review", async () => {
    const model = "writer:latest";
    const provider: ProviderSummary = {
      ...providerCatalog.find((entry) => entry.id === "ollama")!,
      status: "connected", models: [model], defaultModel: model,
    };
    const pausedAgent = { ...scheduledAgent, slug: "paused-agent", schedule: { ...scheduledAgent.schedule, enabled: false } };
    let cloud = false;
    let chatCalls = 0;
    const server = createServer((request, response) => {
      if (request.url === "/api/chat") chatCalls++;
      response.end(JSON.stringify({ models: [{ name: model, ...(cloud ? { remote_model: "hosted-writer" } : {}) }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const previous = process.env.OPENAGENTS_OLLAMA_URL;
    process.env.OPENAGENTS_OLLAMA_URL = `http://127.0.0.1:${address.port}`;
    const fixture = await makeStore({
      tenants: [realTenant], activeTenantId: realTenant.id, installedAgents: [scheduledAgent, pausedAgent],
    }, [provider]);
    try {
      await fixture.store.getAppState();
      const migrated = await fixture.store.getAgentSchedule(scheduledAgent.slug);
      assert.equal(migrated?.modelDestination?.providerId, "ollama");
      assert.equal(migrated?.modelDestination?.model, model);
      assert.equal(migrated?.modelDestination?.ollamaCloud, false);
      assert.equal(migrated?.lastScheduledRunAt, scheduledAgent.schedule.lastScheduledRunAt);
      assert.equal(migrated?.lastSkipReason, undefined);
      assert.equal((await fixture.store.getAgentSchedule(pausedAgent.slug))?.enabled, false);

      cloud = true;
      await fixture.store.fireDueSchedules();
      await fixture.store.fireDueSchedules();
      const state = await fixture.store.getAppState();
      const reason = `Skipped: ${model} now runs on ollama.com. Review the schedule to continue.`;
      assert.equal(state.runs.length, 1);
      assert.equal(state.runs[0]?.summary, reason);
      assert.equal(state.installedAgents[0]?.schedule?.lastSkipReason, reason);
      assert.equal(chatCalls, 0);

      await assert.rejects(
        fixture.store.updateAgentSchedule(scheduledAgent.slug, { ...scheduledAgent.schedule, reviewModelDestination: true }),
        /Refresh Ollama in Settings, Providers/,
      );
      assert.equal((await fixture.store.getAgentSchedule(scheduledAgent.slug))?.lastSkipReason, reason);

      provider.remoteModels = [model];
      await fixture.store.updateAgentSchedule(scheduledAgent.slug, { ...scheduledAgent.schedule, reviewModelDestination: true });
      const reviewed = await fixture.store.getAgentSchedule(scheduledAgent.slug);
      assert.equal(reviewed?.modelDestination?.ollamaCloud, true);
      assert.equal(reviewed?.lastSkipReason, undefined);
      assert.ok(Date.parse(reviewed?.lastScheduledRunAt ?? "") > Date.parse(scheduledAgent.schedule.lastScheduledRunAt));
    } finally {
      if (previous === undefined) delete process.env.OPENAGENTS_OLLAMA_URL;
      else process.env.OPENAGENTS_OLLAMA_URL = previous;
      await fixture.close();
      server.close();
    }
  });

  for (const [label, destination] of [
    ["Ollama Cloud alias", { id: "ollama", model: "writer:latest", isLocal: true, remoteModels: ["writer:latest"] }],
    ["off-device Ollama server", { id: "ollama", model: "writer:latest", isLocal: false }],
    ["hosted provider", { id: "openai", model: "gpt-5", isLocal: false }],
  ] as const) {
    it(`pauses a legacy schedule using a ${label} until the destination is reviewed`, async (t) => {
      const provider: ProviderSummary = {
        ...providerCatalog.find((entry) => entry.id === destination.id)!,
        status: "connected",
        models: [destination.model],
        defaultModel: destination.model,
        isLocal: destination.isLocal,
        ...("remoteModels" in destination ? { remoteModels: [...destination.remoteModels] } : {}),
      };
      const fixture = await makeStore({
        activeProviderId: provider.id, tenants: [realTenant], activeTenantId: realTenant.id, installedAgents: [scheduledAgent],
      }, [provider]);
      const start = t.mock.method(fixture.store, "startRun", async () => undefined);
      try {
        // The background scheduler can be the first caller after upgrade.
        await fixture.store.fireDueSchedules();
        const schedule = (await fixture.store.getAppState()).installedAgents[0]?.schedule;
        assert.equal(start.mock.callCount(), 0);
        assert.equal(schedule?.enabled, true);
        assert.equal(schedule?.modelDestination?.providerId, provider.id);
        assert.equal(schedule?.modelDestination?.model, destination.model);
        assert.match(schedule?.lastSkipReason ?? "", /Review the schedule to continue/);
        if (provider.remoteModels) assert.match(schedule?.lastSkipReason ?? "", /ollama\.com/);

        await fixture.store.updateAgentSchedule(scheduledAgent.slug, { ...scheduledAgent.schedule, reviewModelDestination: true });
        assert.equal((await fixture.store.getAgentSchedule(scheduledAgent.slug))?.lastSkipReason, undefined);
        await fixture.store.fireDueSchedules();
        assert.equal(start.mock.callCount(), 0, "review starts a fresh interval");
      } finally {
        await fixture.close();
      }
    });
  }

  it("keeps a due legacy schedule running on an on-device model", async (t) => {
    const provider: ProviderSummary = {
      ...providerCatalog.find((entry) => entry.id === "ollama")!,
      status: "connected", models: ["writer:latest"], defaultModel: "writer:latest",
    };
    const fixture = await makeStore({
      tenants: [realTenant], activeTenantId: realTenant.id, installedAgents: [scheduledAgent],
    }, [provider]);
    const start = t.mock.method(fixture.store, "startRun", async () => undefined);
    try {
      await fixture.store.fireDueSchedules();
      assert.equal(start.mock.callCount(), 1);
      const schedule = await fixture.store.getAgentSchedule(scheduledAgent.slug);
      assert.equal(schedule?.enabled, true);
      assert.equal(schedule?.modelDestination?.ollamaCloud, false);
      assert.equal(schedule?.lastSkipReason, undefined);
    } finally {
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

  it("records no failure when the tenant is removed while the schedule starts", async () => {
    const fixture = await makeStore({
      tenants: [realTenant],
      activeTenantId: realTenant.id,
      installedAgents: [scheduledAgent],
    });
    const internal = fixture.store as unknown as {
      startRun: () => Promise<never>;
      read(): Promise<Record<string, unknown>>;
      write(state: Record<string, unknown>): Promise<void>;
    };
    internal.startRun = async () => {
      const { activeTenantId: _removed, ...rest } = await internal.read();
      await internal.write({ ...rest, tenants: [] });
      throw new Error("No tenant connected. Connect a Microsoft 365 tenant before running agents.");
    };
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const before = Date.now();
      await fixture.store.fireDueSchedules();
      assert.equal((await fixture.store.getAppState()).runs.length, 0);
      const schedule = await fixture.store.getAgentSchedule("agent-1");
      assert.ok(Date.parse(schedule?.lastScheduledRunAt ?? "") >= before);
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
