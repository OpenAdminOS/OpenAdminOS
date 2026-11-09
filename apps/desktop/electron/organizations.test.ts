import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  agentCallsNoServiceApi,
  normalizeOrganizationName,
  reconcileOrganizations,
  scheduleRunsInActiveOrganization,
  type AgentSummary,
  type OrganizationRecord,
  type RunRecord,
  type TenantRecord,
} from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { SAMPLE_TENANT_ID } from "./sample-tenant/dataset.js";
import {
  noOrganizationRunCopy,
  OTHER_ORGANIZATION_RUN_COPY,
  PLAN_NO_ORGANIZATION_COPY,
  planOtherOrganizationCopy,
  RunService,
  SCHEDULE_OTHER_ORGANIZATION_COPY,
  UNASSIGNED_SCHEDULE_RUN_COPY,
  type RunPersistedState,
  type RunServiceHost,
} from "./runs.js";
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
        // The sample kind follows the tenant, never the record.
        { id: "org-fake-sample", name: "x".repeat(200), kind: "sample", createdAt: "x", connections: { microsoft365: { tenantId: fabrikam.id } } },
        // No id: kept under a fresh id (round 3) unless its tenant is
        // already claimed, as here, where it loses to the record above.
        { id: "", name: "No id", connections: { microsoft365: { tenantId: fabrikam.id } } },
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
    await assert.rejects(h.service.startRun("team-script-draft", { trigger: "schedule" }), /unassigned, so it is paused/);
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

describe("schedule edits (review round 1)", () => {
  it("keeps an unassigned schedule unassigned when its interval or notifications change", async () => {
    const { activeTenantId: _none, ...state } = currentVersionState();
    const fixture = await makeStore(state);
    try {
      await fixture.store.setActiveTenant(woodgrove.id);
      await fixture.store.updateAgentSchedule("find-inactive-devices", {
        enabled: true,
        intervalSeconds: 7200,
        notifyOnSuccess: false,
      });
      const edited = await fixture.store.getAgentSchedule("find-inactive-devices");
      assert.equal(edited?.organizationId, undefined);
      assert.equal(edited?.intervalSeconds, 7200);
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
      // Assign is the only way in.
      const assigned = await fixture.store.assignAgentSchedule("find-inactive-devices", `org-${woodgrove.id}`);
      assert.equal(scheduleOf(assigned.installedAgents, "find-inactive-devices")?.organizationId, `org-${woodgrove.id}`);
    } finally {
      await fixture.close();
    }
  });
});

function twoOrganizations(agentOverrides: Record<string, unknown>, activeTenantId: string) {
  // Grants absent means every service, so only the boundary decides.
  const tenants = [woodgrove, fabrikam].map((tenant) => {
    const { grantedScopes: _grants, ...rest } = tenant as Record<string, unknown>;
    return rest;
  }) as unknown as TenantRecord[];
  const organizations = reconcileOrganizations({ rawOrganizations: [], rawNotice: undefined, tenants, installedAgents: [] }).organizations;
  return runHarness({
    activeProviderId: "ollama",
    installedAgents: [agent("find-inactive-devices", agentOverrides) as unknown as AgentSummary],
    runs: [],
    tenants,
    organizations,
    activeTenantId,
  });
}

