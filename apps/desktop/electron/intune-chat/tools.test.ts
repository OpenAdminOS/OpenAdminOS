import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { GraphCacheResourceKind, RunGraphApi } from "@openadminos/agent-sdk";

import { executeIntuneChatTool } from "./tools.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";

describe("Intune Chat read-only tools", () => {
  it("lists cache inventory and query_cache enforces row caps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    try {
      const store = seededStore(dir, 75);
      const ctx = toolContext(store);

      const inventory = await executeIntuneChatTool(ctx, "list_cached_resources", {});
      assert.equal(inventory.trace.tool, "list_cached_resources");
      assert.match(inventory.trace.resultSummary, /cache resources listed/);
      assert.equal(inventory.trace.error, undefined);

      const query = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        filters: [{ field: "operatingSystem", op: "eq", value: "Windows" }],
        sort: { field: "displayName", direction: "asc" },
        limit: 500,
      });
      const result = query.result as {
        totalCount: number;
        returnedRows: number;
        limit: number;
        rows: unknown[];
      };
      assert.equal(result.totalCount, 75);
      assert.equal(result.returnedRows, 50);
      assert.equal(result.limit, 50);
      assert.equal(result.rows.length, 50);
      assert.match(query.trace.resultSummary, /50 of 75 cached rows returned/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get rejects writes and unknown paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    try {
      const store = seededStore(dir, 1);
      const ctx = toolContext(store);

      const write = await executeIntuneChatTool(ctx, "graph_get", {
        method: "POST",
        path: "/users",
      });
      assert.equal(write.trace.error, "graph_get is read-only. Only GET is accepted.");

      const unknown = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/openAdminOS/not-real",
      });
      assert.match(unknown.trace.error ?? "", /Unknown Microsoft Graph GET path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get validates allowed read scopes, caps $top, and records trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    try {
      const store = seededStore(dir, 1);
      const graphRequests: Array<{ scopes: string[]; path: string; top?: string }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          graphRequests.push({
            scopes: currentScopes,
            path: input.path,
            top: input.query?.$top,
          });
          return {
            value: Array.from({ length: 60 }, (_, index) => ({
              id: `user-${index}`,
              displayName: `User ${index}`,
            })),
            "@odata.nextLink": "https://graph.microsoft.com/beta/users?$skiptoken=next",
          };
        },
      };
      let currentScopes: string[] = [];
      const ctx = toolContext(store, {
        graphForScopes: async (scopes) => {
          currentScopes = scopes;
          return graph;
        },
      });

      const execution = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/users",
        query: { $top: "500", $select: "id,displayName" },
      });
      const result = execution.result as {
        returnedRows: number;
        rowCountInPage: number;
        truncated: boolean;
      };
      assert.equal(graphRequests[0]?.path, "/users");
      assert.equal(graphRequests[0]?.top, "50");
      assert.ok(graphRequests[0]?.scopes.includes("User.Read.All"));
      assert.equal(result.returnedRows, 50);
      assert.equal(result.rowCountInPage, 60);
      assert.equal(result.truncated, true);
      assert.equal(execution.trace.tool, "graph_get");
      assert.match(execution.trace.resultSummary, /live rows returned/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refresh_resource triggers the provided refresh callback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    try {
      const store = seededStore(dir, 1);
      const refreshed: GraphCacheResourceKind[] = [];
      const ctx = toolContext(store, {
        refreshResource: async (resource) => {
          refreshed.push(resource);
          return {
            resource,
            label: "Intune managed devices",
            rows: 3,
            refreshedAt: "2026-06-01T10:02:00.000Z",
            ok: true,
          };
        },
      });

      const execution = await executeIntuneChatTool(ctx, "refresh_resource", {
        resource: "managedDevices",
      });
      assert.deepEqual(refreshed, ["managedDevices"]);
      assert.equal(execution.trace.tool, "refresh_resource");
      assert.match(execution.trace.resultSummary, /3 rows refreshed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function seededStore(dir: string, deviceCount: number): IntelligenceSqliteStore {
  const store = new IntelligenceSqliteStore(join(dir, "openadminos.db"));
  store.replaceGraphResources({
    tenantId: "tenant-1",
    resource: "managedDevices",
    label: "Intune managed devices",
    scopeSet: ["DeviceManagementManagedDevices.Read.All"],
    refreshedAt: "2026-06-01T10:00:00.000Z",
    rows: Array.from({ length: deviceCount }, (_, index) => ({
      id: `device-${index}`,
      deviceName: `WIN-${String(index).padStart(2, "0")}`,
      displayName: `WIN-${String(index).padStart(2, "0")}`,
      operatingSystem: "Windows",
      complianceState: index % 2 === 0 ? "compliant" : "noncompliant",
      lastSyncDateTime: "2026-06-01T09:00:00.000Z",
    })),
  });
  return store;
}

function toolContext(
  store: IntelligenceSqliteStore,
  overrides: Partial<{
    graphForScopes: Parameters<typeof executeIntuneChatTool>[0]["graphForScopes"];
    refreshResource: Parameters<typeof executeIntuneChatTool>[0]["refreshResource"];
  }> = {},
): Parameters<typeof executeIntuneChatTool>[0] {
  return {
    tenantId: "tenant-1",
    store,
    graphForScopes:
      overrides.graphForScopes ??
      (async () => ({
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request() {
          return { value: [] };
        },
      })),
    refreshResource:
      overrides.refreshResource ??
      (async (resource) => ({
        resource,
        label: resource,
        rows: 0,
        refreshedAt: "2026-06-01T10:01:00.000Z",
        ok: true,
      })),
  };
}
