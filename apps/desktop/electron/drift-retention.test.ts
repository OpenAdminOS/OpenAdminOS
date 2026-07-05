import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("drift retention", () => {
  it("normalizes persisted settings and validates day bounds", async () => {
    const fixture = await makeStoreFixture({
      driftRetentionDays: { neverPrune: false, keepDays: 900 },
    });
    try {
      assert.deepEqual(await fixture.store.getDriftRetentionSettings(), {
        neverPrune: false,
        keepDays: 180,
      });

      await assert.rejects(
        () =>
          fixture.store.setDriftRetentionSettings({
            neverPrune: false,
            keepDays: 29,
          }),
        /between 30 and 730/,
      );
      const maxDays = await fixture.store.setDriftRetentionSettings({
        neverPrune: false,
        keepDays: 730,
      });
      assert.equal(maxDays.neverPrune, false);
      assert.equal(maxDays.keepDays, 730);
      assert.equal(typeof maxDays.updatedAt, "string");

      const neverPrune = await fixture.store.setDriftRetentionSettings({
        neverPrune: true,
        keepDays: null,
      });
      assert.equal(neverPrune.neverPrune, true);
      assert.equal(neverPrune.keepDays, undefined);
      assert.equal(typeof neverPrune.updatedAt, "string");
    } finally {
      await fixture.cleanup();
    }
  });

  it("prunes SQLite drift history through AppStateStore and records manual result", async () => {
    const fixture = await makeStoreFixture();
    try {
      seedOldDriftHistory(fixture.dir);
      await fixture.store.setDriftRetentionSettings({
        neverPrune: false,
        keepDays: 30,
      });

      const result = await fixture.store.pruneDriftHistoryNow();
      const timeline = await fixture.store.getDriftTimeline({
        tenantId: tenant.id,
        resources: ["configurationPolicies"],
        limit: 10,
      });
      const summary = await fixture.store.getLocalDataSummary(tenant.id);

      assert.equal(result.trigger, "manual");
      assert.equal(result.policy.keepDays, 30);
      assert.ok(result.snapshotsDeleted > 0);
      assert.ok(result.versionsDeleted > 0);
      assert.match(result.reason, /Current object state was kept/);
      assert.equal(timeline.entries.length, 0);
      assert.equal(summary.lastDriftHistoryPrune?.snapshotsDeleted, result.snapshotsDeleted);
      assert.equal(summary.lastDriftHistoryPrune?.versionsDeleted, result.versionsDeleted);
    } finally {
      await fixture.cleanup();
    }
  });

  it("respects never-prune for drift history", async () => {
    const fixture = await makeStoreFixture();
    try {
      seedOldDriftHistory(fixture.dir);
      await fixture.store.setDriftRetentionSettings({
        neverPrune: true,
        keepDays: null,
      });

      const result = await fixture.store.pruneDriftHistoryNow();
      const timeline = await fixture.store.getDriftTimeline({
        tenantId: tenant.id,
        resources: ["configurationPolicies"],
        limit: 10,
      });

      assert.equal(result.snapshotsDeleted, 0);
      assert.equal(result.versionsDeleted, 0);
      assert.equal(result.reason, "Never prune is enabled.");
      assert.ok(timeline.entries.length > 0);
    } finally {
      await fixture.cleanup();
    }
  });
});

async function makeStoreFixture(extraState: Record<string, unknown> = {}): Promise<{
  dir: string;
  store: AppStateStore;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-drift-retention-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        activeProviderId: "ollama",
        installedAgents: [],
        runs: [],
        tenants: [tenant],
        activeTenantId: tenant.id,
        ...extraState,
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
    dir,
    store,
    async cleanup() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function seedOldDriftHistory(dir: string): void {
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  try {
    const resource = "configurationPolicies";
    const label = "Settings catalog policies";
    const scopeSet = ["DeviceManagementConfiguration.Read.All"];
    store.replaceGraphResources({
      tenantId: tenant.id,
      resource,
      label,
      scopeSet,
      refreshedAt: "2000-01-01T00:00:00.000Z",
      rows: [
        { id: "policy-live", displayName: "Live policy", setting: "same" },
        { id: "policy-modified", displayName: "Modified policy", setting: "old" },
      ],
    });
    store.replaceGraphResources({
      tenantId: tenant.id,
      resource,
      label,
      scopeSet,
      refreshedAt: "2000-01-02T00:00:00.000Z",
      rows: [
        { id: "policy-live", displayName: "Live policy", setting: "same" },
        { id: "policy-modified", displayName: "Modified policy", setting: "new" },
      ],
    });
  } finally {
    store.close();
  }
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
