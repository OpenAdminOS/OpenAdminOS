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
    const store = seededStore(dir, 75);
    try {
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
      const count = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', select: ['id'], limit: 1 });
      const projected = count.result as { totalCount: number; rows: Array<{ row: Record<string, unknown> }> };
      assert.equal(projected.totalCount, 75);
      assert.deepEqual(Object.keys(projected.rows[0]!.row), ['id']);

      assert.match(query.trace.resultSummary, /50 of 75 cached rows returned/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("query_cache can count Intune apps by @odata.type for platform questions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 0);
    try {
      store.replaceGraphResources({
        tenantId: "tenant-1",
        resource: "mobileApps",
        label: "Intune apps",
        scopeSet: ["DeviceManagementApps.Read.All"],
        refreshedAt: "2026-06-01T10:00:00.000Z",
        rows: [
          { id: "mac-pkg", displayName: "Mac PKG", "@odata.type": "#microsoft.graph.macOSPkgApp" },
          { id: "mac-dmg", displayName: "Mac DMG", "@odata.type": "#microsoft.graph.macOSDmgApp" },
          { id: "win", displayName: "Win32", "@odata.type": "#microsoft.graph.win32LobApp" },
        ],
      });

      const count = await executeIntuneChatTool(toolContext(store), "query_cache", {
        resource: "mobileApps",
        filters: [{ field: "@odata.type", op: "contains", value: "macOS" }],
        select: ["id", "@odata.type"],
        limit: 1,
      });

      assert.equal(count.trace.error, undefined);
      const result = count.result as {
        totalCount: number;
        rows: Array<{ row: Record<string, unknown> }>;
      };
      assert.equal(result.totalCount, 2);
      assert.match(String(result.rows[0]!.row["@odata.type"]), /macOS/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("list_cached_resources staleness follows per-resource host TTLs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      store.replaceGraphResources({
        tenantId: "tenant-1", resource: "signIns", label: "Sign-in logs",
        scopeSet: ["AuditLog.Read.All"], refreshedAt: anHourAgo,
        rows: [{ id: "sign-in-1" }],
      });
      store.replaceGraphResources({
        tenantId: "tenant-1", resource: "deviceConfigurations", label: "Device configurations",
        scopeSet: ["DeviceManagementConfiguration.Read.All"], refreshedAt: twelveHoursAgo,
        rows: [{ id: "profile-1" }],
      });
      const inventory = await executeIntuneChatTool(toolContext(store), "list_cached_resources", {});
      const resources = (inventory.result as { resources: Array<{ resource: string; stale: boolean }> }).resources;
      assert.equal(resources.find((entry) => entry.resource === "signIns")?.stale, true);
      assert.equal(resources.find((entry) => entry.resource === "deviceConfigurations")?.stale, false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get rejects writes and unknown paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
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
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get validates allowed read scopes, caps $top, and records trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
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
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get omits $top on endpoints that reject it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      // Verified against live Graph via Lokka: the managedDeviceOverview
      // and authenticationMethodsPolicy singletons and the fixed-page-size
      // directoryRoles collection answer 400 to any $top, so the host must
      // not inject its default page size there.
      const noTopPaths = new Map<string, unknown>([
        ["/deviceManagement/managedDeviceOverview", { "@odata.type": "#microsoft.graph.managedDeviceOverview", enrolledDeviceCount: 3 }],
        ["/policies/authenticationMethodsPolicy", { id: "authenticationMethodsPolicy", displayName: "Authentication Methods Policy" }],
        ["/directoryRoles", { value: [{ id: "role-1", displayName: "Global Administrator", roleTemplateId: "template-1" }] }],
      ]);
      const graphRequests: Array<{ path: string; top?: string }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          graphRequests.push({ path: input.path, top: input.query?.$top });
          if (input.query?.$top !== undefined) {
            throw new Error(`HTTP 400: $top is not valid for ${input.path}`);
          }
          return noTopPaths.get(input.path) ?? { value: [] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });

      for (const path of noTopPaths.keys()) {
        const execution = await executeIntuneChatTool(ctx, "graph_get", { path });
        assert.equal(execution.trace.error, undefined, `${path} should not error`);
      }
      assert.deepEqual(
        graphRequests.map((request) => [request.path, request.top]),
        [...noTopPaths.keys()].map((path) => [path, undefined]),
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get allows planner paths whose declared scope is broader than the catalog minimum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      // The bundled catalog lists least-privileged scopes only, so
      // /groups (GroupMember.Read.All declared) and the authentication
      // methods policy (Policy.Read.All declared, documented as a
      // higher-privileged permission) read as unconsented there. Both
      // are planner cache paths refreshed with those scopes, so
      // graph_get must reach Graph instead of refusing up front.
      const scopedRequests: Array<{ scopes: string[]; path: string }> = [];
      let currentScopes: string[] = [];
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request(input) {
          scopedRequests.push({ scopes: currentScopes, path: input.path });
          return { value: [{ id: "row-1" }] };
        },
      };
      const ctx = toolContext(store, {
        graphForScopes: async (scopes) => {
          currentScopes = scopes;
          return graph;
        },
      });

      const groups = await executeIntuneChatTool(ctx, "graph_get", { path: "/groups" });
      assert.equal(groups.trace.error, undefined);
      const authn = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/policies/authenticationMethodsPolicy",
      });
      assert.equal(authn.trace.error, undefined);
      assert.ok(scopedRequests[0]?.scopes.includes("GroupMember.Read.All"));
      assert.ok(scopedRequests[1]?.scopes.includes("Policy.Read.All"));
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get refuses deeper descendants of planner paths that need other scopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      // The planner exemption covers the declared collection and its
      // by-id children. Deeper descendants such as group drives need
      // Files.Read, which Chat never requests, so they must be refused
      // before any Graph call even though /groups itself is exempt.
      let requests = 0;
      const graph: RunGraphApi = {
        async listManagedDevices() {
          return [];
        },
        async retireManagedDevice() {
          throw new Error("write should not run");
        },
        async request() {
          requests += 1;
          return { value: [{ id: "drive-1" }] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const execution = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/groups/11111111-2222-3333-4444-555555555555/drives",
      });
      assert.match(execution.trace.error ?? "", /does not request/);
      assert.equal(requests, 0);

      // The by-id child of the same collection stays allowed with the
      // declared scope.
      let byIdScopes: string[] = [];
      const byIdCtx = toolContext(store, {
        graphForScopes: async (scopes) => {
          byIdScopes = scopes;
          return graph;
        },
      });
      const byId = await executeIntuneChatTool(byIdCtx, "graph_get", {
        path: "/groups/11111111-2222-3333-4444-555555555555",
      });
      assert.equal(byId.trace.error, undefined);
      assert.ok(byIdScopes.includes("GroupMember.Read.All"));
      assert.equal(requests, 1);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get pages directoryRoles without a client page size", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const requests: Array<{ path: string; query?: Record<string, string> }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("write should not run"); },
        async request(input) {
          requests.push({ path: input.path, query: input.query as Record<string, string> | undefined });
          if (!input.query?.$skiptoken) {
            return {
              value: [{ id: "role-1" }, { id: "role-2" }],
              "@odata.nextLink": "https://graph.microsoft.com/beta/directoryRoles?$skiptoken=page-2",
            };
          }
          return { value: [{ id: "role-3" }] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const execution = await executeIntuneChatTool(ctx, "graph_get", { path: "/directoryRoles" });
      const result = execution.result as { returnedRows: number; truncated: boolean };
      assert.equal(execution.trace.error, undefined);
      assert.equal(requests.length, 2);
      assert.equal(requests[0]?.query?.$top, undefined);
      assert.equal(requests[1]?.query?.$skiptoken, "page-2");
      assert.equal(result.returnedRows, 3);
      assert.equal(result.truncated, false);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get names the missing scope and recovery on a live 403", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store, {
        graphForScopes: async () => ({
          async listManagedDevices() { return []; },
          async retireManagedDevice() { throw new Error("write should not run"); },
          async request() {
            throw new Error('Graph GET /users failed (HTTP 403): {"error":{"code":"Authorization_RequestDenied"}}');
          },
        }),
      });
      const execution = await executeIntuneChatTool(ctx, "graph_get", { path: "/users" });
      assert.ok(execution.trace.error, "expected a traced error");
      assert.match(execution.trace.error, /denied read access for GET \/users/);
      assert.match(execution.trace.error, /User\.Read\.All/);
      assert.match(execution.trace.error, /Reconnect the tenant/);
      assert.match(execution.trace.error, /HTTP 403/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("traces a failed refresh_resource as an error, not as evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store, {
        refreshResource: async (resource) => ({
          resource,
          label: resource,
          rows: 0,
          refreshedAt: "2026-06-01T10:01:00.000Z",
          ok: false,
          error: "Microsoft Graph denied read access (HTTP 403).",
        }),
      });
      const execution = await executeIntuneChatTool(ctx, "refresh_resource", {
        resource: "managedDevices",
      });
      assert.match(execution.trace.error ?? "", /HTTP 403/);
      assert.match(execution.trace.resultSummary, /Refresh failed/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get follows a $skip continuation with its full query", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const requests: Array<{ path: string; query?: Record<string, string> }> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("write should not run"); },
        async request(input) {
          requests.push({ path: input.path, query: input.query as Record<string, string> | undefined });
          if (!input.query?.["$skip"]) {
            return {
              value: Array.from({ length: 10 }, (_, index) => ({ id: `user-${index}` })),
              "@odata.nextLink": "https://graph.microsoft.com/beta/users?$skip=10&$select=id,displayName",
            };
          }
          return { value: [{ id: "user-10" }, { id: "user-11" }] };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const execution = await executeIntuneChatTool(ctx, "graph_get", { path: "/users" });
      const result = execution.result as { returnedRows: number; rows: Array<{ id: string }> };
      assert.equal(requests.length, 2);
      assert.equal(requests[1]?.query?.["$skip"], "10");
      assert.equal(requests[1]?.query?.["$select"], "id,displayName");
      assert.equal(result.returnedRows, 12);
      assert.equal(result.rows.at(-1)?.id, "user-11");
      const graphSource = (execution.trace as { graphSource?: { rows: number; pagesFetched?: number } }).graphSource;
      assert.equal(graphSource?.rows, 12);
      assert.equal(graphSource?.pagesFetched, 2);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get follows nextLink pages within the row cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
      const seenSkiptokens: Array<string | undefined> = [];
      const graph: RunGraphApi = {
        async listManagedDevices() { return []; },
        async retireManagedDevice() { throw new Error("write should not run"); },
        async request(input) {
          const token = input.query?.$skiptoken;
          seenSkiptokens.push(token);
          const page = token === "page2" ? 2 : 1;
          return {
            value: Array.from({ length: 30 }, (_, index) => ({
              id: `user-p${page}-${index}`,
              displayName: `User P${page} ${index}`,
            })),
            "@odata.count": 75,
            "@odata.nextLink": `https://graph.microsoft.com/beta/users?$skiptoken=page${page + 1}`,
          };
        },
      };
      const ctx = toolContext(store, { graphForScopes: async () => graph });
      const execution = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/users",
        query: { $select: "id,displayName", $count: "true" },
      });
      const result = execution.result as {
        returnedRows: number;
        truncated: boolean;
        totalCount?: number;
        pagesFetched?: number;
        rows: Array<{ id: string }>;
      };
      assert.deepEqual(seenSkiptokens, [undefined, "page2"]);
      assert.equal(result.returnedRows, 50);
      assert.equal(result.truncated, true);
      assert.equal(result.totalCount, 75);
      assert.equal(result.pagesFetched, 2);
      assert.equal(result.rows.length, 50);
      assert.equal(result.rows[0]?.id, "user-p1-0");
      assert.equal(result.rows[30]?.id, "user-p2-0");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("graph_get accepts Entra and Defender read paths with their scopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
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
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refresh_resource triggers the provided refresh callback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
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
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("query_drift reads local drift timeline rows, clamps top, and records trace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-tools-"));
    const store = seededStore(dir, 1);
    try {
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
      store.close();
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
  it("ranks license inventory for seat questions and returns no unrelated endpoints for unmatched words", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-license-search-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "find_graph_endpoint", { query: "licenses available seats" });
      assert.equal((result.result as { candidates: Array<{ path: string }> }).candidates[0]?.path, "/subscribedSkus");
      const absent = await executeIntuneChatTool(ctx, "find_graph_endpoint", { query: "unmatchablezzzzzz" });
      assert.deepEqual((absent.result as { candidates: unknown[] }).candidates, []);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("reads subscribed SKUs without injecting unsupported paging and rejects unsupported filtering", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-license-query-"));
    const store = seededStore(dir, 1);
    let requests = 0;
    try {
      const ctx = toolContext(store, { graphForScopes: async () => ({
        async request(input) { requests++; assert.deepEqual(input.query, { $select: "skuPartNumber,prepaidUnits,consumedUnits" }); return { value: [{ skuPartNumber: "TEST", prepaidUnits: { enabled: 10 }, consumedUnits: 4 }] }; },
      }) as RunGraphApi });
      const ok = await executeIntuneChatTool(ctx, "graph_get", { path: "/subscribedSkus", query: { $select: "skuPartNumber,prepaidUnits,consumedUnits" } });
      assert.equal(ok.trace.error, undefined);
      const blocked = await executeIntuneChatTool(ctx, "graph_get", { path: "/subscribedSkus", query: { $filter: "consumedUnits eq 0" } });
      assert.match(blocked.trace.error!, /supports only \$select/);
      assert.equal(requests, 1);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("finds candidate endpoints from plain words so a path need not be recalled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
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
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks planner paths usable when their declared scope covers the catalog minimum", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      // /groups and the authentication methods policy are usable through
      // graph_get with planner-declared scopes, so discovery must not
      // steer the model away from them as unconsented.
      const groups = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "groups",
      });
      const groupCandidates = (
        groups.result as { candidates: Array<{ path: string; usable: boolean }> }
      ).candidates;
      const groupsEntry = groupCandidates.find((entry) => entry.path === "/groups");
      assert.ok(groupsEntry, `expected /groups, got ${groupCandidates.map((c) => c.path).join(", ")}`);
      assert.equal(groupsEntry.usable, true);

      const authn = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "authentication methods policy",
      });
      const authnCandidates = (
        authn.result as { candidates: Array<{ path: string; usable: boolean }> }
      ).candidates;
      const authnEntry = authnCandidates.find(
        (entry) => entry.path === "/policies/authenticationMethodsPolicy",
      );
      assert.ok(authnEntry, `expected the policy path, got ${authnCandidates.map((c) => c.path).join(", ")}`);
      assert.equal(authnEntry.usable, true);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("caps how many candidates are returned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-find-cap-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      const found = await executeIntuneChatTool(ctx, "find_graph_endpoint", {
        query: "user",
        limit: 500,
      });
      const result = found.result as { candidates: unknown[] };
      assert.ok(result.candidates.length <= 15);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("attempts a read endpoint whose permissions the catalog does not document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-unknown-"));
    const store = seededStore(dir, 1);
    try {
      let requested: string | undefined;
      const ctx = toolContext(store, {
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
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses an endpoint needing a permission this app never requests, without calling Graph", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-refuse-"));
    const store = seededStore(dir, 1);
    try {
      let called = false;
      const ctx = toolContext(store, {
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
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still rejects a path that does not exist in the catalog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-chat-bogus-"));
    const store = seededStore(dir, 1);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "graph_get", {
        path: "/totallyMadeUpThing",
      });
      assert.match(result.trace.error ?? "", /Unknown Microsoft Graph GET path/);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an empty query result is not evidence of an empty tenant", () => {
  it("reports the unfiltered row count when a filter matches nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-empty-"));
    const store = seededStore(dir, 9);
    try {
      const ctx = toolContext(store);
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
      assert.match(record.note, /not an empty tenant/i);
      assert.match(
        result.trace.resultSummary,
        /9 rows are cached/,
        "the summary must not read as an empty cache when only the filter missed",
      );
      assert.ok(record.availableFields?.includes("operatingSystem"));
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("distinguishes an uncached resource from an empty one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-uncached-"));
    const store = seededStore(dir, 9);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "users",
      });
      const record = result.result as { cachedRowsForResource: number; note: string };
      assert.equal(record.cachedRowsForResource, 0);
      assert.match(record.note, /Nothing is cached/i);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cached rows advertise the fields available to filter on", () => {
  it("lists field names on a successful query, not only after one fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-fields-"));
    const store = seededStore(dir, 5);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "query_cache", {
        resource: "managedDevices",
        limit: 3,
      });
      const record = result.result as {
        returnedRows: number;
        availableFields?: string[];
      };
      assert.ok(record.returnedRows > 0);
      assert.ok(
        record.availableFields?.includes("complianceState"),
        `fields must be advertised on a successful read; got ${JSON.stringify(record.availableFields)}`,
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the cache inventory lean, since it covers every resource at once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-fields-inv-"));
    const store = seededStore(dir, 5);
    try {
      const ctx = toolContext(store);
      const result = await executeIntuneChatTool(ctx, "list_cached_resources", {});
      const record = result.result as {
        resources: Array<{ resource: string; availableFields?: string[] }>;
      };
      assert.ok(record.resources.length > 10);
      assert.ok(
        record.resources.every((entry) => entry.availableFields === undefined),
        "field lists across every resource make this observation too expensive",
      );
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it('rejects invented or malformed filters, preserves optional fields, and handles null as unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cache-filter-guards-'));
  const store = seededStore(dir, 2);
  try {
    const ctx = toolContext(store);
    for (const params of [
      { where: { deviceEncryptionState: 'unencrypted', platform: 'Windows' } },
      { where: { isEncrypted: 'false' } },
      { filters: ['isEncrypted=false'] },
      { filters: { isEncrypted: false } },
      { where: { isEncrypted: {} } },
      { filters: Array.from({ length: 9 }, () => ({ field: 'id', op: 'eq', value: 'device-1' })) },
      { sort: { field: 'platform' } },
      { filter: { isEncrypted: false } },
      { where: { isEncrypted: false }, select: ['platform'] },
    ]) {
      const result = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', ...params });
      assert.equal((result.result as { code: string }).code, 'invalid-cache-query', JSON.stringify(params));
      assert.ok(result.trace.error);
      assert.equal((result.result as { totalCount?: number }).totalCount, undefined);
    }
    // isEncrypted is a supported selected field even when every record omits it.
    const unknown = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', where: { isEncrypted: null } });
    assert.equal(unknown.trace.error, undefined);
    assert.equal((unknown.result as { totalCount: number }).totalCount, 2);
    const known = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', filters: [{ field: 'isEncrypted', op: 'neq', value: null }] });
    assert.equal((known.result as { totalCount: number }).totalCount, 0);
    assert.doesNotMatch((known.result as { note: string }).note, /field or value that does not exist/);
    assert.ok((known.result as { snapshot: unknown }).snapshot);
    store.replaceGraphResources({ tenantId: 'tenant-1', resource: 'managedDevices', label: 'Devices', scopeSet: [], refreshedAt: new Date().toISOString(), rows: [{ id: 'first' }, { id: 'second', optionalField: 'present' }] });
    const optional = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'managedDevices', where: { optionalField: 'present' } });
    assert.equal(optional.trace.error, undefined);
    assert.equal((optional.result as { totalCount: number }).totalCount, 1);
    store.replaceGraphResources({ tenantId: 'tenant-1', resource: 'users', label: 'Users', scopeSet: [], refreshedAt: new Date().toISOString(), rows: [{ id: 'user-1', accountEnabled: false }] });
    const invalidBoolean = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'users', where: { accountEnabled: 'false' } });
    assert.match(invalidBoolean.trace.error!, /boolean field/);
    const validBoolean = await executeIntuneChatTool(ctx, 'query_cache', { resource: 'users', where: { accountEnabled: false } });
    assert.equal((validBoolean.result as { totalCount: number }).totalCount, 1);

  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
