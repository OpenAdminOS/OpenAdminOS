import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunRecord, TenantRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = { read: async () => "", write: async () => undefined };

const tenant: TenantRecord = {
  id: "tenant-1",
  displayName: "Contoso",
  username: "admin@contoso.example",
  homeAccountId: "home-1",
  addedAt: "2026-07-05T00:00:00.000Z",
  lastUsedAt: "2026-07-05T00:00:00.000Z",
  entraTier: "p1",
};

function run(id: string, executedOn?: RunRecord["executedOn"], summary = id): RunRecord {
  return {
    id,
    agentSlug: "find-inactive-devices",
    status: "completed",
    queuedAt: "2026-11-01T00:00:00.000Z",
    finishedAt: "2026-11-01T00:01:00.000Z",
    tenantId: tenant.id,
    summary,
    steps: [],
    logs: [],
    ...(executedOn ? { executedOn } : {}),
  };
}

const onSandbox = (sandboxId: string): RunRecord["executedOn"] => ({ kind: "sandbox", sandboxId, name: "Office mini PC", organizationId: "org-tenant-1", model: "llama3.1:8b" });

describe("AppStateStore for paired sandboxes", () => {
  it("lists connected organizations with ids, name and tenant id only, and imports sandbox runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-state-sandbox-"));
    const filePath = join(dir, "state.json");
    await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [run("run-desktop")], tenants: [tenant], activeTenantId: tenant.id }));
    const store = new AppStateStore({ filePath, tokenStore, userDataPath: dir, statsApiUrl: "" });
    try {
      const organizations = await store.listConnectedOrganizations();
      assert.equal(organizations.length, 1);
      assert.deepEqual(Object.keys(organizations[0]!).sort(), ["id", "name", "tenantId"]);
      assert.equal(organizations[0]!.tenantId, tenant.id);

      // A desktop run is never replaced, and a run without a sandbox is not taken.
      assert.equal(await store.importSandboxRuns([run("run-desktop", onSandbox("mini-pc")), run("run-plain"), run("run-a", onSandbox("mini-pc"))]), 1);
      assert.equal((await store.getRun("run-desktop"))?.executedOn, undefined);
      assert.equal(await store.getRun("run-plain"), undefined);
      assert.equal((await store.getRun("run-a"))?.executedOn?.kind, "sandbox");

      // The same sandbox updates its run; another sandbox does not.
      assert.equal(await store.importSandboxRuns([run("run-a", onSandbox("mini-pc"), "updated")]), 1);
      assert.equal((await store.getRun("run-a"))?.summary, "updated");
      assert.equal(await store.importSandboxRuns([run("run-a", onSandbox("other-pc"), "other")]), 0);
      assert.equal((await store.getRun("run-a"))?.summary, "updated");
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
