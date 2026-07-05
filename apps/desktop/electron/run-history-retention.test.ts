import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentSummary, RunRecord, TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("run history retention", () => {
  it("prunes oldest eligible runs and keeps workspace, active, and confirmation runs", async () => {
    const run1At = daysAgo(300);
    const run2At = daysAgo(250);
    const fixture = await makeStoreFixture({
      runs: [
        run("run-1", "completed", run1At),
        run("run-2", "completed", run2At),
        run("run-workspace", "completed", daysAgo(240)),
        run("run-active", "running", daysAgo(230)),
        run("run-confirm", "awaiting-confirmation", daysAgo(220)),
        run("run-recent-1", "completed", daysAgo(10)),
        run("run-recent-2", "completed", daysAgo(5)),
      ],
    });
    try {
      const workspace = await fixture.store.createWorkspace({
        tenantId: tenant.id,
        title: "Device cleanup evidence",
      });
      await fixture.store.linkWorkspaceRun(workspace.id, "run-workspace");
      await fixture.store.setRunHistoryRetentionSettings({
        neverPrune: false,
        keepLastRuns: 1,
        keepDays: 30,
      });

      const result = await fixture.store.pruneRunHistoryNow();
      const state = await fixture.store.getAppState();
      const remaining = state.runs.map((entry) => entry.id).sort();

      assert.deepEqual(remaining, [
        "run-active",
        "run-confirm",
        "run-recent-1",
        "run-recent-2",
        "run-workspace",
      ]);
      assert.equal(result.prunedCount, 2);
      assert.equal(result.oldestPrunedQueuedAt, run1At);
      assert.equal(result.newestPrunedQueuedAt, run2At);
      assert.equal(result.protectedWorkspaceCount, 1);
      assert.equal(result.protectedActiveCount, 1);
      assert.equal(result.protectedAwaitingConfirmationCount, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("respects never-prune even when runs exceed the count and age policy", async () => {
    const fixture = await makeStoreFixture({
      runs: [
        run("run-old-1", "completed", daysAgo(400)),
        run("run-old-2", "failed", daysAgo(399)),
        run("run-old-3", "cancelled", daysAgo(398)),
      ],
    });
    try {
      await fixture.store.setRunHistoryRetentionSettings({
        neverPrune: true,
        keepLastRuns: null,
        keepDays: null,
      });

      const result = await fixture.store.pruneRunHistoryNow();
      const state = await fixture.store.getAppState();

      assert.equal(result.prunedCount, 0);
      assert.equal(result.reason, "Never prune is enabled.");
      assert.deepEqual(
        state.runs.map((entry) => entry.id).sort(),
        ["run-old-1", "run-old-2", "run-old-3"],
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

async function makeStoreFixture(input: { runs: RunRecord[] }): Promise<{
  store: AppStateStore;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-run-retention-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        activeProviderId: "ollama",
        installedAgents: [agent],
        runs: input.runs,
        tenants: [tenant],
        activeTenantId: tenant.id,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
  });

  return {
    store,
    async cleanup() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const tenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-1",
  addedAt: "2026-07-05T00:00:00.000Z",
  lastUsedAt: "2026-07-05T00:00:00.000Z",
  entraTier: "p1",
};

const agent: AgentSummary = {
  id: "retention-agent",
  slug: "retention-agent",
  name: "Retention Agent",
  description: "Retention test fixture.",
  mode: "read",
  category: "devices",
  tier: "agent",
  requiresEntraTier: "free",
  scopes: [],
  author: { name: "OpenAdminOS", verified: true },
  version: "1.0.0",
  installedAt: "2026-07-05T00:00:00.000Z",
};

function run(
  id: string,
  status: RunRecord["status"],
  queuedAt: string,
): RunRecord {
  return {
    id,
    agentSlug: agent.slug,
    status,
    queuedAt,
    ...(status === "running" ? { startedAt: queuedAt } : {}),
    ...(status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rejected"
      ? { finishedAt: queuedAt }
      : {}),
    providerId: "ollama",
    model: "test-model",
    tenantId: tenant.id,
    summary: `${id} summary`,
    steps: [],
    logs: [],
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
