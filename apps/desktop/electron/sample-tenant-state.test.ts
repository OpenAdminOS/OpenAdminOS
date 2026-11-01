import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import type { RunGraphApi } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import {
  SAMPLE_TENANT_HOME_ACCOUNT_ID,
  SAMPLE_TENANT_ID,
  SAMPLE_TENANT_NAME,
  SAMPLE_TENANT_USERNAME,
} from "./sample-tenant/dataset.js";
import { AppStateStore } from "./state.js";

describe("sample tenant state", () => {
  it("adds the sample tenant idempotently and routes Graph without Microsoft auth", async () => {
    const fixture = await makeFixture();
    try {
      const first = await fixture.store.addSampleTenant();
      const second = await fixture.store.addSampleTenant();
      assert.equal(second.tenants.length, 1);
      assert.equal(second.activeTenantId, SAMPLE_TENANT_ID);
      assert.deepEqual(second.tenants[0], {
        ...second.tenants[0],
        id: SAMPLE_TENANT_ID,
        kind: "sample",
        displayName: SAMPLE_TENANT_NAME,
        username: SAMPLE_TENANT_USERNAME,
        homeAccountId: SAMPLE_TENANT_HOME_ACCOUNT_ID,
      });
      assert.equal(second.tenants[0]!.addedAt, first.tenants[0]!.addedAt);
      assert.equal(second.tenants[0]!.appRegistration, undefined);
      const preload = await waitForPreload(fixture.store);
      assert.equal(preload, "complete");

      const privateStore = fixture.store as unknown as {
        buildGraph(tenantId: string, scopes: string[]): Promise<{
          createGraph(log: () => void): {
            request(input: { method: "GET"; path: string }): Promise<unknown>;
          };
          tenantSession: {
            acquireTokenForScopes(scopes: string[]): Promise<string>;
          };
        }>;
      };
      const built = await privateStore.buildGraph(SAMPLE_TENANT_ID, ["User.Read.All"]);
      const users = (await built.createGraph(() => undefined).request({
        method: "GET",
        path: "/users?$top=2",
      })) as { value: unknown[] };
      assert.equal(users.value.length, 2);
      await assert.rejects(
        () => built.tenantSession.acquireTokenForScopes(["User.Read.All"]),
        /Pilot mode has no Microsoft sign-in\. Connect your tenant to use this\./,
      );

      await fixture.store.probeEntraTier(second.tenants[0]!, { force: true });
      assert.equal(fixture.tokenReads, 0);
      assert.equal(fixture.customTokenStores, 0);
    } finally {
      await fixture.close();
    }
  });

  it("refuses schedules, personas, workspaces, and connectors before auth", async () => {
    const fixture = await makeFixture({ withInstalledAgent: true });
    try {
      await fixture.store.addSampleTenant();
      await assert.rejects(
        () =>
          fixture.store.updateAgentSchedule("fixture-agent", {
            intervalSeconds: 3600,
            enabled: true,
          }),
        /Scheduling is available in production\. Connect your tenant to use it\./,
      );
      await assert.rejects(
        () => fixture.store.saveOfficePersona({ tenantId: SAMPLE_TENANT_ID }),
        /Agent Team is available in production\. Connect your tenant to use it\./,
      );
      await assert.rejects(
        () => fixture.store.createWorkspace({ tenantId: SAMPLE_TENANT_ID, title: "Sample" }),
        /Workspaces are available in production\. Connect your tenant to use them\./,
      );
      await assert.rejects(
        () => fixture.store.testConnector("teams"),
        /Connectors are available in production\. Connect your tenant to use them\./,
      );
      await assert.rejects(
        () => fixture.store.listConnectorTeams("teams"),
        /Connectors are available in production\. Connect your tenant to use them\./,
      );
      assert.equal(fixture.tokenReads, 0);
      assert.equal(fixture.customTokenStores, 0);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the injected Graph factory ahead of the built-in sample graph", async () => {
    let factoryCalls = 0;
    const injectedGraph: RunGraphApi = {
      listManagedDevices: async () => [],
      retireManagedDevice: async () => undefined,
      request: async () => ({ source: "injected" }),
    };
    const fixture = await makeFixture({
      graphFactory: () => {
        factoryCalls += 1;
        return injectedGraph;
      },
    });
    try {
      await fixture.store.addSampleTenant();
      const privateStore = fixture.store as unknown as {
        buildGraph(tenantId: string, scopes: string[]): Promise<{
          createGraph(log: () => void): RunGraphApi;
        }>;
      };
      const built = await privateStore.buildGraph(SAMPLE_TENANT_ID, []);
      assert.deepEqual(
        await built.createGraph(() => undefined).request({
          method: "GET",
          path: "/users",
        }),
        { source: "injected" },
      );
      assert.ok(factoryCalls > 0);
    } finally {
      await fixture.close();
    }
  });

  it("resets simulated writes after the sample tenant is removed and added again", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.store.addSampleTenant();
      const privateStore = fixture.store as unknown as {
        buildGraph(tenantId: string, scopes: string[]): Promise<{
          createGraph(log: () => void): RunGraphApi;
        }>;
      };
      const first = (await privateStore.buildGraph(SAMPLE_TENANT_ID, [])).createGraph(
        () => undefined,
      );
      await first.retireManagedDevice("managed-device-001");
      const changed = (await first.request({
        method: "GET",
        path: "/deviceManagement/managedDevices/managed-device-001",
      })) as Record<string, unknown>;
      assert.equal(changed.retired, true);

      await fixture.store.disconnectTenant(SAMPLE_TENANT_ID);
      await fixture.store.addSampleTenant();
      const second = (await privateStore.buildGraph(SAMPLE_TENANT_ID, [])).createGraph(
        () => undefined,
      );
      const restored = (await second.request({
        method: "GET",
        path: "/deviceManagement/managedDevices/managed-device-001",
      })) as Record<string, unknown>;
      assert.equal(restored.retired, false);
      assert.equal(restored.managementState, "managed");
    } finally {
      await fixture.close();
    }
  });

  it("logs skipped due schedules while the sample tenant is active", async () => {
    const fixture = await makeFixture({ withInstalledAgent: true, withSchedule: true, withRealTenant: true });
    const originalInfo = console.info;
    const messages: string[] = [];
    console.info = (...values: unknown[]) => messages.push(values.map(String).join(" "));
    try {
      await fixture.store.addSampleTenant();
      await fixture.store.fireDueSchedules();
      assert.equal((await fixture.store.getAppState()).runs.length, 0);
      assert.ok(
        messages.some((message) =>
          message.includes("[scheduler] skipped 1 due schedule because pilot mode is active"),
        ),
      );
    } finally {
      console.info = originalInfo;
      await fixture.close();
    }
  });

  it("disconnects without MSAL and removes runs and cached rows", async () => {
    const fixture = await makeFixture({ withRun: true });
    try {
      await fixture.store.addSampleTenant();
      await fixture.store.refreshGraphCache({
        tenantId: SAMPLE_TENANT_ID,
        resources: ["users"],
      });
      const before = await fixture.store.getGraphCacheStatus(SAMPLE_TENANT_ID);
      assert.equal(before.resources.find((entry) => entry.resource === "users")?.rows, 80);

      const disconnected = await fixture.store.disconnectTenant(SAMPLE_TENANT_ID);
      assert.equal(disconnected.tenants.length, 0);
      assert.equal(disconnected.runs.length, 0);
      assert.equal(disconnected.activeTenantId, undefined);
      assert.equal(fixture.tokenReads, 0);
      assert.equal(fixture.customTokenStores, 0);

      const persisted = JSON.parse(await readFile(fixture.statePath, "utf8")) as {
        runs: unknown[];
      };
      assert.equal(persisted.runs.length, 0);
      const db = new DatabaseSync(join(fixture.dir, "openadminos.db"), {
        readOnly: true,
      });
      const cached = db
        .prepare("SELECT COUNT(*) AS count FROM graph_resources WHERE tenant_id = ?")
        .get(SAMPLE_TENANT_ID) as { count: number };
      db.close();
      assert.equal(cached.count, 0);
    } finally {
      await fixture.close();
    }
  });
});

