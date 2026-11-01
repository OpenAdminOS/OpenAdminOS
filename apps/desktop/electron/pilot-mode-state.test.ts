import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ProviderSummary, RunRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { PILOT_AGENT_SLUGS, PILOT_COPY } from "../src/shared/pilot-mode.js";
import { SAMPLE_TENANT_ID } from "./sample-tenant/dataset.js";
import { AppStateStore } from "./state.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const unavailableProvider: ProviderSummary = {
  id: "ollama",
  name: "Ollama",
  description: "Local provider",
  isLocal: true,
  status: "error",
  detail: "Ollama is not running.",
  models: [],
};

describe("pilot mode", () => {
  it("installs the three pilot agents from the bundled registry without a provider", async () => {
    const fixture = await makeFixture();
    try {
      const state = await fixture.store.addSampleTenant();
      for (const slug of PILOT_AGENT_SLUGS) {
        assert.ok(state.installedAgents.some((agent) => agent.slug === slug), slug);
      }
      const again = await fixture.store.addSampleTenant();
      assert.equal(
        again.installedAgents.filter((agent) => (PILOT_AGENT_SLUGS as readonly string[]).includes(agent.slug)).length,
        3,
      );
    } finally {
      await fixture.close();
    }
  });

  it("runs the read agents to completion with prepared text and no provider", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.addSampleTenant();
      for (const slug of ["find-inactive-devices", "conditional-access-explainer"]) {
        const queued = await fixture.store.startRun(slug);
        assert.equal(queued.pilot, true);
        assert.equal(queued.providerId, undefined);
        const run = await waitForRun(fixture.store, queued.id, ["completed", "failed"]);
        assert.equal(run.status, "completed", `${slug}: ${run.error ?? ""}`);
        assert.match(run.summary ?? "", /^Prepared sample report\./);
        assert.equal(run.model, PILOT_COPY.preparedModel);
      }
      const devices = (await fixture.store.getAppState()).runs.find(
        (run) => run.agentSlug === "find-inactive-devices",
      );
      assert.match(devices?.summary ?? "", /12 of 120 managed devices have not synced for at least 30 days/);
      assert.equal(fixture.llmBuilds, 0);
    } finally {
      await fixture.close();
    }
  });

  it("takes the write agent to typed confirmation and simulates the change on sample data", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.addSampleTenant();
      const queued = await fixture.store.startRun("stale-guest-cleanup");
      const awaiting = await waitForRun(fixture.store, queued.id, ["awaiting-confirmation", "failed", "completed"]);
      assert.equal(awaiting.status, "awaiting-confirmation", awaiting.error);
      assert.equal(awaiting.plan?.confirmationPhrase, "DISABLE 5 GUESTS");
      assert.ok(awaiting.riskAssessment);
      assert.doesNotMatch(JSON.stringify(awaiting.riskAssessment), /undeclared-request/);
      const rationale = (awaiting.result as { data?: { perGuestRationale?: unknown[] } } | undefined)?.data?.perGuestRationale;
      if (Array.isArray(rationale)) {
        for (const entry of rationale) assert.match(JSON.stringify(entry), /Prepared sample report\./);
      }

      await assert.rejects(() => fixture.store.confirmRun(queued.id, "DISABLE 4 GUESTS"), /does not match/);
      await fixture.store.confirmRun(queued.id, "DISABLE 5 GUESTS");
      const completed = await waitForRun(fixture.store, queued.id, ["completed", "failed"]);
      assert.equal(completed.status, "completed", completed.error);
      assert.match(completed.summary ?? "", /The change was simulated on sample data\./);

      const guestRun = await fixture.store.startRun("stale-guest-cleanup", { dryRun: true });
      const planned = await waitForRun(fixture.store, guestRun.id, ["planned", "completed", "failed"]);
      assert.equal(planned.status, "planned");
      assert.equal(planned.plan?.actions.length, 0, "every stale guest is already disabled in the overlay");
      assert.equal(fixture.llmBuilds, 0);
    } finally {
      await fixture.close();
    }
  });

  it("refuses every other agent on the pilot tenant with the production message", async () => {
    const fixture = await makeFixture({ withOtherAgent: true });
    try {
      await fixture.store.addSampleTenant();
      await assert.rejects(() => fixture.store.startRun("compliance-overview"), {
        message: "Compliance overview is available in production. Connect your tenant to run it.",
      });
      await assert.rejects(
        () => fixture.store.startRun("find-inactive-devices", { trigger: "schedule" }),
        { message: PILOT_COPY.featureInProduction("Scheduling") },
      );
      assert.equal((await fixture.store.getAppState()).runs.length, 0);
    } finally {
      await fixture.close();
    }
  });

  it("removes the pilot tenant after a real tenant connects", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.addSampleTenant();
      const queued = await fixture.store.startRun("find-inactive-devices");
      await waitForRun(fixture.store, queued.id, ["completed", "failed"]);
      await fixture.store.sendIntuneChatMessage({
        content: "Which Windows devices are not encrypted?",
      });
      const state = await fixture.store.connectTenant();
      assert.deepEqual(state.tenants.map((tenant) => tenant.id), ["real-tenant-id"]);
      assert.equal(state.activeTenantId, "real-tenant-id");
      assert.equal(state.runs.length, 0);
      assert.equal((await fixture.store.listIntuneChatConversations()).length, 0);
      assert.ok(fixture.signIns >= 1);
    } finally {
      await fixture.close();
    }
  });

  it("refreshes a pilot cache older than one day at startup", async () => {
    let now = new Date();
    const fixture = await makeFixture({ clock: () => new Date(now.getTime()) });
    try {
      await fixture.store.addSampleTenant();
      await waitForPreload(fixture.store);
      assert.equal(await fixture.store.refreshPilotCacheIfStale(), false);
      now = new Date(now.getTime() + DAY_MS + 60_000);
      assert.equal(await fixture.store.refreshPilotCacheIfStale(), true);
      await waitForPreload(fixture.store);
    } finally {
      await fixture.close();
    }
  });
});

