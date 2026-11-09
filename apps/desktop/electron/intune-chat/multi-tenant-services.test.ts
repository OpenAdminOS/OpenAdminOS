import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { RunGraphApi, TenantRecord } from "@openadminos/agent-sdk";
import { AppStateStore } from "../state.js";

const PROMPT = "Compare Windows compliance across tenants";
const NOW = new Date().toISOString();

function tenant(id: string, displayName: string, grantedScopes?: string[]): TenantRecord {
  return {
    id,
    displayName,
    username: `admin@${id}.example`,
    homeAccountId: `home.${id}`,
    addedAt: NOW,
    ...(grantedScopes ? { grantedScopes } : {}),
  };
}

function stateJson(tenants: TenantRecord[]): string {
  return JSON.stringify({
    activeProviderId: "ollama",
    activeModelByProviderId: { ollama: "mock-chat" },
    installedAgents: [],
    runs: [],
    tenants,
    activeTenantId: tenants[0]!.id,
  });
}

async function makeFixture(tenants: TenantRecord[]) {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-mt-services-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, stateJson(tenants));
  const graphTenants: string[] = [];
  const graphFor = (tenantId: string): RunGraphApi => ({
    async listManagedDevices() { return []; },
    async retireManagedDevice() { throw new Error("No writes in this test."); },
    async request() {
      graphTenants.push(tenantId);
      return {
        value: [{
          id: `${tenantId}-pc`,
          deviceName: `${tenantId}-PC-1`,
          operatingSystem: "Windows",
          complianceState: "compliant",
          lastSyncDateTime: NOW,
        }],
      };
    },
  });
  const store = new AppStateStore({
    filePath,
    userDataPath: dir,
    statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    graphFactory: ({ tenantId }) => graphFor(tenantId),
    llmFactory: () => ({
      available: false,
      defaultModel: "mock-chat",
      async complete() { throw new Error("Not used."); },
      async *stream() { yield { delta: "", accumulated: "", done: true, model: "mock-chat" }; },
    }),
  });
  store.listProviders = async () => [
    { id: "ollama", name: "Ollama", description: "Local", isLocal: true, status: "connected", models: ["mock-chat"], defaultModel: "mock-chat" },
  ];
  return {
    store,
    filePath,
    graphTenants,
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("multi-tenant Chat and connected services", () => {
  it("treats a tenant granted only User.Read as missing Intune access", async () => {
    const fixture = await makeFixture([tenant("fabrikam", "Fabrikam", ["graph:User.Read"])]);
    try {
      const preflight = await fixture.store.preflightMultiTenantIntuneChat({ prompt: PROMPT, tenantScope: { kind: "all" } });
      const row = preflight.tenants[0]!;
      assert.equal(row.status, "missing-scopes");
      assert.ok(row.missingScopes.includes("DeviceManagementManagedDevices.Read.All"));
      assert.ok(!row.missingScopes.includes("User.Read"));
      assert.match(row.recovery, /Intune and Entra are not connected for this tenant\. Add them in Connections\./);
      assert.match(row.warnings[0] ?? "", /^Not included: .*Intune managed devices/);
      assert.deepEqual(row.staleResources, []);
      assert.equal(preflight.canRun, false);
      assert.deepEqual(fixture.graphTenants, []);
    } finally {
      await fixture.close();
    }
  });

  it("never reports old cache rows of a removed service as a current result", async () => {
    const fixture = await makeFixture([tenant("contoso", "Contoso"), tenant("fabrikam", "Fabrikam")]);
    try {
      await fixture.store.refreshGraphCache({ tenantId: "fabrikam", resources: ["managedDevices"] });
      assert.deepEqual(fixture.graphTenants, ["fabrikam"]);
      // Intune access is removed after the rows were cached.
      writeFileSync(fixture.filePath, stateJson([tenant("contoso", "Contoso"), tenant("fabrikam", "Fabrikam", ["graph:User.Read"])]));
      fixture.graphTenants.length = 0;

      const preflight = await fixture.store.preflightMultiTenantIntuneChat({ prompt: PROMPT, tenantScope: { kind: "all" } });
      const fabrikam = preflight.tenants.find((row) => row.tenantId === "fabrikam")!;
      assert.equal(fabrikam.status, "missing-scopes");
      assert.match(fabrikam.recovery, /Intune and Entra are not connected/);
      assert.equal(preflight.canRun, true);

      const { job } = await fixture.store.runMultiTenantIntuneChat({ prompt: PROMPT, tenantScope: { kind: "all" } });
      assert.equal(job.status, "partial");
      assert.ok(!fixture.graphTenants.includes("fabrikam"));
      assert.ok(job.deviceRows.every((row) => row.tenantId !== "fabrikam"));
      const comparison = job.comparisons.find((row) => row.tenantId === "fabrikam")!;
      assert.equal(comparison.status, "missing-scopes");
      assert.equal(comparison.windowsDevices, 0);
      assert.equal(job.progress.find((row) => row.tenantId === "fabrikam")?.status, "skipped");
      // Contoso was read in this run; its status follows its preflight freshness.
      assert.equal(job.comparisons.find((row) => row.tenantId === "contoso")?.windowsDevices, 1);
    } finally {
      await fixture.close();
    }
  });

  it("shows a refresh skip as a skipped tenant, not an empty scan", async () => {
    const fixture = await makeFixture([tenant("contoso", "Contoso"), tenant("fabrikam", "Fabrikam")]);
    try {
      const { job } = await fixture.store.runMultiTenantIntuneChat(
        { prompt: PROMPT, tenantScope: { kind: "all" } },
        (event) => {
          // Intune access is removed between preflight and refresh.
          if (event.type !== "started") return;
          writeFileSync(fixture.filePath, stateJson([tenant("contoso", "Contoso"), tenant("fabrikam", "Fabrikam", ["graph:User.Read"])]));
        },
      );
      assert.equal(job.status, "partial");
      assert.ok(!fixture.graphTenants.includes("fabrikam"));
      const comparison = job.comparisons.find((row) => row.tenantId === "fabrikam")!;
      assert.equal(comparison.status, "skipped");
      assert.match(comparison.warnings[0] ?? "", /^Not included: .*Intune managed devices.*Intune and Entra are not connected for this tenant\./);
      const progress = job.progress.find((row) => row.tenantId === "fabrikam")!;
      assert.equal(progress.status, "skipped");
      assert.match(progress.detail ?? "", /Intune and Entra are not connected/);
      assert.equal(job.summary.skippedTenants, 1);
      // Contoso was read in this run; its status follows its preflight freshness.
      assert.equal(job.comparisons.find((row) => row.tenantId === "contoso")?.windowsDevices, 1);
    } finally {
      await fixture.close();
    }
  });
});