describe("organization boundary on every start (review round 1)", () => {
  it("refuses a scheduled start pinned to another tenant while another organization is active", async () => {
    // Fabrikam (B) is active; the schedule belongs to Woodgrove (A) and the caller pins A.
    const h = twoOrganizations({ schedule: { ...schedule(), organizationId: `org-${woodgrove.id}` } }, fabrikam.id);
    await assert.rejects(
      h.service.startRun("find-inactive-devices", { trigger: "schedule", tenantId: woodgrove.id }),
      (error: Error) => error.message === OTHER_ORGANIZATION_RUN_COPY,
    );
    await assert.rejects(
      h.service.startRun("find-inactive-devices", { trigger: "schedule" }),
      (error: Error) => error.message === SCHEDULE_OTHER_ORGANIZATION_COPY,
    );
    assert.equal(h.state().runs.length, 0);
  });

  it("refuses a scheduled start of an unassigned schedule", async () => {
    const h = twoOrganizations({ schedule: schedule() }, woodgrove.id);
    await assert.rejects(
      h.service.startRun("find-inactive-devices", { trigger: "schedule" }),
      (error: Error) => error.message === UNASSIGNED_SCHEDULE_RUN_COPY,
    );
  });

  it("queues a scheduled start in its own active organization against the active tenant", async () => {
    const h = twoOrganizations({ schedule: { ...schedule(), organizationId: `org-${woodgrove.id}` } }, woodgrove.id);
    const run = await h.service.startRun("find-inactive-devices", { trigger: "schedule", tenantId: woodgrove.id });
    assert.equal(run.tenantId, woodgrove.id);
    assert.equal(run.trigger, "schedule");
  });

  it("holds renderer starts to the active tenant but lets host-owned batches pin their own", async () => {
    const h = twoOrganizations({}, fabrikam.id);
    await assert.rejects(
      h.service.startRun("find-inactive-devices", { tenantId: woodgrove.id }, { activeOrganizationOnly: true }),
      (error: Error) => error.message === OTHER_ORGANIZATION_RUN_COPY,
    );
    const active = await h.service.startRun("find-inactive-devices", { tenantId: fabrikam.id }, { activeOrganizationOnly: true });
    assert.equal(active.tenantId, fabrikam.id);
    // Run for real takes the dry run's tenant, which is not the active one.
    const dry = {
      id: "dry", agentSlug: "find-inactive-devices", status: "planned", dryRun: true, tenantId: woodgrove.id,
      providerId: "ollama", model: "test", inputSettings: {}, queuedAt: "2026-11-01T00:00:00.000Z", steps: [], logs: [],
    } as unknown as RunRecord;
    const writer = twoOrganizations({ mode: "write" }, fabrikam.id);
    const internal = writer as unknown as { state(): RunPersistedState };
    internal.state().runs.push(dry);
    await assert.rejects(
      writer.service.startRun("find-inactive-devices", { runForRealOfRunId: "dry" }, { activeOrganizationOnly: true }),
      (error: Error) => error.message === OTHER_ORGANIZATION_RUN_COPY,
    );
    // A multi-tenant batch is a host-owned caller with an explicit tenant scope.
    const batch = await h.service.startRun("find-inactive-devices", { tenantId: woodgrove.id, trigger: "manual" });
    assert.equal(batch.tenantId, woodgrove.id);
  });
});

describe("menu bar run due (review round 1)", () => {
  it("runs only the active organization's assigned schedules; the others wait", () => {
    assert.equal(scheduleRunsInActiveOrganization({ organizationId: "org-a" }, "org-a"), true);
    assert.equal(scheduleRunsInActiveOrganization({ organizationId: "org-b" }, "org-a"), false);
    assert.equal(scheduleRunsInActiveOrganization({}, "org-a"), false);
    assert.equal(scheduleRunsInActiveOrganization({}, undefined), false);
    assert.equal(scheduleRunsInActiveOrganization({ organizationId: "org-a" }, undefined), false);
  });
});

describe("connections of other vendors survive (review round 1)", () => {
  it("keeps unknown connection keys and organizations without Microsoft 365 through read and write", async () => {
    const fixture = await makeStore(currentVersionState({
      organizations: [
        { id: `org-${woodgrove.id}`, name: "Woodgrove", createdAt: "2026-09-01T08:00:00.000Z", connections: { microsoft365: { tenantId: woodgrove.id }, jamf: { instanceUrl: "https://woodgrove.jamfcloud.com" } } },
        { id: "org-northwind", name: "Northwind Studio", createdAt: "2026-11-20T08:00:00.000Z", connections: { jamf: { instanceUrl: "https://northwind.jamfcloud.com" } } },
        // Not a record: kept as it was (round 3), a newer version may read it.
        { id: "org-broken", name: "Broken", createdAt: "x", connections: { jamf: "nope" } },
      ],
    }));
    try {
      const app = await fixture.store.getAppState();
      const woodgroveOrg = app.organizations?.find((organization) => organization.id === `org-${woodgrove.id}`);
      assert.deepEqual(woodgroveOrg?.connections, { jamf: { instanceUrl: "https://woodgrove.jamfcloud.com" }, microsoft365: { tenantId: woodgrove.id } });
      assert.ok(app.organizations?.some((organization) => organization.id === "org-northwind"));
      assert.equal(app.organizations?.find((organization) => organization.id === "org-broken")?.connections.jamf, "nope");
      await fixture.store.setActiveTenant(woodgrove.id);
      const written = await fixture.file();
      assert.deepEqual(written.organizations?.find((organization) => organization.id === "org-northwind")?.connections, { jamf: { instanceUrl: "https://northwind.jamfcloud.com" } });
      assert.deepEqual(written.organizations?.find((organization) => organization.id === `org-${woodgrove.id}`)?.connections.jamf, { instanceUrl: "https://woodgrove.jamfcloud.com" });
      // This version cannot run schedules in, or switch to, an organization without Microsoft 365.
      await assert.rejects(fixture.store.assignAgentSchedule("find-inactive-devices", "org-northwind"), /cannot run schedules in that organization/);
      await assert.rejects(fixture.store.setActiveOrganization("org-northwind"), /no longer on this device/);
    } finally {
      await fixture.close();
    }
  });
});

