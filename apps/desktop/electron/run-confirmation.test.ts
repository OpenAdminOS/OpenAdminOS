import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  AgentSummary,
  RunRecord,
  WritePlan,
} from "@openadminos/agent-sdk";
import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("write run confirmation", () => {
  it("rejects a wrong confirmation phrase without changing run status", async () => {
    const fixture = await makeStoreFixture({
      run: writeRun({ status: "awaiting-confirmation" }),
    });
    try {
      await assert.rejects(
        () => fixture.store.confirmRun("run-confirm", "offboard 2 devices"),
        /Confirmation phrase does not match/,
      );

      const state = await fixture.store.getAppState();
      assert.equal(state.runs.find((run) => run.id === "run-confirm")?.status, "awaiting-confirmation");
    } finally {
      await fixture.cleanup();
    }
  });

  it("compares confirmation phrases exactly including whitespace", async () => {
    const fixture = await makeStoreFixture({
      run: writeRun({ status: "awaiting-confirmation" }),
    });
    try {
      await assert.rejects(
        () => fixture.store.confirmRun("run-confirm", "OFFBOARD 2 DEVICES "),
        /Confirmation phrase does not match/,
      );

      const state = await fixture.store.getAppState();
      assert.equal(state.runs.find((run) => run.id === "run-confirm")?.status, "awaiting-confirmation");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects the correct phrase when the run is not awaiting confirmation", async () => {
    const fixture = await makeStoreFixture({
      run: writeRun({ status: "running" }),
    });
    try {
      await assert.rejects(
        () => fixture.store.confirmRun("run-confirm", "OFFBOARD 2 DEVICES"),
        /is not awaiting confirmation \(status: running\)/,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("baseline rollback run confirmation", () => {
  it("enforces the exact typed phrase for rollback runs", async () => {
    const fixture = await makeStoreFixture({ run: rollbackRun() });
    try {
      await assert.rejects(
        () => fixture.store.confirmRun("run-rollback", "rollback 1 object"),
        /Confirmation phrase does not match/,
      );
      const state = await fixture.store.getAppState();
      assert.equal(
        state.runs.find((run) => run.id === "run-rollback")?.status,
        "awaiting-confirmation",
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it("confirms a rollback run without any installed agent and fails safe without a tenant", async () => {
    // Rollback runs are host-generated; the installed-agent lookup that
    // gates agent write runs must not apply to them.
    const fixture = await makeStoreFixture({ run: rollbackRun(), agents: [] });
    try {
      const confirmed = await fixture.store.confirmRun(
        "run-rollback",
        "ROLLBACK 1 OBJECT",
      );
      assert.equal(confirmed.status, "running");

      // No tenant is connected in this fixture, so the apply must fail
      // closed before firing any Graph request.
      const terminal = await waitForTerminalRun(fixture.store, "run-rollback");
      assert.equal(terminal?.status, "failed");
      assert.match(terminal?.summary ?? "", /before any action was applied/i);
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a rollback run like any other write plan", async () => {
    const fixture = await makeStoreFixture({ run: rollbackRun(), agents: [] });
    try {
      const rejected = await fixture.store.rejectRun("run-rollback");
      assert.equal(rejected.status, "rejected");
    } finally {
      await fixture.cleanup();
    }
  });
});

async function waitForTerminalRun(
  store: AppStateStore,
  runId: string,
): Promise<RunRecord | undefined> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await store.getAppState();
    const run = state.runs.find((existing) => existing.id === runId);
    if (
      run &&
      ["completed", "failed", "rejected", "cancelled"].includes(run.status)
    ) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return (await store.getAppState()).runs.find((existing) => existing.id === runId);
}

function rollbackRun(): RunRecord {
  return {
    id: "run-rollback",
    agentSlug: "baseline-rollback",
    origin: "baseline-rollback",
    rollback: {
      baselineId: "baseline-1",
      requiredScopes: ["DeviceManagementConfiguration.ReadWrite.All"],
      manualCount: 0,
    },
    status: "awaiting-confirmation",
    queuedAt: "2026-08-29T00:00:00.000Z",
    trigger: "manual",
    summary: "1 object will be rolled back to its baseline state.",
    steps: [],
    logs: [],
    tenantId: "tenant-1",
    plan: {
      summary: "1 object will be rolled back to its baseline state.",
      confirmationPhrase: "ROLLBACK 1 OBJECT",
      actions: [
        {
          id: "rollback-deviceCompliancePolicies-policy-1-modify",
          kind: "graph-write",
          label: "Restore baseline values for BitLocker",
          severity: "default",
          request: {
            method: "PATCH",
            path: "/deviceManagement/deviceCompliancePolicies/policy-1",
            body: { setting: "on" },
          },
        },
      ],
    },
  };
}

async function makeStoreFixture(input: {
  run: RunRecord;
  agents?: AgentSummary[];
}): Promise<{
  store: AppStateStore;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-run-confirmation-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        activeProviderId: "ollama",
        installedAgents: input.agents ?? [writeAgent()],
        runs: [input.run],
        tenants: [],
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
    store,
    async cleanup() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function writeAgent(): AgentSummary {
  return {
    id: "write-confirm-agent",
    slug: "write-confirm-agent",
    name: "Write confirm agent",
    description: "Write confirmation fixture.",
    mode: "write",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: [],
    author: { name: "OpenAdminOS", verified: true },
    version: "1.0.0",
    installedAt: "2026-05-27T00:00:00.000Z",
  };
}

function writeRun(input: { status: RunRecord["status"] }): RunRecord {
  return {
    id: "run-confirm",
    agentSlug: "write-confirm-agent",
    status: input.status,
    queuedAt: "2026-05-27T00:00:00.000Z",
    ...(input.status === "running"
      ? { startedAt: "2026-05-27T00:01:00.000Z" }
      : {}),
    providerId: "ollama",
    model: "test-model",
    summary: "Review the write plan.",
    steps: [],
    logs: [],
    plan: writePlan(),
  };
}

function writePlan(): WritePlan {
  return {
    summary: "This will offboard two devices.",
    confirmationPhrase: "OFFBOARD 2 DEVICES",
    actions: [
      {
        id: "retire-managed-device:0",
        kind: "retire-managed-device",
        label: "Offboard Pilot laptop 1",
        severity: "destructive",
        metadata: { deviceId: "device-1" },
      },
      {
        id: "retire-managed-device:1",
        kind: "retire-managed-device",
        label: "Offboard Pilot laptop 2",
        severity: "destructive",
        metadata: { deviceId: "device-2" },
      },
    ],
  };
}
