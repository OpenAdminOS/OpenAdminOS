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

  it("graph_get accepts Entra and Defender read paths with their scopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    try {
      const store = seededStore(dir, 1);
      const graphRequests: Array<{ scopes: string[]; path: string }> = [];
      let currentScopes: string[] = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          graphRequests.push({ scopes: currentScopes, path: input.path });
          return { value: [] };
        },
      };
      const ctx = toolContext(store, {
        graphForScopes: async (scopes) => {
          currentScopes = scopes;
          return graph;
        },
      });

      const cases: Array<{ path: string; scope: string }> = [
        { path: "/identity/conditionalAccess/namedLocations", scope: "Policy.Read.All" },
        { path: "/directoryRoles", scope: "RoleManagement.Read.Directory" },
        { path: "/security/alerts_v2", scope: "SecurityAlert.Read.All" },
        { path: "/security/incidents", scope: "SecurityIncident.Read.All" },
        { path: "/security/secureScores", scope: "SecurityEvents.Read.All" },
      ];
      for (const [index, entry] of cases.entries()) {
        const execution = await executeIntuneChatTool(ctx, "graph_get", {
          path: entry.path,
        });
        assert.equal(execution.trace.error, undefined, `${entry.path} should be allowed`);
        assert.equal(graphRequests[index]?.path, entry.path);
        assert.ok(
          graphRequests[index]?.scopes.includes(entry.scope),
          `${entry.path} should request ${entry.scope}, got ${graphRequests[index]?.scopes.join(", ")}`,
        );
      }
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

  it("query_drift reads local drift timeline rows, clamps top, and records trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    try {
      const store = seededStore(dir, 1);
      const timelineCalls: unknown[] = [];
      const ctx = toolContext(store, {
        getDriftTimeline: async (input) => {
          timelineCalls.push(input);
          return {
            tenantId: "tenant-1",
            limit: 500,
            hasMore: true,
            entries: Array.from({ length: 60 }, (_, index) => ({
              id: `entry-${index}`,
              snapshotId: `snapshot-${index}`,
              capturedAt: `2026-07-05T10:${String(index).padStart(2, "0")}:00.000Z`,
              resource: "configurationPolicies" as const,
              resourceLabel: "Settings catalog policies",
              changeKind: "modified" as const,
              fieldChangeCount: index + 1,
              timestampOnly: false,
              graphId: `policy-${index}`,
              displayName: `Policy ${index}`,
              attribution: {
                status: "matched" as const,
                actor: { userPrincipalName: "admin@contoso.example" },
              },
            })),
          };
        },
      });

      const execution = await executeIntuneChatTool(ctx, "query_drift", {
        resource: "configurationPolicies",
        from: "2026-07-05T00:00:00.000Z",
        to: "2026-07-06T00:00:00.000Z",
        changeKind: "modified",
        top: 500,
      });

      const result = execution.result as {
        returnedRows: number;
        top: number;
        note?: string;
        rows: Array<{ actor: string; kind: string; fieldsChanged: number }>;
      };
      assert.equal(result.top, 50);
      assert.equal(result.returnedRows, 50);
      assert.match(result.note ?? "", /capped at 50 rows/i);
      assert.equal(result.rows[0]?.actor, "admin@contoso.example");
      assert.equal(result.rows[0]?.kind, "modified");
      assert.equal(result.rows[0]?.fieldsChanged, 1);
      assert.equal(execution.trace.tool, "query_drift");
      assert.match(execution.trace.resultSummary, /50 drift changes returned/);
      assert.deepEqual(timelineCalls[0], {
        tenantId: "tenant-1",
        resources: ["configurationPolicies"],
        from: "2026-07-05T00:00:00.000Z",
        to: "2026-07-06T00:00:00.000Z",
        limit: 500,
      });

      const invalid = await executeIntuneChatTool(ctx, "query_drift", {
        resource: "managedDevices",
      });
      assert.match(invalid.trace.error ?? "", /drift-tracked resource/);
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
    getDriftTimeline: Parameters<typeof executeIntuneChatTool>[0]["getDriftTimeline"];
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
    getDriftTimeline:
      overrides.getDriftTimeline ??
      (async () => ({
        tenantId: "tenant-1",
        entries: [],
        hasMore: false,
        limit: 500,
      })),
  };
}