describe("organization names (review round 1)", () => {
  it("cuts a stored name by code points and never splits a surrogate pair", () => {
    const name = `${"a".repeat(79)}😀😀`;
    const normalized = normalizeOrganizationName(name)!;
    assert.equal([...normalized].length, 80);
    assert.equal(normalized.endsWith("😀"), true);
    assert.equal(/[\uD800-\uDBFF]$/.test(normalized), false);
  });

  it("refuses a new name over 80 characters instead of cutting it, and counts emoji as one", async () => {
    const fixture = await makeStore(currentVersionState());
    try {
      await assert.rejects(fixture.store.renameOrganization(`org-${woodgrove.id}`, "x".repeat(81)), /at most 80 characters/);
      const ok = await fixture.store.renameOrganization(`org-${woodgrove.id}`, "😀".repeat(80));
      assert.equal(ok.organizations?.[0]?.name, "😀".repeat(80));
    } finally {
      await fixture.close();
    }
  });
});

describe("organization switch during a scheduler tick (Muse round 2)", () => {
  it("records no failure and keeps the due slot when the host refuses after a switch", async () => {
    const lastScheduledRunAt = "2026-01-01T00:00:00.000Z";
    const fixture = await makeStore(currentVersionState({
      organizations: [],
      installedAgents: [agent("find-inactive-devices", { schedule: { ...schedule(lastScheduledRunAt), organizationId: `org-${woodgrove.id}` } })],
    }));
    const store = fixture.store as unknown as {
      startRun(slug: string, options?: Record<string, unknown>): Promise<RunRecord>;
    };
    const realStart = store.startRun.bind(fixture.store);
    let attempts = 0;
    // The admin switches to Fabrikam after the tick read the state.
    store.startRun = async (slug, options) => {
      attempts += 1;
      await fixture.store.setActiveTenant(fabrikam.id);
      return realStart(slug, options);
    };
    const info = console.info;
    const error = console.error;
    const errors: unknown[] = [];
    console.info = () => undefined;
    console.error = (...values: unknown[]) => void errors.push(values);
    try {
      await fixture.store.fireDueSchedules();
      assert.equal(attempts, 1);
      const app = await fixture.store.getAppState();
      assert.equal(app.runs.some((run) => run.trigger === "schedule"), false);
      assert.equal(scheduleOf(app.installedAgents, "find-inactive-devices")?.lastScheduledRunAt, lastScheduledRunAt);
      assert.deepEqual(errors, []);
    } finally {
      console.info = info;
      console.error = error;
      await fixture.close();
    }
  });
});

describe("tenant checks after a Run for real rewrite (Muse round 2)", () => {
  it("refuses a pilot Run for real of a dry run planned on a real tenant", async () => {
    const tenants = [woodgrove, pilot] as unknown as TenantRecord[];
    const writer = agent("stale-guest-cleanup", { mode: "write", scopes: [], services: [] }) as unknown as AgentSummary;
    const dry = {
      id: "dry-real", agentSlug: "stale-guest-cleanup", status: "planned", dryRun: true, tenantId: woodgrove.id,
      providerId: "ollama", model: "test", inputSettings: {}, queuedAt: "2026-11-01T00:00:00.000Z", steps: [], logs: [],
    } as unknown as RunRecord;
    const h = runHarness({
      activeProviderId: "ollama",
      installedAgents: [writer],
      runs: [dry],
      tenants,
      organizations: reconcileOrganizations({ rawOrganizations: [], rawNotice: undefined, tenants, installedAgents: [] }).organizations,
      activeTenantId: SAMPLE_TENANT_ID,
    });
    // Pilot runs need the prepared-text model; the start is refused before it is used.
    (h.service as unknown as { host: Record<string, unknown> }).host.buildPilotLlm = () => {
      throw new Error("must not run");
    };
    await assert.rejects(
      h.service.startRun("stale-guest-cleanup", { runForRealOfRunId: "dry-real" }),
      (error: Error) => error.message === OTHER_ORGANIZATION_RUN_COPY,
    );
    assert.deepEqual(h.state().runs.map((run) => run.id), ["dry-real"]);
  });
});

