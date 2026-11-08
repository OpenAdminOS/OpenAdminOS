import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  agentCallsNoServiceApi,
  reconcileOrganizations,
  type AgentSummary,
  type OrganizationRecord,
  type RunRecord,
  type TenantRecord,
} from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { SAMPLE_TENANT_ID } from "./sample-tenant/dataset.js";
import { noOrganizationRunCopy, RunService, type RunPersistedState, type RunServiceHost } from "./runs.js";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };

const woodgrove = {
  id: "11111111-1111-1111-1111-111111111111",
  displayName: "Woodgrove Bank",
  username: "admin@woodgrove.example",
  homeAccountId: "home-woodgrove",
  addedAt: "2026-09-01T08:00:00.000Z",
  lastUsedAt: "2026-11-07T09:00:00.000Z",
  connectionId: "connection-woodgrove",
  entraTier: "p1",
  appRegistration: { kind: "openadminos", clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
  grantedScopes: ["graph:User.Read.All", "graph:DeviceManagementManagedDevices.Read.All"],
};

const fabrikam = {
  id: "22222222-2222-2222-2222-222222222222",
  displayName: "Fabrikam",
  username: "it@fabrikam.example",
  homeAccountId: "home-fabrikam",
  addedAt: "2026-10-01T08:00:00.000Z",
  appRegistration: {
    kind: "custom",
    clientId: "3c1f6f7e-0a0b-4c5d-9e8f-123456789abc",
    authority: "https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222",
    label: "Fabrikam OpenAdminOS",
  },
};

const pilot = {
  id: SAMPLE_TENANT_ID,
  displayName: "Contoso (pilot)",
  username: "admin@contoso.invalid",
  homeAccountId: "sample",
  addedAt: "2026-11-01T08:00:00.000Z",
  kind: "sample",
};

function agent(slug: string, overrides: Record<string, unknown> = {}) {
  return {
    id: slug,
    slug,
    name: slug,
    description: "Fixture",
    mode: "read",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
    services: ["intune"],
    author: { name: "OpenAdminOS", verified: true },
    version: "1.0.0",
    installedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function schedule(lastScheduledRunAt = "2026-01-01T00:00:00.000Z") {
  return {
    enabled: true,
    intervalSeconds: 3600,
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnChangeOnly: false,
    lastScheduledRunAt,
  };
}

function completedRun(id: string, tenantId: string): RunRecord {
  const at = "2026-11-06T10:00:00.000Z";
  return {
    id,
    agentSlug: "find-inactive-devices",
    status: "completed",
    queuedAt: at,
    startedAt: at,
    finishedAt: at,
    trigger: "manual",
    tenantId,
    steps: [],
    logs: [],
    usage: null,
  } as RunRecord;
}

/** A state file as the current release writes it, with two tenants, schedules and runs. */
function currentVersionState(overrides: Record<string, unknown> = {}) {
  return {
    activeProviderId: "ollama",
    providerChosenByUser: true,
    installedAgents: [
      agent("find-inactive-devices", { schedule: schedule() }),
      agent("compliance-overview", { schedule: { ...schedule(), enabled: false } }),
      agent("team-script-draft", { scopes: [], services: [] }),
    ],
    runs: [completedRun("run-woodgrove", woodgrove.id), completedRun("run-fabrikam", fabrikam.id)],
    tenants: [woodgrove, fabrikam],
    activeTenantId: woodgrove.id,
    savedAppRegistrations: [
      { clientId: fabrikam.appRegistration.clientId, directoryTenantId: fabrikam.id, label: "Fabrikam OpenAdminOS", lastUsedAt: "2026-10-01T08:00:00.000Z", source: "user" },
    ],
    connectors: { teams: { config: { teamId: "team-1", channelId: "channel-1" }, status: "connected" } },
    runDeliveryQueue: [],
    ...overrides,
  };
}

async function makeStore(state: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-organizations-"));
  const filePath = join(dir, "state.json");
  const raw = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(filePath, raw, "utf8");
  const store = new AppStateStore({ filePath, tokenStore, statsApiUrl: "", userDataPath: dir });
  const internal = store as unknown as {
    read(): Promise<Record<string, unknown> & { organizations: OrganizationRecord[]; installedAgents: AgentSummary[] }>;
  };
  return {
    store,
    filePath,
    raw,
    read: () => internal.read(),
    file: async () => JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown> & {
      organizations?: OrganizationRecord[];
      installedAgents: AgentSummary[];
      organizationMigration?: unknown;
    },
    close: async () => {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function scheduleOf(agents: readonly AgentSummary[], slug: string) {
  return agents.find((entry) => entry.slug === slug)?.schedule;
}

describe("organization migration", () => {
  it("moves schedules to the organization of the active real tenant and keeps all data", async () => {
    const fixture = await makeStore(currentVersionState());
    try {
      const state = await fixture.store.getAppState();
      assert.deepEqual(
        state.organizations?.map((organization) => [organization.id, organization.name, organization.connections.microsoft365?.tenantId]),
        [
          [`org-${woodgrove.id}`, "Woodgrove Bank", woodgrove.id],
          [`org-${fabrikam.id}`, "Fabrikam", fabrikam.id],
        ],
      );
      assert.equal(state.activeOrganizationId, `org-${woodgrove.id}`);
      assert.equal(scheduleOf(state.installedAgents, "find-inactive-devices")?.organizationId, `org-${woodgrove.id}`);
      // A disabled schedule moves too, so enabling it later runs in Woodgrove.
      assert.equal(scheduleOf(state.installedAgents, "compliance-overview")?.organizationId, `org-${woodgrove.id}`);
      assert.deepEqual(state.organizationMigration, {
        assignedCount: 2,
        assignedOrganizationId: `org-${woodgrove.id}`,
        unassignedCount: 0,
      });
      // Nothing tenant-keyed changes: runs, tenants, registrations and connectors survive.
      assert.deepEqual(state.runs.map((run) => [run.id, run.tenantId]), [
        ["run-woodgrove", woodgrove.id],
        ["run-fabrikam", fabrikam.id],
      ]);
      assert.deepEqual(state.tenants.map((tenant) => tenant.id), [woodgrove.id, fabrikam.id]);
      assert.equal(state.tenants[1]?.appRegistration?.label, "Fabrikam OpenAdminOS");
      assert.equal(state.savedAppRegistrations?.length, 1);
      // Reading does not touch the file.
      assert.equal(await readFile(fixture.filePath, "utf8"), fixture.raw);
    } finally {
      await fixture.close();
    }
  });

  it("is idempotent: reading again and the first write give the same organizations", async () => {
    const fixture = await makeStore(currentVersionState());
    try {
      const first = await fixture.read();
      const second = await fixture.read();
      assert.deepEqual(second.organizations, first.organizations);
      assert.deepEqual(second.installedAgents, first.installedAgents);
      await fixture.store.setActiveTenant(woodgrove.id);
      const written = await fixture.file();
      assert.deepEqual(written.organizations, first.organizations);
      assert.equal(scheduleOf(written.installedAgents, "find-inactive-devices")?.organizationId, `org-${woodgrove.id}`);
      assert.deepEqual(written.organizationMigration, {
        assignedCount: 2,
        assignedOrganizationId: `org-${woodgrove.id}`,
        unassignedCount: 0,
      });
      // A later read after switching tenants never moves schedules again.
      await fixture.store.setActiveTenant(fabrikam.id);
      const after = await fixture.read();
      assert.equal(scheduleOf(after.installedAgents, "find-inactive-devices")?.organizationId, `org-${woodgrove.id}`);
      assert.deepEqual(after.organizations, first.organizations);
    } finally {
      await fixture.close();
    }
  });

  it("leaves schedules unassigned and paused when no tenant is active", async () => {
    const { activeTenantId: _none, ...state } = currentVersionState();
    const fixture = await makeStore(state);
    try {
      const app = await fixture.store.getAppState();
      assert.equal(app.activeOrganizationId, undefined);
      assert.equal(scheduleOf(app.installedAgents, "find-inactive-devices")?.organizationId, undefined);
      assert.deepEqual(app.organizationMigration, {
        assignedCount: 0,
        unassignedCount: 2,
        unassignedReason: "no-active-tenant",
      });
      // Choosing an organization does not run an unassigned schedule.
      await fixture.store.setActiveTenant(woodgrove.id);
      let starts = 0;
      (fixture.store as unknown as { startRun: () => Promise<never> }).startRun = async () => {
        starts += 1;
        throw new Error("unexpected start");
      };
      const info = console.info;
      console.info = () => undefined;
      try {
        await fixture.store.fireDueSchedules();
      } finally {
        console.info = info;
      }
      assert.equal(starts, 0);
    } finally {
      await fixture.close();
    }
  });

  it("leaves schedules unassigned when pilot mode is active alongside real tenants, never on the sample organization", async () => {
    const fixture = await makeStore(currentVersionState({
      tenants: [woodgrove, fabrikam, pilot],
      activeTenantId: SAMPLE_TENANT_ID,
    }));
    try {
      const app = await fixture.store.getAppState();
      const sample = app.organizations?.find((organization) => organization.kind === "sample");
      assert.equal(sample?.id, `org-${SAMPLE_TENANT_ID}`);
      assert.equal(sample?.name, "Contoso (pilot)");
      assert.equal(app.activeOrganizationId, sample?.id);
      assert.equal(scheduleOf(app.installedAgents, "find-inactive-devices")?.organizationId, undefined);
      assert.deepEqual(app.organizationMigration, {
        assignedCount: 0,
        unassignedCount: 2,
        unassignedReason: "pilot-active",
      });
      await assert.rejects(
        fixture.store.assignAgentSchedule("find-inactive-devices", sample!.id),
        /Scheduling is available in production/,
      );
      const assigned = await fixture.store.assignAgentSchedule("find-inactive-devices", `org-${fabrikam.id}`);
      assert.equal(scheduleOf(assigned.installedAgents, "find-inactive-devices")?.organizationId, `org-${fabrikam.id}`);
    } finally {
      await fixture.close();
    }
  });

  it("says nothing about schedules when there were none", async () => {
    const fixture = await makeStore(currentVersionState({ installedAgents: [agent("find-inactive-devices")] }));
    try {
      assert.equal((await fixture.store.getAppState()).organizationMigration, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("validates stored organizations on read", async () => {
    const fixture = await makeStore(currentVersionState({
      organizations: [
        { id: "org-custom", name: "  Woodgrove\n  Retail  ", createdAt: "2026-09-01T08:00:00.000Z", connections: { microsoft365: { tenantId: woodgrove.id } } },
        // A second organization for the same tenant is dropped.
        { id: "org-duplicate", name: "Duplicate", createdAt: "x", connections: { microsoft365: { tenantId: woodgrove.id } } },
        // A tenant that no longer exists is dropped.
        { id: "org-gone", name: "Gone", createdAt: "x", connections: { microsoft365: { tenantId: "gone" } } },
        // Malformed records are dropped.
        "not a record",
        { id: "", name: "No id", connections: { microsoft365: { tenantId: fabrikam.id } } },
        // The sample kind follows the tenant, never the record.
        { id: "org-fake-sample", name: "x".repeat(200), kind: "sample", createdAt: "x", connections: { microsoft365: { tenantId: fabrikam.id } } },
      ],
      installedAgents: [agent("find-inactive-devices", { schedule: { ...schedule(), organizationId: "org-gone" } })],
    }));
    try {
      const app = await fixture.store.getAppState();
      assert.deepEqual(
        app.organizations?.map((organization) => [organization.id, organization.name, organization.kind]),
        [
          ["org-custom", "Woodgrove Retail", undefined],
          ["org-fake-sample", "x".repeat(80), undefined],
        ],
      );
      // A schedule whose organization is gone becomes unassigned.
      assert.equal(scheduleOf(app.installedAgents, "find-inactive-devices")?.organizationId, undefined);
      assert.equal(app.organizationMigration, undefined);
    } finally {
      await fixture.close();
    }
  });
});

describe("organizations", () => {
  it("renames an organization and refuses an empty name or the sample organization", async () => {
    const fixture = await makeStore(currentVersionState({ tenants: [woodgrove, pilot] }));
    try {
      const renamed = await fixture.store.renameOrganization(`org-${woodgrove.id}`, "  Woodgrove  ");
      assert.equal(renamed.organizations?.[0]?.name, "Woodgrove");
      assert.equal(renamed.tenants[0]?.displayName, "Woodgrove Bank");
      await assert.rejects(fixture.store.renameOrganization(`org-${woodgrove.id}`, "   "), /Enter a name/);
      await assert.rejects(fixture.store.renameOrganization(`org-${SAMPLE_TENANT_ID}`, "Mine"), /keeps its name/);
      await assert.rejects(fixture.store.renameOrganization("org-missing", "Mine"), /no longer on this device/);
    } finally {
      await fixture.close();
    }
  });

  it("chooses an organization or No organization", async () => {
    const fixture = await makeStore(currentVersionState());
    try {
      const none = await fixture.store.setActiveOrganization(null);
      assert.equal(none.activeTenantId, undefined);
      assert.equal(none.activeOrganizationId, undefined);
      const fab = await fixture.store.setActiveOrganization(`org-${fabrikam.id}`);
      assert.equal(fab.activeTenantId, fabrikam.id);
      assert.equal(fab.activeOrganizationId, `org-${fabrikam.id}`);
      await assert.rejects(fixture.store.setActiveOrganization("org-missing"), /no longer on this device/);
    } finally {
      await fixture.close();
    }
  });

  it("removes the organization with its tenant, and its schedules become unassigned", async () => {
    const fixture = await makeStore(currentVersionState({ activeTenantId: fabrikam.id }));
    try {
      const before = await fixture.store.getAppState();
      assert.equal(scheduleOf(before.installedAgents, "find-inactive-devices")?.organizationId, `org-${fabrikam.id}`);
      const internal = fixture.store as unknown as { removeCachedAccount: () => Promise<void> };
      internal.removeCachedAccount = async () => undefined;
      const after = await fixture.store.disconnectTenant(fabrikam.id);
      assert.deepEqual(after.organizations?.map((organization) => organization.id), [`org-${woodgrove.id}`]);
      assert.equal(scheduleOf(after.installedAgents, "find-inactive-devices")?.organizationId, undefined);
      const written = await fixture.file();
      assert.deepEqual(written.organizations?.map((organization) => organization.id), [`org-${woodgrove.id}`]);
      assert.equal(scheduleOf(written.installedAgents, "find-inactive-devices")?.organizationId, undefined);
      assert.equal(after.runs.some((run) => run.tenantId === fabrikam.id), false);
      assert.equal(after.runs.some((run) => run.tenantId === woodgrove.id), true);
    } finally {
      await fixture.close();
    }
  });

  it("assigns a new schedule to the active organization and keeps it on later edits", async () => {
    const fixture = await makeStore(currentVersionState({
      activeTenantId: fabrikam.id,
      installedAgents: [agent("os-update-posture")],
      organizations: [],
    }));
    try {
      await fixture.store.updateAgentSchedule("os-update-posture", { enabled: true, intervalSeconds: 3600 });
      assert.equal((await fixture.store.getAgentSchedule("os-update-posture"))?.organizationId, `org-${fabrikam.id}`);
      await fixture.store.setActiveTenant(woodgrove.id);
      await fixture.store.updateAgentSchedule("os-update-posture", {
        enabled: true,
        intervalSeconds: 7200,
        // The renderer cannot move a schedule through this call.
        organizationId: `org-${woodgrove.id}`,
      });
      const kept = await fixture.store.getAgentSchedule("os-update-posture");
      assert.equal(kept?.organizationId, `org-${fabrikam.id}`);
      assert.equal(kept?.intervalSeconds, 7200);
    } finally {
      await fixture.close();
    }
  });
});

describe("schedule isolation", () => {
  it("never runs a schedule while another organization is active", async () => {
    const fixture = await makeStore(currentVersionState({
      organizations: [],
      installedAgents: [agent("find-inactive-devices", { schedule: { ...schedule(), organizationId: `org-${fabrikam.id}` } })],
    }));
    const started: Array<{ slug: string; tenantId: string | undefined }> = [];
    (fixture.store as unknown as {
      startRun(slug: string): Promise<RunRecord>;
    }).startRun = async (slug: string) => {
      started.push({ slug, tenantId: (await fixture.read()).activeTenantId as string | undefined });
      return completedRun("run-scheduled", fabrikam.id);
    };
    const info = console.info;
    console.info = () => undefined;
    try {
      await fixture.store.fireDueSchedules();
      assert.deepEqual(started, []);
      await fixture.store.setActiveTenant(fabrikam.id);
      await fixture.store.fireDueSchedules();
      assert.deepEqual(started, [{ slug: "find-inactive-devices", tenantId: fabrikam.id }]);
    } finally {
      console.info = info;
      await fixture.close();
    }
  });
});

function runHarness(state: RunPersistedState) {
  let current = structuredClone(state);
  let tail: Promise<unknown> = Promise.resolve();
  const graphBuilds: Array<string | undefined> = [];
  const host = {
    appVersion: "0.7.2",
    read: async () => structuredClone(current),
    write: async (next: RunPersistedState) => {
      current = structuredClone(next);
    },
    serialize: <T>(task: () => Promise<T>): Promise<T> => {
      const next = tail.then(task);
      tail = next.catch(() => undefined);
      return next;
    },
    listProviders: async () => [{ id: "ollama", name: "Ollama", description: "", isLocal: true, status: "connected", models: ["test"], defaultModel: "test" }],
    providerCanRun: () => true,
    buildGraph: async (tenantId: string | undefined) => {
      graphBuilds.push(tenantId);
      throw new Error("No tenant connected.");
    },
    buildLlm: async () => {
      throw new Error("No model in this test.");
    },
    readConnectorConfigs: async () => ({}),
    recordLearningEventSafely: () => undefined,
    emitStateChanged: () => undefined,
    notifyRunFinished: () => undefined,
    enqueueRunDeliveries: async () => undefined,
    processPendingRunDeliveries: async () => undefined,
  };
  return { service: new RunService(host as unknown as RunServiceHost), graphBuilds, state: () => current };
}

describe("agents without an organization", () => {
  it("only an agent that calls no service API runs without one", () => {
    assert.equal(agentCallsNoServiceApi({ scopes: [], services: [] }), true);
    // services: [] still allows the sign-in scopes.
    assert.equal(agentCallsNoServiceApi({ scopes: ["User.Read"], services: [] }), false);
    assert.equal(agentCallsNoServiceApi({ scopes: ["openid"], services: [] }), false);
    assert.equal(agentCallsNoServiceApi({ scopes: [], services: ["intune"] }), false);
    assert.equal(agentCallsNoServiceApi({ scopes: [], services: [], connectors: [{}] }), false);
    assert.equal(agentCallsNoServiceApi({ scopes: [], services: [], graphOperations: [{}] }), false);
    assert.equal(agentCallsNoServiceApi({ scopes: [], services: [], mode: "write" }), false);
    // No declaration and no scopes derives no services.
    assert.equal(agentCallsNoServiceApi({ scopes: [] }), true);
  });

  it("refuses an agent with services: [] and User.Read when no organization is active", async () => {
    const signIn = agent("whoami", { scopes: ["User.Read"], services: [] }) as unknown as AgentSummary;
    const h = runHarness({ activeProviderId: "ollama", installedAgents: [signIn], runs: [], tenants: [] });
    await assert.rejects(h.service.startRun("whoami"), (error: Error) => {
      assert.equal(error.message, noOrganizationRunCopy(signIn));
      assert.match(error.message, /^No organization is active\. whoami uses the Microsoft 365 sign-in/);
      return true;
    });
    assert.equal(h.state().runs.length, 0);
    assert.deepEqual(h.graphBuilds, []);
  });

  it("names the services an agent reads when no organization is active", async () => {
    const devices = agent("find-inactive-devices") as unknown as AgentSummary;
    const h = runHarness({ activeProviderId: "ollama", installedAgents: [devices], runs: [], tenants: [] });
    await assert.rejects(h.service.startRun("find-inactive-devices"), /find-inactive-devices reads Intune, so it runs only in an organization/);
  });

  it("queues a service-free agent with no tenant and never builds a Graph client", async () => {
    const free = agent("team-script-draft", { scopes: [], services: [] }) as unknown as AgentSummary;
    const h = runHarness({ activeProviderId: "ollama", installedAgents: [free], runs: [], tenants: [] });
    const queued = await h.service.startRun("team-script-draft");
    assert.equal(queued.tenantId, undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(h.graphBuilds, []);
    // A schedule, an Agent Team task or a retry still needs an organization.
    await assert.rejects(h.service.startRun("team-script-draft", { trigger: "schedule" }), /No organization is active/);
  });

  it("refuses a scheduled start when the schedule belongs to another organization", async () => {
    const devices = agent("find-inactive-devices", {
      schedule: { ...schedule(), organizationId: `org-${fabrikam.id}` },
    }) as unknown as AgentSummary;
    const tenants = [woodgrove, fabrikam] as unknown as TenantRecord[];
    const organizations = reconcileOrganizations({
      rawOrganizations: [],
      rawNotice: undefined,
      tenants,
      installedAgents: [],
    }).organizations;
    const h = runHarness({
      activeProviderId: "ollama",
      installedAgents: [devices],
      runs: [],
      tenants,
      organizations,
      activeTenantId: woodgrove.id,
    });
    await assert.rejects(
      h.service.startRun("find-inactive-devices", { trigger: "schedule" }),
      /belongs to another organization/,
    );
    assert.equal(h.state().runs.length, 0);
  });
});