async function makeFixture(options: { withOtherAgent?: boolean; clock?: () => Date } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-pilot-state-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      activeProviderId: "ollama",
      installedAgents: options.withOtherAgent
        ? [{
            id: "compliance-overview",
            slug: "compliance-overview",
            name: "Compliance overview",
            description: "Fixture",
            mode: "read",
            category: "compliance",
            tier: "agent",
            requiresEntraTier: "free",
            scopes: [],
            author: { name: "OpenAdminOS" },
            version: "1.0.0",
            installedAt: "2026-10-26T12:00:00.000Z",
          }]
        : [],
      runs: [],
      tenants: [],
    }),
    "utf8",
  );
  const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };
  let llmBuilds = 0;
  let providerLists = 0;
  let signIns = 0;
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    tokenStoreFor: () => tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
    appVersion: "0.7.2",
    ...(options.clock ? { clock: options.clock } : {}),
    providerListFactory: () => {
      providerLists += 1;
      return [unavailableProvider];
    },
    llmFactory: () => {
      llmBuilds += 1;
      throw new Error("Pilot runs must not build a provider LLM.");
    },
    interactiveSignIn: async () => {
      signIns += 1;
      return {
        account: {
          homeAccountId: "real-home-account",
          tenantId: "real-tenant-id",
          username: "admin@fabrikam.invalid",
        },
      } as never;
    },
  });
  return {
    store,
    get llmBuilds() {
      return llmBuilds;
    },
    get providerLists() {
      return providerLists;
    },
    get signIns() {
      return signIns;
    },
    async close() {
      // Connecting a tenant starts a background cache preload; stop every
      // tenant's preload before deleting the directory it writes into.
      const tenantIds = new Set([SAMPLE_TENANT_ID]);
      for (const tenant of (await store.getAppState().catch(() => undefined))?.tenants ?? []) {
        tenantIds.add(tenant.id);
      }
      for (const tenantId of tenantIds) {
        await store.cancelGraphCachePreload(tenantId).catch(() => undefined);
      }
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

async function waitForRun(
  store: AppStateStore,
  runId: string,
  statuses: RunRecord["status"][],
): Promise<RunRecord> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const run = (await store.getAppState()).runs.find((entry) => entry.id === runId);
    if (run && statuses.includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Run ${runId} did not reach ${statuses.join(" or ")}.`);
}

async function waitForPreload(store: AppStateStore): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = await store.getGraphCacheStatus(SAMPLE_TENANT_ID);
    if (status.preload?.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Pilot cache preload did not finish.");
}

describe("pilot mode and multi-tenant Chat", () => {
  it("refuses a multi-tenant scope that includes the pilot tenant before any model is read", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.addSampleTenant();
      await assert.rejects(
        fixture.store.preflightMultiTenantIntuneChat({
          prompt: "Which managed devices have not synced in the last 7 days?",
          tenantScope: { kind: "all" },
        }),
        new RegExp(PILOT_COPY.multiTenantRejected.replace(/[.()]/g, "\\$&")),
      );
    } finally {
      await fixture.close();
    }
  });
});
