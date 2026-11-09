import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  reconcileOrganizations,
  type AgentSummary,
  type OfficePersonaInput,
  type TenantRecord,
} from "@openadminos/agent-sdk";

import { OfficeService, type OfficeHost } from "./office.js";
import { RunService, type RunPersistedState, type RunServiceHost } from "./runs.js";

/**
 * Review round 2: Agent Team persona recurrence starts runs with
 * trigger "schedule" through the real RunService. It keeps the persona's
 * own tenant binding and is not held to installed-agent schedules.
 */
const tenantA = { id: "tenant-a", displayName: "Woodgrove", username: "a@woodgrove.example", homeAccountId: "a", addedAt: "2026-09-01T00:00:00.000Z" };
const tenantB = { id: "tenant-b", displayName: "Fabrikam", username: "b@fabrikam.example", homeAccountId: "b", addedAt: "2026-09-01T00:00:00.000Z" };

function agent(slug: string): AgentSummary {
  return {
    id: slug, slug, name: slug, description: "Test", category: "devices", mode: "read", tier: "agent",
    requiresEntraTier: "free", version: "1.0.0", scopes: [], services: [], author: { name: "Test" },
    installedAt: "2026-09-01T00:00:00.000Z",
  } as AgentSummary;
}

async function fixture(activeTenantId: string) {
  const dir = await mkdtemp(join(tmpdir(), "office-organizations-"));
  let now = Date.parse("2026-09-10T10:00:00Z");
  const tenants = [tenantA, tenantB] as unknown as TenantRecord[];
  let state: RunPersistedState = {
    activeProviderId: "ollama",
    installedAgents: [agent("one"), agent("two")],
    runs: [],
    tenants,
    organizations: reconcileOrganizations({ rawOrganizations: [], rawNotice: undefined, tenants, installedAgents: [] }).organizations,
    activeTenantId,
  };
  let tail: Promise<unknown> = Promise.resolve();
  const runHost = {
    appVersion: "0.7.2",
    read: async () => structuredClone(state),
    write: async (next: RunPersistedState) => {
      state = structuredClone(next);
    },
    serialize: <T>(task: () => Promise<T>): Promise<T> => {
      const next = tail.then(task);
      tail = next.catch(() => undefined);
      return next;
    },
    listProviders: async () => [{ id: "ollama", name: "Local", description: "", isLocal: true, status: "connected", models: ["test"], defaultModel: "test" }],
    providerCanRun: () => true,
    // Runs stay queued: the test checks what was admitted, not execution.
    buildLlm: async () => new Promise(() => {}),
    buildGraph: async () => new Promise(() => {}),
    readConnectorConfigs: async () => ({}),
    recordLearningEventSafely: () => undefined,
    emitStateChanged: () => undefined,
    notifyRunFinished: () => undefined,
    enqueueRunDeliveries: async () => undefined,
    processPendingRunDeliveries: async () => undefined,
  };
  const runs = new RunService(runHost as unknown as RunServiceHost);
  const host: OfficeHost = {
    context: async () => ({
      tenants: state.tenants,
      providers: [{ id: "ollama", name: "Local", description: "", isLocal: true, status: "connected", models: ["test"] }],
      agents: state.installedAgents,
      runs: state.runs,
      providerConfigKey: "original",
    }),
    startRun: (slug, options) => runs.startRun(slug, options),
    cancelRun: (id) => runs.cancelRun(id),
    changed() {},
  };
  const service = new OfficeService(join(dir, "office.db"), host, () => now);
  const input: OfficePersonaInput = {
    name: "Device watcher",
    responsibility: "Check devices",
    avatar: "robot",
    color: "amber",
    tenantId: tenantA.id,
    providerId: "ollama",
    agentSlugs: ["one"],
    intervalMinutes: 5,
    maxMinutes: 30,
    enabled: true,
  };
  return {
    service,
    input,
    state: () => state,
    advance(ms: number) {
      now += ms;
    },
    async close() {
      service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

describe("Agent Team persona recurrence with organizations (review round 2)", () => {
  for (const [label, active] of [
    ["its own tenant active", tenantA.id],
    ["another organization active", tenantB.id],
  ] as const) {
    it(`starts a scheduled persona run on the persona's tenant with ${label}`, async () => {
      const f = await fixture(active);
      try {
        const {
          personas: [persona],
        } = await f.service.save(f.input);
        f.advance(5 * 60_000 + 1000);
        await f.service.tick();
        const started = f.state().runs.find((run) => run.office?.personaId === persona!.id);
        assert.ok(started, f.service.state().missions.map((mission) => `${mission.status}: ${mission.error ?? ""}`).join("; "));
        assert.equal(started.tenantId, tenantA.id);
        assert.equal(started.trigger, "schedule");
        const after = f.service.state();
        assert.equal(after.personas.find((entry) => entry.id === persona!.id)?.enabled, true);
        assert.equal(after.missions.some((mission) => mission.status === "failed"), false);
      } finally {
        await f.close();
      }
    });
  }
});
