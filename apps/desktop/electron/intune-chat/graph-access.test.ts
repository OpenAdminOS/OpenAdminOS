import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { GraphAccessDeniedError, type GraphAccessContext, type RunGraphApi } from "@openadminos/agent-sdk";
import { AppStateStore } from "../state.js";

it("persists each cache denial and keeps consent, role, and licence readiness distinct", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oaos-access-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [], activeTenantId: "tenant", tenants: [
    { id: "tenant", displayName: "Test", username: "reader", homeAccountId: "account", addedAt: new Date().toISOString() },
  ] }));
  let evidence: GraphAccessContext | undefined;
  let succeed = false;
  const graph: RunGraphApi = {
    async listManagedDevices() { return []; },
    async retireManagedDevice() { throw new Error("No writes in this test"); },
    async request() {
      if (succeed) return { value: [{ id: "device" }] };
      if (evidence) throw new GraphAccessDeniedError(evidence);
      throw new Error("HTTP 403 Forbidden");
    },
  };
  const options = { filePath, userDataPath: dir, statsApiUrl: "", tokenStore: { read: async () => "", write: async () => {} }, graphFactory: () => graph };
  let store = new AppStateStore(options);
  const stubProviders = () => { store.listProviders = async () => [{ id: "ollama", name: "Ollama", description: "Local", isLocal: true, status: "connected", models: ["test"], defaultModel: "test" }]; };
  stubProviders();
  try {
    for (const [cause, context] of [
      ["missing-consent", { grantedScopes: [] }],
      ["missing-role", { grantedScopes: ["DeviceManagementManagedDevices.Read.All"] }],
      ["missing-licence", { intuneLicensed: false }],
      ["unknown", undefined],
    ] as const) {
      evidence = context ? { ...context, path: "/deviceManagement/managedDevices", requiredScopes: ["DeviceManagementManagedDevices.Read.All"] } : undefined;
      const refreshed = await store.refreshGraphCache({ resources: ["managedDevices"] });
      assert.equal(refreshed.resources[0]?.accessDenial?.cause, cause);
      if (cause !== "missing-consent") assert.doesNotMatch(refreshed.resources[0]?.error ?? "", /reconnect/i);
      store.close();
      store = new AppStateStore(options);
      stubProviders();
      const cached = (await store.getGraphCacheStatus("tenant")).resources.find(row => row.resource === "managedDevices")!;
      assert.equal(cached.accessDenial?.cause, cause);
      const preflight = await store.preflightMultiTenantIntuneChat({ prompt: "Show managed devices", tenantScope: { kind: "all" } });
      const tenant = preflight.tenants[0]!;
      assert.equal(tenant.accessDenials?.[0]?.cause, cause);
      if (cause === "missing-consent") {
        assert.equal(tenant.status, "missing-scopes");
        assert.deepEqual(tenant.missingScopes, ["DeviceManagementManagedDevices.Read.All"]);
        assert.match(tenant.recovery, /Reconnect/);
      } else {
        assert.notEqual(tenant.status, "missing-scopes");
        assert.deepEqual(tenant.missingScopes, []);
        assert.doesNotMatch(tenant.recovery, /reconnect/i);
      }
    }
    succeed = true;
    await store.refreshGraphCache({ resources: ["managedDevices"] });
    const cached = (await store.getGraphCacheStatus("tenant")).resources.find(row => row.resource === "managedDevices")!;
    assert.equal(cached.accessDenial, undefined);
    assert.equal(cached.lastError, undefined);
    assert.equal(cached.rows, 1);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