async function makeFixture(options: {
  withInstalledAgent?: boolean;
  withSchedule?: boolean;
  withRealTenant?: boolean;
  withRun?: boolean;
  graphFactory?: () => RunGraphApi;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-sample-state-"));
  const statePath = join(dir, "state.json");
  const installedAgents = options.withInstalledAgent
    ? [
        {
          id: "fixture-agent",
          slug: "fixture-agent",
          name: "Fixture agent",
          description: "Fixture",
          mode: "read",
          category: "devices",
          tier: "agent",
          requiresEntraTier: "free",
          scopes: ["User.Read.All"],
          author: { name: "Test" },
          version: "1.0.0",
          installedAt: "2026-10-26T12:00:00.000Z",
          ...(options.withSchedule
            ? {
                schedule: {
                  enabled: true,
                  intervalSeconds: 60,
                  lastScheduledRunAt: "2026-10-26T12:00:00.000Z",
                },
              }
            : {}),
        },
      ]
    : [];
  await writeFile(
    statePath,
    JSON.stringify({
      activeProviderId: "ollama",
      installedAgents,
      tenants: options.withRealTenant
        ? [{
            id: "real-tenant",
            displayName: "Contoso",
            username: "admin@contoso.invalid",
            homeAccountId: "real-account",
            addedAt: "2026-10-25T12:00:00.000Z",
            lastUsedAt: "2026-10-25T12:00:00.000Z",
          }]
        : [],
      runs: options.withRun
        ? [
            {
              id: "sample-run",
              agentSlug: "fixture-agent",
              tenantId: SAMPLE_TENANT_ID,
              status: "completed",
              queuedAt: "2026-10-26T12:00:00.000Z",
              steps: [],
              logs: [],
            },
          ]
        : [],
    }),
    "utf8",
  );
  let tokenReads = 0;
  let customTokenStores = 0;
  const tokenStore: TokenCacheStorage = {
    read: async () => {
      tokenReads += 1;
      return "";
    },
    write: async () => undefined,
  };
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    tokenStoreFor: () => {
      customTokenStores += 1;
      return tokenStore;
    },
    userDataPath: dir,
    statsApiUrl: "",
    ...(options.graphFactory
      ? { graphFactory: () => options.graphFactory!() }
      : {}),
  });
  return {
    dir,
    statePath,
    store,
    get tokenReads() {
      return tokenReads;
    },
    get customTokenStores() {
      return customTokenStores;
    },
    async close() {
      await store.cancelGraphCachePreload(SAMPLE_TENANT_ID).catch(() => undefined);
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function waitForPreload(
  store: AppStateStore,
): Promise<"complete" | "incomplete" | "cancelled" | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await store.getGraphCacheStatus(SAMPLE_TENANT_ID);
    if (status.preload?.status !== "running") return status.preload?.status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Sample tenant cache preload did not finish.");
}