describe("Graph endpoint discovery and reachability", () => {
  it("finds candidate endpoints from plain words so a path need not be recalled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-"));
    try {
      const ctx = toolContext(seededStore(dir, 1));
      const found = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "conditional access named locations",
      });
      const result = found.result as {
        candidates: Array<{ path: string; usable: boolean }>;
      };
      assert.equal(found.trace.error, undefined);
      assert.ok(result.candidates.length > 0, "expected candidate endpoints");
      assert.ok(
        result.candidates.some((entry) => entry.path.includes("namedLocations")),
        `expected a namedLocations path, got ${result.candidates.map((c) => c.path).join(", ")}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps how many candidates are returned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-cap-"));
    try {
      const ctx = toolContext(seededStore(dir, 1));
      const found = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "user",
        limit: 500,
      });
      const result = found.result as { candidates: unknown[] };
      assert.ok(result.candidates.length <= 15);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attempts a read endpoint whose permissions the catalog does not document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-unknown-"));
    try {
      let requested: string | undefined;
      const ctx = toolContext(seededStore(dir, 1), {
        graphForScopes: async () => ({
          async listManagedDevices() {
            return [];
          },
          async retireManagedDevice() {
            throw new Error("write should not run");
          },
          async request(input) {
            requested = input.path;
            return { value: [{ id: "a" }] };
          },
        }),
      });

      // A real catalog path the bundled docs carry no permissions for.
      // Previously rejected as "outside Chat's read-only scope
      // allowlist" purely because of that missing metadata.
      const result = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/admin/edge/internetExplorerMode",
      });

      assert.equal(result.trace.error, undefined, `unexpected error: ${result.trace.error}`);
      assert.equal(requested, "/admin/edge/internetExplorerMode");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an endpoint needing a permission this app never requests, without calling Graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-refuse-"));
    try {
      let called = false;
      const ctx = toolContext(seededStore(dir, 1), {
        graphForScopes: async () => ({
          async listManagedDevices() {
            return [];
          },
          async retireManagedDevice() {
            throw new Error("write should not run");
          },
          async request() {
            called = true;
            return { value: [] };
          },
        }),
      });

      const result = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/me/messages",
      });

      assert.ok(result.trace.error, "reading mail must be refused");
      assert.match(result.trace.error ?? "", /does not request/);
      assert.equal(called, false, "no Graph call may be made for a refused endpoint");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still rejects a path that does not exist in the catalog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-bogus-"));
    try {
      const ctx = toolContext(seededStore(dir, 1));
      const result = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/totallyMadeUpThing",
      });
      assert.match(result.trace.error ?? "", /Unknown Microsoft Graph GET path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an empty query result is not evidence of an empty tenant", () => {
  it("reports the unfiltered row count when a filter matches nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-empty-"));
    try {
      const ctx = toolContext(seededStore(dir, 9));
      const result = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        where: { operatingSystem: "SolarisNotAThing" },
      });
      const record = result.result as {
        returnedRows: number;
        cachedRowsForResource: number;
        availableFields?: string[];
        note: string;
      };
      assert.equal(record.returnedRows, 0);
      assert.equal(
        record.cachedRowsForResource,
        9,
        "the model must be told the resource is populated, or it reports the tenant as empty",
      );
      assert.match(record.note, /not evidence that the tenant has none/i);
      assert.ok(record.availableFields?.includes("operatingSystem"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes an uncached resource from an empty one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-uncached-"));
    try {
      const ctx = toolContext(seededStore(dir, 9));
      const result = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "users",
      });
      const record = result.result as { cachedRowsForResource: number; note: string };
      assert.equal(record.cachedRowsForResource, 0);
      assert.match(record.note, /Nothing is cached/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
