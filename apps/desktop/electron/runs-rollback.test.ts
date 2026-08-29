import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  GraphRequestInput,
  RunGraphApi,
  RunRecord,
  TenantSession,
} from "@openadminos/agent-sdk";

import { RunService, type RunPersistedState, type RunServiceHost } from "./runs.js";

interface HarnessOptions {
  failOnRequestIndex?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const requests: GraphRequestInput[] = [];
  const persisted: RunPersistedState = {
    activeProviderId: "ollama",
    installedAgents: [],
    runs: [],
    tenants: [
      {
        id: "tenant-1",
        displayName: "Contoso",
        username: "admin@contoso.example",
        homeAccountId: "home-1",
        addedAt: "2026-08-29T00:00:00.000Z",
      },
    ],
    activeTenantId: "tenant-1",
  };
  const graph: RunGraphApi = {
    async listManagedDevices() {
      return [];
    },
    async retireManagedDevice() {
      throw new Error("not used");
    },
    async request(input) {
      if (
        options.failOnRequestIndex !== undefined &&
        requests.length === options.failOnRequestIndex
      ) {
        requests.push(input);
        throw new Error("Graph responded with HTTP 400 for test purposes.");
      }
      requests.push(input);
      return {};
    },
  };
  const host = {
    read: async () => persisted,
    write: async (next: RunPersistedState) => {
      persisted.runs = next.runs;
    },
    serialize: async <T>(task: () => Promise<T>) => task(),
    listProviders: async () => [],
    providerCanRun: () => true,
    buildLlm: async () => {
      throw new Error("LLM must not be used by rollback apply.");
    },
    buildGraph: async (pinnedTenantId?: string) => ({
      createGraph: () => graph,
      tenantId: pinnedTenantId ?? "tenant-1",
      tenantSession: {} as TenantSession,
    }),
    readConnectorConfigs: async () => ({}),
    connectorSecretsFor: () => ({}) as never,
    selfTrainingPromptOverlay: () => undefined,
    recordLearningEventSafely: () => undefined,
    notifyRunFinished: () => undefined,
    emitStateChanged: () => undefined,
    enqueueRunDeliveries: async () => undefined,
    processPendingRunDeliveries: async () => undefined,
    appVersion: "0.5.0-test",
    intelligenceStore: undefined,
  } as unknown as RunServiceHost;

  return { service: new RunService(host), persisted, requests };
}

function planWithActions(count: number) {
  return {
    summary: `${count} objects will be rolled back to their baseline state.`,
    confirmationPhrase: `ROLLBACK ${count} ${count === 1 ? "OBJECT" : "OBJECTS"}`,
    actions: Array.from({ length: count }, (_, index) => ({
      id: `rollback-action-${index}`,
      kind: "graph-write",
      label: `Restore object ${index}`,
      severity: "default" as const,
      request: {
        method: "PATCH" as const,
        path: `/deviceManagement/deviceCompliancePolicies/policy-${index}`,
        body: { setting: `baseline-${index}` },
      },
    })),
  };
}

async function waitForTerminal(
  persisted: RunPersistedState,
  runId: string,
): Promise<RunRecord | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const run = persisted.runs.find((existing) => existing.id === runId);
    if (run && ["completed", "failed"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return persisted.runs.find((existing) => existing.id === runId);
}

describe("rollback apply", () => {
  it("applies confirmed actions strictly in order and records each step", async () => {
    const { service, persisted, requests } = makeHarness();
    const queued = await service.startRollbackRun({
      tenantId: "tenant-1",
      baselineId: "baseline-1",
      plan: planWithActions(2),
      requiredScopes: ["DeviceManagementConfiguration.ReadWrite.All"],
      manualCount: 1,
    });
    assert.equal(queued.status, "awaiting-confirmation");
    assert.equal(requests.length, 0, "nothing applies before confirmation");

    await service.confirmRun(queued.id, "ROLLBACK 2 OBJECTS");
    const run = await waitForTerminal(persisted, queued.id);

    assert.equal(run?.status, "completed");
    assert.deepEqual(
      requests.map((request) => request.path),
      [
        "/deviceManagement/deviceCompliancePolicies/policy-0",
        "/deviceManagement/deviceCompliancePolicies/policy-1",
      ],
    );
    assert.deepEqual(
      run?.steps.map((step) => step.status),
      ["completed", "completed"],
    );
    assert.match(run?.summary ?? "", /2 objects rolled back/);
    assert.match(run?.summary ?? "", /1 change still need/);
  });

  it("stops at the first failed action and never fires later requests", async () => {
    const { service, persisted, requests } = makeHarness({ failOnRequestIndex: 1 });
    const queued = await service.startRollbackRun({
      tenantId: "tenant-1",
      baselineId: "baseline-1",
      plan: planWithActions(3),
      requiredScopes: [],
      manualCount: 0,
    });
    await service.confirmRun(queued.id, "ROLLBACK 3 OBJECTS");
    const run = await waitForTerminal(persisted, queued.id);

    assert.equal(run?.status, "failed");
    assert.equal(requests.length, 2, "third request must never fire");
    assert.match(run?.summary ?? "", /applying 1 of 3 actions/);
    assert.deepEqual(
      run?.steps.map((step) => step.status),
      ["completed", "failed"],
    );
  });

  it("refuses to queue a rollback with no automatable actions", async () => {
    const { service } = makeHarness();
    await assert.rejects(
      service.startRollbackRun({
        tenantId: "tenant-1",
        baselineId: "baseline-1",
        plan: { summary: "s", confirmationPhrase: "ROLLBACK 0 OBJECTS", actions: [] },
        requiredScopes: [],
        manualCount: 3,
      }),
      /No drifted objects can be rolled back automatically/,
    );
  });
});

describe("external gateway proposal apply", () => {
  it("queues, gates, and applies an external proposal through the same path", async () => {
    const { service, persisted, requests } = makeHarness();
    const queued = await service.startExternalProposalRun({
      tenantId: "tenant-1",
      clientName: "Claude Code",
      requiredScopes: ["DeviceManagementConfiguration.ReadWrite.All"],
      plan: {
        summary: "Claude Code proposes 1 change: rename",
        confirmationPhrase: "APPLY 1 CHANGE",
        actions: [
          {
            id: "proposal-0",
            kind: "graph-write",
            label: "Rename policy",
            severity: "default",
            request: {
              method: "PATCH",
              path: "/deviceManagement/deviceCompliancePolicies/policy-1",
              body: { displayName: "Renamed" },
            },
          },
        ],
      },
    });
    assert.equal(queued.status, "awaiting-confirmation");
    assert.equal(queued.origin, "external-proposal");
    assert.equal(requests.length, 0, "external proposals never self-apply");

    // A wrong phrase must not apply anything.
    await assert.rejects(
      service.confirmRun(queued.id, "apply 1 change"),
      /Confirmation phrase does not match/,
    );
    assert.equal(requests.length, 0);

    await service.confirmRun(queued.id, "APPLY 1 CHANGE");
    const run = await waitForTerminal(persisted, queued.id);
    assert.equal(run?.status, "completed");
    assert.equal(requests.length, 1);
    assert.match(run?.summary ?? "", /1 proposed change applied/);
  });

  it("refuses to queue an empty proposal", async () => {
    const { service } = makeHarness();
    await assert.rejects(
      service.startExternalProposalRun({
        tenantId: "tenant-1",
        clientName: "Claude Code",
        requiredScopes: [],
        plan: { summary: "s", confirmationPhrase: "APPLY 0 CHANGES", actions: [] },
      }),
      /needs at least one action/,
    );
  });
});