describe("duplicate tenant claims keep unknown connections (Muse round 2)", () => {
  it("moves the losing record's vendor connection to the winning organization and keeps it on write", async () => {
    const fixture = await makeStore(currentVersionState({
      organizations: [
        { id: "org-first", name: "Woodgrove", createdAt: "2026-09-01T08:00:00.000Z", connections: { microsoft365: { tenantId: woodgrove.id } } },
        { id: "org-second", name: "Woodgrove copy", createdAt: "2026-09-02T08:00:00.000Z", connections: { microsoft365: { tenantId: woodgrove.id }, jamf: { instanceUrl: "https://woodgrove.jamfcloud.com" } } },
      ],
    }));
    try {
      const app = await fixture.store.getAppState();
      const woodgroveOrgs = app.organizations?.filter((organization) => organization.connections.microsoft365?.tenantId === woodgrove.id) ?? [];
      assert.equal(woodgroveOrgs.length, 1);
      assert.equal(woodgroveOrgs[0]?.id, "org-first");
      assert.deepEqual(woodgroveOrgs[0]?.connections.jamf, { instanceUrl: "https://woodgrove.jamfcloud.com" });
      await fixture.store.setActiveTenant(woodgrove.id);
      const written = await fixture.file();
      assert.deepEqual(
        written.organizations?.find((organization) => organization.id === "org-first")?.connections.jamf,
        { instanceUrl: "https://woodgrove.jamfcloud.com" },
      );
    } finally {
      await fixture.close();
    }
  });
});

describe("workspaces and runs with no organization (Muse round 2)", () => {
  it("never links a run with no organization to a tenant's workspace", async () => {
    const tenantless = { ...completedRun("run-none", woodgrove.id), tenantId: undefined } as RunRecord;
    const fixture = await makeStore(currentVersionState({ runs: [completedRun("run-woodgrove", woodgrove.id), tenantless] }));
    try {
      const workspace = await fixture.store.createWorkspace({ tenantId: woodgrove.id, title: "Device review" });
      await assert.rejects(fixture.store.linkWorkspaceRun(workspace.id, "run-none"), /had no organization/);
      const link = await fixture.store.linkWorkspaceRun(workspace.id, "run-woodgrove");
      assert.equal(link.tenantId, woodgrove.id);
    } finally {
      await fixture.close();
    }
  });
});

