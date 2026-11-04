import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { AgentSummary, RunRecord } from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

const TENANT = {
  id: "tenant-real",
  displayName: "Fabrikam",
  username: "admin@fabrikam.example",
  homeAccountId: "home.tenant-real",
  addedAt: "2026-11-01T00:00:00.000Z",
};

const REASON =
  "descriptor.services: [entra] does not cover DeviceManagementManagedDevices.Read.All; these scopes belong to intune";

function manifest(id: string, services: string): string {
  return `descriptor:
  id: ${id}
  name: ${id}
  description: Lists managed devices.
  version: 1.0.0
  author:
    name: Local
  category: devices
  mode: read
${services}
skills:
  - id: devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      scopes:
        - DeviceManagementManagedDevices.Read.All
definition:
  result:
    summary: Done.
`;
}

function installed(slug: string, registryPath: string): AgentSummary {
  return {
    id: slug,
    slug,
    name: slug,
    description: "Lists managed devices.",
    mode: "read",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
    services: ["intune"],
    author: { name: "Local" },
    version: "1.0.0",
    registryPath,
    installedAt: "2026-11-01T00:00:00.000Z",
    schedule: {
      enabled: true,
      intervalSeconds: 3600,
      notifyOnSuccess: true,
      notifyOnFailure: true,
      notifyOnChangeOnly: false,
      lastScheduledRunAt: "2026-11-01T00:00:00.000Z",
    },
  } as AgentSummary;
}

const HISTORY: RunRecord = {
  id: "run_history",
  agentSlug: "local-devices",
  tenantId: TENANT.id,
  status: "completed",
  queuedAt: "2026-11-02T10:00:00.000Z",
  startedAt: "2026-11-02T10:00:00.000Z",
  finishedAt: "2026-11-02T10:00:05.000Z",
  summary: "Done.",
  steps: [],
  logs: [],
} as unknown as RunRecord;

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-invalid-agent-"));
  const userAgentsDir = join(dir, "agents");
  for (const [folder, services] of [
    ["local-devices", "  services:\n    - intune"],
    // Intune scopes declared under Entra: rejected by the services check.
    ["wrong-services", "  services:\n    - entra"],
  ] as const) {
    await mkdir(join(userAgentsDir, folder), { recursive: true });
    await writeFile(join(userAgentsDir, folder, "manifest.yaml"), manifest(folder, services), "utf8");
  }
  const filePath = join(dir, "state.json");
  await writeFile(
    filePath,
    JSON.stringify({
      activeProviderId: "ollama",
      tenants: [TENANT],
      activeTenantId: TENANT.id,
      runs: [HISTORY],
      installedAgents: [
        installed("local-devices", join(userAgentsDir, "local-devices")),
        installed("wrong-services", join(userAgentsDir, "wrong-services")),
      ],
    }),
    "utf8",
  );
  const store = new AppStateStore({ filePath, tokenStore, userDataPath: dir, userAgentsDir, statsApiUrl: "" });
  return {
    store,
    userAgentsDir,
    async close() {
      store.close();
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

describe("an invalid local agent manifest", () => {
  it("does not stop getAppState from loading tenants, agents and history", async () => {
    const fixture = await makeFixture();
    try {
      const state = await fixture.store.getAppState();
      assert.deepEqual(state.tenants.map((tenant) => tenant.id), [TENANT.id]);
      assert.deepEqual(state.runs.map((run) => run.id), ["run_history"]);
      const slugs = state.registryAgents.map((agent) => agent.slug);
      assert.ok(slugs.includes("local-devices"));
      assert.ok(!slugs.includes("wrong-services"));
      assert.ok(slugs.length > 2, "bundled agents still load");
      assert.deepEqual(
        state.invalidAgents?.map(({ id, folder, manifestPath, reason, source }) => ({ id, folder, manifestPath, reason, source })),
        [{
          id: "wrong-services",
          folder: "wrong-services",
          manifestPath: join(fixture.userAgentsDir, "wrong-services", "manifest.yaml"),
          reason: REASON,
          source: "user",
        }],
      );
      const byslug = new Map(state.installedAgents.map((agent) => [agent.slug, agent]));
      assert.equal(byslug.get("wrong-services")?.manifestError, REASON);
      assert.equal(byslug.get("local-devices")?.manifestError, undefined);
    } finally {
      await fixture.close();
    }
  });

  it("cannot run or have its schedule turned on", async () => {
    const fixture = await makeFixture();
    try {
      await assert.rejects(
        fixture.store.startRun("wrong-services"),
        { message: `wrong-services cannot run or be scheduled because its manifest is invalid. Fix the manifest or uninstall the agent. Reason: ${REASON}` },
      );
      await assert.rejects(
        fixture.store.updateAgentSchedule("wrong-services", { enabled: true, intervalSeconds: 3600 }),
        /cannot run or be scheduled because its manifest is invalid/,
      );
      // Turning the schedule off stays possible.
      const state = await fixture.store.updateAgentSchedule("wrong-services", { enabled: false, intervalSeconds: 3600 });
      assert.equal(state.installedAgents.find((agent) => agent.slug === "wrong-services")?.schedule?.enabled, false);
    } finally {
      await fixture.close();
    }
  });

  it("is skipped by the scheduler without recording a run", async () => {
    const fixture = await makeFixture();
    try {
      const started: string[] = [];
      Object.defineProperty(fixture.store, "startRun", {
        value: async (slug: string) => {
          started.push(slug);
          throw new Error("stop after start");
        },
      });
      await fixture.store.fireDueSchedules();
      assert.deepEqual(started, ["local-devices"]);
      const state = await fixture.store.getAppState();
      assert.equal(state.runs.filter((run) => run.agentSlug === "wrong-services").length, 0);
    } finally {
      await fixture.close();
    }
  });
});
