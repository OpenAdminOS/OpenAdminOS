import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { AppStateStore } from "../state.js";
import {
  GRAPH_CACHE_LOG_ROW_LIMIT,
  GRAPH_CACHE_LOG_WINDOW_DAYS,
  type RunGraphApi,
} from "@openadminos/agent-sdk";

// A large tenant (the first community report came from a school) retains
// far more sign-ins and Intune audit events than a refresh can collect.
// Log resources collect the recent window instead and report a capped
// window as a successful refresh.
it("collects log resources as a capped recent window instead of every retained row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaos-log-window-"));
  const filePath = join(dir, "state.json");
  await writeFile(
    filePath,
    JSON.stringify({
      activeProviderId: "ollama",
      tenants: [
        {
          id: "tenant-1",
          displayName: "School",
          homeAccountId: "test",
          username: "admin@example.invalid",
          addedAt: new Date().toISOString(),
        },
      ],
      activeTenantId: "tenant-1",
      installedAgents: [],
      runs: [],
    }),
  );
  let endless = false;
  const firstQueries = new Map<string, Record<string, string>>();
  const requests = new Map<string, number>();
  const graph = {
    request: async (input: { path: string; query?: Record<string, string> }) => {
      requests.set(input.path, (requests.get(input.path) ?? 0) + 1);
      const page = Number(input.query?.$skiptoken || 0);
      if (page === 0) firstQueries.set(input.path, { ...input.query });
      const size = endless ? 1000 : 50;
      return {
        value: Array.from({ length: size }, (_, i) => ({
          id: `${input.path}-${page}-${i}`,
          createdDateTime: new Date().toISOString(),
          activityDateTime: new Date().toISOString(),
        })),
        ...(endless
          ? { "@odata.nextLink": `https://graph.microsoft.com/beta${input.path}?$skiptoken=${page + 1}` }
          : {}),
      };
    },
  } as unknown as RunGraphApi;
  const store = new AppStateStore({
    filePath,
    userDataPath: dir,
    statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => {} },
    graphFactory: () => graph,
  });
  try {
    // A quiet week: the whole window fits, so the snapshot is complete.
    let result = await store.refreshGraphCache({
      tenantId: "tenant-1",
      resources: ["signIns", "directoryAudits", "intuneAuditEvents"],
    });
    assert.deepEqual(result.resources.map((r) => [r.resource, r.ok, r.pageLimitReached]), [
      ["signIns", true, false],
      ["directoryAudits", true, false],
      ["intuneAuditEvents", true, false],
    ]);
    assert.match(firstQueries.get("/auditLogs/directoryAudits")!.$filter!, /^activityDateTime ge /);
    const signInQuery = firstQueries.get("/auditLogs/signIns")!;
    const intuneQuery = firstQueries.get("/deviceManagement/auditEvents")!;
    assert.match(signInQuery.$filter!, /^createdDateTime ge \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.match(intuneQuery.$filter!, /^activityDateTime ge \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(intuneQuery.$orderby, "activityDateTime desc");
    const since = Date.parse(signInQuery.$filter!.split(" ge ")[1]!);
    const expected = Date.now() - GRAPH_CACHE_LOG_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    assert.ok(Math.abs(since - expected) < 60_000, "the window starts seven days back");

    // A busy tenant: Graph keeps returning pages. The preload stops at the
    // row limit and the window counts as complete, without the "collection
    // limit" error a capped refresh after a complete one used to raise.
    endless = true;
    requests.clear();
    await store.startGraphCachePreload({
      tenantId: "tenant-1",
      resources: ["signIns", "directoryAudits", "intuneAuditEvents"],
    });
    let status = await store.getGraphCacheStatus("tenant-1");
    for (let i = 0; i < 500 && status.preload?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      status = await store.getGraphCacheStatus("tenant-1");
    }
    assert.equal(status.preload?.status, "complete");
    for (const resource of ["signIns", "directoryAudits", "intuneAuditEvents"] as const) {
      const cached = status.resources.find((r) => r.resource === resource)!;
      assert.equal(cached.rows, GRAPH_CACHE_LOG_ROW_LIMIT);
      assert.equal(cached.pageLimitReached, true);
      assert.equal(cached.lastError, undefined);
    }
    assert.equal(requests.get("/auditLogs/signIns"), GRAPH_CACHE_LOG_ROW_LIMIT / 1000);

    // A later refresh of the capped window succeeds the same way.
    result = await store.refreshGraphCache({ tenantId: "tenant-1", resources: ["signIns"] });
    assert.equal(result.resources[0]!.ok, true);
    assert.equal(result.resources[0]!.error, undefined);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("tells the model which window a log snapshot covers, and nothing for other resources", async () => {
  const { logWindowCoverage } = await import("./planner.js");
  assert.match(logWindowCoverage({ resource: "signIns", rows: 10_000, pageLimitReached: true }).coverage!, /^Newest 10,000 entries from the 7 days/);
  assert.match(logWindowCoverage({ resource: "intuneAuditEvents", rows: 40, pageLimitReached: false }).coverage!, /^All entries from the 7 days/);
  assert.deepEqual(logWindowCoverage({ resource: "managedDevices", rows: 1000, pageLimitReached: true }), {});
});

it("drops log snapshots cached before the window policy once, and keeps other resources", async () => {
  const { IntelligenceSqliteStore } = await import("./sqlite-store.js");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = await mkdtemp(join(tmpdir(), "oaos-log-migration-"));
  const dbPath = join(dir, "openadminos.db");
  try {
    const seed = (store: InstanceType<typeof IntelligenceSqliteStore>) => {
      store.replaceGraphResources({
        tenantId: "tenant-1", resource: "signIns", label: "Sign-in logs",
        scopeSet: ["AuditLog.Read.All"], refreshedAt: new Date().toISOString(),
        rows: [{ id: "sign-in-1", createdDateTime: "2026-10-01T00:00:00Z" }],
      });
      store.replaceGraphResources({
        tenantId: "tenant-1", resource: "managedDevices", label: "Intune managed devices",
        scopeSet: ["DeviceManagementManagedDevices.Read.All"], refreshedAt: new Date().toISOString(),
        rows: [{ id: "device-1", deviceName: "PC-1" }],
      });
    };
    let store = new IntelligenceSqliteStore(dbPath);
    seed(store);
    store.close();
    // Simulate a database from before the migration existed.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("DELETE FROM schema_migrations WHERE id = 3").run();
    raw.close();

    store = new IntelligenceSqliteStore(dbPath);
    const resources = () => store.getGraphCacheStatus("tenant-1", [
      { resource: "signIns", label: "Sign-in logs", scopes: ["AuditLog.Read.All"] },
      { resource: "managedDevices", label: "Intune managed devices", scopes: ["DeviceManagementManagedDevices.Read.All"] },
    ]);
    assert.deepEqual(resources().map((r) => [r.resource, r.rows, Boolean(r.refreshedAt)]), [
      ["signIns", 0, false],
      ["managedDevices", 1, true],
    ]);
    // Runs once: a log snapshot taken after the migration survives a reopen.
    seed(store);
    store.close();
    store = new IntelligenceSqliteStore(dbPath);
    assert.equal(resources()[0]!.rows, 1);
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("the shared Chat system prompt states the log window with its limits", async () => {
  const { buildIntuneChatSystemPrompt } = await import("../state-helpers.js");
  for (const local of [true, false]) {
    assert.match(buildIntuneChatSystemPrompt(local), /cached only for the last 7 days before their refreshedAt, newest first, at most 10,000 entries/);
  }
});