describe("applying a reviewed plan holds to the active organization (review round 3)", () => {
  const plan = {
    summary: "Disable 2 stale guests",
    confirmationPhrase: "DISABLE 2 GUESTS",
    actions: [{ id: "a1", kind: "graph-write", label: "Disable guest", severity: "default", request: { method: "PATCH", path: "/users/1", body: {} } }],
  };
  function pending(id: string, extra: Record<string, unknown> = {}): RunRecord {
    return {
      id, agentSlug: "stale-guest-cleanup", status: "awaiting-confirmation", queuedAt: "2026-11-09T10:00:00.000Z",
      trigger: "manual", tenantId: woodgrove.id, providerId: "ollama", model: "test", steps: [], logs: [], plan, ...extra,
    } as unknown as RunRecord;
  }
  const cases: Array<[string, RunRecord]> = [
    ["an agent write plan", pending("run-agent")],
    ["a baseline rollback", pending("run-rollback", { agentSlug: "baseline-rollback", origin: "baseline-rollback", rollback: { baselineId: "b1", requiredScopes: [], manualCount: 0 } })],
    ["an external gateway proposal", pending("run-proposal", { agentSlug: "external-proposal", origin: "external-proposal", external: { clientId: "c1", clientName: "MCP client", requiredScopes: [] } })],
    ["an Agent Team approval", pending("run-team", { office: { missionId: "m1", personaId: "p1", step: 0 } })],
  ];
  function harness(run: RunRecord, activeTenantId: string | undefined) {
    const tenants = [woodgrove, fabrikam].map((tenant) => {
      const { grantedScopes: _grants, ...rest } = tenant as Record<string, unknown>;
      return rest;
    }) as unknown as TenantRecord[];
    const state: RunPersistedState = {
      activeProviderId: "ollama",
      installedAgents: [agent("stale-guest-cleanup", { mode: "write", scopes: ["User.ReadWrite.All"], services: ["entra"] }) as unknown as AgentSummary],
      runs: [run],
      tenants,
      organizations: reconcileOrganizations({ rawOrganizations: [], rawNotice: undefined, tenants, installedAgents: [] }).organizations,
      ...(activeTenantId ? { activeTenantId } : {}),
    };
    return runHarness(state);
  }
  for (const [label, run] of cases) {
    for (const [stateLabel, active] of [["No organization", undefined], ["another organization", fabrikam.id]] as const) {
      it(`refuses ${label} with ${stateLabel} active and keeps the plan untouched`, async () => {
        const h = harness(run, active);
        await assert.rejects(
          h.service.confirmRun(run.id, plan.confirmationPhrase, { activeOrganizationOnly: true }),
          (error: Error) => {
            assert.equal(error.name, "OrganizationBoundaryError");
            assert.equal(error.message, planOtherOrganizationCopy("Woodgrove Bank"));
            return true;
          },
        );
        assert.deepEqual(h.state().runs, [run]);
        assert.deepEqual(h.graphBuilds, []);
      });
    }
  }

  for (const [label, run] of cases) {
    const tenantless = { ...run } as RunRecord;
    delete (tenantless as { tenantId?: string }).tenantId;
    for (const boundary of [{ activeOrganizationOnly: true }, {}]) {
      it(`refuses ${label} with no organization under No organization${boundary.activeOrganizationOnly ? "" : " from any caller"} and keeps it unchanged (Muse round 4)`, async () => {
        const h = harness(tenantless, undefined);
        await assert.rejects(h.service.confirmRun(tenantless.id, plan.confirmationPhrase, boundary), (error: Error) => {
          assert.equal(error.name, "OrganizationBoundaryError");
          assert.equal(error.message, PLAN_NO_ORGANIZATION_COPY);
          return true;
        });
        assert.deepEqual(h.state().runs, [tenantless]);
        assert.deepEqual(h.graphBuilds, []);
      });
    }
  }

  it("applies the plan when its organization is active", async () => {
    const run = pending("run-agent");
    const h = harness(run, woodgrove.id);
    const confirmed = await h.service.confirmRun(run.id, plan.confirmationPhrase, { activeOrganizationOnly: true });
    assert.equal(confirmed.status, "running");
    assert.equal(confirmed.tenantId, woodgrove.id);
  });
});

describe("a run with no tenant whose agent now needs a service (Muse round 3)", () => {
  it("fails closed with the no-organization message and never builds a Graph client", async () => {
    const changed = agent("team-script-draft", { scopes: ["User.Read.All"], services: ["entra"] }) as unknown as AgentSummary;
    const queued = {
      id: "run-tenantless", agentSlug: "team-script-draft", status: "queued", queuedAt: "2026-11-09T00:00:00.000Z",
      trigger: "manual", providerId: "ollama", model: "test", steps: [], logs: [],
    } as unknown as RunRecord;
    const tenants = [woodgrove] as unknown as TenantRecord[];
    const h = runHarness({
      activeProviderId: "ollama",
      installedAgents: [changed],
      runs: [queued],
      tenants,
      organizations: reconcileOrganizations({ rawOrganizations: [], rawNotice: undefined, tenants, installedAgents: [] }).organizations,
      activeTenantId: woodgrove.id,
    });
    const internal = h.service as unknown as { driveRun(input: { run: RunRecord; agent: AgentSummary; providerId: string; model?: string }): Promise<void> };
    (h.service as unknown as { baseRunLlm: () => Promise<unknown> }).baseRunLlm = async () => ({});
    await internal.driveRun({ run: queued, agent: changed, providerId: "ollama", model: "test" });
    assert.deepEqual(h.graphBuilds, []);
    const stored = h.state().runs.find((run) => run.id === "run-tenantless");
    assert.equal(stored?.status, "failed");
    assert.equal(stored?.tenantId, undefined);
    assert.match(stored?.error ?? stored?.summary ?? "", /No organization is active\. team-script-draft reads Entra/);
  });
});

describe("reconcile keeps what it cannot use (Muse round 3)", () => {
  const tenants = [woodgrove, fabrikam] as unknown as TenantRecord[];
  it("keeps records with a long or duplicate id under a fresh id, with their vendor connections", () => {
    const { organizations } = reconcileOrganizations({
      rawOrganizations: [
        { id: "org-shared", name: "Woodgrove", createdAt: "x", connections: { microsoft365: { tenantId: woodgrove.id } } },
        { id: "org-shared", name: "Fabrikam Retail", createdAt: "x", connections: { microsoft365: { tenantId: fabrikam.id }, jamf: { instanceUrl: "https://fabrikam.jamfcloud.com" } } },
        { id: "x".repeat(301), name: "Northwind", createdAt: "x", connections: { jamf: { instanceUrl: "https://northwind.jamfcloud.com" } } },
      ],
      rawNotice: undefined,
      tenants,
      installedAgents: [],
    });
    const fabrikamOrg = organizations.find((organization) => organization.connections.microsoft365?.tenantId === fabrikam.id);
    assert.equal(fabrikamOrg?.id, `org-${fabrikam.id}`);
    assert.equal(fabrikamOrg?.name, "Fabrikam Retail");
    assert.deepEqual(fabrikamOrg?.connections.jamf, { instanceUrl: "https://fabrikam.jamfcloud.com" });
    const northwind = organizations.find((organization) => organization.name === "Northwind");
    assert.equal(northwind?.id, "org-kept-1");
    assert.deepEqual(northwind?.connections.jamf, { instanceUrl: "https://northwind.jamfcloud.com" });
    assert.equal(new Set(organizations.map((organization) => organization.id)).size, organizations.length);
  });

  it("keeps unknown connection values that are not records", () => {
    const { organizations } = reconcileOrganizations({
      rawOrganizations: [
        { id: "org-w", name: "Woodgrove", createdAt: "x", connections: { microsoft365: { tenantId: woodgrove.id }, futureFlag: true, vendorList: ["a", "b"] } },
      ],
      rawNotice: undefined,
      tenants,
      installedAgents: [],
    });
    const woodgroveOrg = organizations.find((organization) => organization.id === "org-w");
    assert.equal(woodgroveOrg?.connections.futureFlag, true);
    assert.deepEqual(woodgroveOrg?.connections.vendorList, ["a", "b"]);
  });

  it("moves a schedule with a replaced over-long id to the kept record (Muse round 4)", () => {
    const longWoodgrove = `org-${"w".repeat(300)}`;
    const longKept = `org-${"k".repeat(300)}`;
    const result = reconcileOrganizations({
      rawOrganizations: [
        { id: longWoodgrove, name: "Woodgrove", createdAt: "x", connections: { microsoft365: { tenantId: woodgrove.id } } },
        { id: longKept, name: "Northwind", createdAt: "x", connections: { jamf: { instanceUrl: "https://northwind.jamfcloud.com" } } },
        { id: "org-shared", name: "Fabrikam", createdAt: "x", connections: { microsoft365: { tenantId: fabrikam.id } } },
      ],
      rawNotice: undefined,
      tenants,
      installedAgents: [
        agent("long", { schedule: { ...schedule(), organizationId: longWoodgrove } }),
        agent("kept", { schedule: { ...schedule(), organizationId: longKept } }),
        agent("unknown", { schedule: { ...schedule(), organizationId: "x".repeat(400) } }),
      ] as unknown as AgentSummary[],
    });
    assert.equal(scheduleOf(result.installedAgents, "long")?.organizationId, `org-${woodgrove.id}`);
    assert.equal(scheduleOf(result.installedAgents, "kept")?.organizationId, "org-kept-1");
    // An id that no record had stays unassigned.
    assert.equal(scheduleOf(result.installedAgents, "unknown")?.organizationId, undefined);
  });

  it("counts only the schedules the migration moved", () => {
    const tenantsWithOrg = [woodgrove, fabrikam] as unknown as TenantRecord[];
    const result = reconcileOrganizations({
      rawOrganizations: undefined,
      rawNotice: undefined,
      tenants: tenantsWithOrg,
      activeTenantId: woodgrove.id,
      installedAgents: [
        agent("moved", { schedule: schedule() }),
        // Assigned by a newer version before a downgrade: kept, not moved.
        agent("kept", { schedule: { ...schedule(), organizationId: `org-${fabrikam.id}` } }),
      ] as unknown as AgentSummary[],
    });
    assert.deepEqual(result.notice, { assignedCount: 1, assignedOrganizationId: `org-${woodgrove.id}`, unassignedCount: 0 });
    assert.equal(scheduleOf(result.installedAgents, "kept")?.organizationId, `org-${fabrikam.id}`);
  });
});
