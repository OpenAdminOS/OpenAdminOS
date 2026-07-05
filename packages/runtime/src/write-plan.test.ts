import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type {
  AgentSummary,
  ManagedDeviceRecord,
  RunContext,
  RunGraphApi,
  RunLlmApi,
  RunStatus,
  WritePlan,
} from "@openadminos/agent-sdk";

import { createQueuedRun, executeApply, executePlan, executeRun } from "./index.js";
import { createSandboxBroker } from "./sandbox-broker.js";

describe("write plan safety", () => {
  it("completes write agents whose plan has zero actions", async () => {
    const fixture = makeWriteAgentFixture({
      slug: "empty-write-agent",
      name: "Empty write agent",
      description: "Test write agent with no matching actions.",
      devices: [],
      llmText: "No stale devices matched the configured policy.",
    });
    try {
      const progress: RunStatus[] = [];
      const completed = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress(next) {
          progress.push(next.status);
        },
      });

      assert.equal(completed.status, "completed");
      assert.equal(completed.plan?.actions.length, 0);
      assert.equal(completed.error, undefined);
      assert.deepEqual(completed.result, {
        mode: "simulated",
        total: 0,
        successCount: 0,
        failureCount: 0,
        skippedReason: "No write actions matched the current tenant inventory.",
      });
      assert.equal(fixture.retireCalls.length, 0);
      assert.ok(!progress.includes("awaiting-confirmation"));
      assert.ok(
        completed.logs.some((log) =>
          log.message === "Plan ready (0 actions). No confirmation required.",
        ),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("pauses non-empty write plans with rendered confirmation phrase and action metadata", async () => {
    const fixture = makeWriteAgentFixture({
      devices: [
        managedDevice("device-1", "Pilot laptop 1", "SERIAL-1"),
        managedDevice("device-2", "Pilot laptop 2", "SERIAL-2"),
      ],
      llmText: "Review complete. Two devices are ready to offboard.",
    });
    try {
      const progress: RunStatus[] = [];
      const planned = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress(next) {
          progress.push(next.status);
        },
      });

      assert.equal(planned.status, "awaiting-confirmation");
      assert.equal(planned.summary, "Review complete. Two devices are ready to offboard.");
      assert.equal(planned.plan?.summary, "Review complete. Two devices are ready to offboard.");
      assert.equal(planned.plan?.confirmationPhrase, "OFFBOARD 2 DEVICES");
      assert.equal(planned.plan?.actions.length, 2);
      assert.deepEqual(planned.plan?.actions[0], {
        id: "retire-managed-device:0",
        kind: "retire-managed-device",
        label: "Offboard Pilot laptop 1",
        severity: "destructive",
        description: "Retire managed device Pilot laptop 1 from Intune.",
        metadata: {
          deviceId: "device-1",
          deviceName: "Pilot laptop 1",
          serialNumber: "SERIAL-1",
        },
      });
      assert.deepEqual(planned.plan?.actions[1]?.metadata, {
        deviceId: "device-2",
        deviceName: "Pilot laptop 2",
        serialNumber: "SERIAL-2",
      });
      assert.equal(fixture.retireCalls.length, 0);
      assert.equal(fixture.llmRequests.length, 1);
      assert.ok(progress.includes("awaiting-confirmation"));
      assert.ok(
        planned.logs.some((log) =>
          log.message === "Plan ready (2 actions). Awaiting typed confirmation.",
        ),
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("renders the confirmation phrase from the actual action count", async () => {
    const fixture = makeWriteAgentFixture({
      devices: [
        managedDevice("device-1", "Pilot laptop 1", "SERIAL-1"),
        managedDevice("device-2", "Pilot laptop 2", "SERIAL-2"),
        managedDevice("device-3", "Pilot laptop 3", "SERIAL-3"),
      ],
    });
    try {
      const planned = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress() {},
      });

      assert.equal(planned.status, "awaiting-confirmation");
      assert.equal(planned.plan?.actions.length, 3);
      assert.equal(planned.plan?.confirmationPhrase, "OFFBOARD 3 DEVICES");
    } finally {
      fixture.cleanup();
    }
  });

  it("executes Graph writes only in the apply phase after a plan exists", async () => {
    const fixture = makeWriteAgentFixture({
      devices: [
        managedDevice("device-1", "Pilot laptop 1", "SERIAL-1"),
        managedDevice("device-2", "Pilot laptop 2", "SERIAL-2"),
      ],
    });
    try {
      const planned = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress() {},
      });
      const plan = planned.plan;
      assert.ok(plan);
      assert.equal(planned.status, "awaiting-confirmation");
      assert.equal(fixture.retireCalls.length, 0);

      const applied = await executeApply({
        run: { ...planned, status: "running" },
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        plan,
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        realWrites: true,
        onProgress() {},
      });

      assert.equal(applied.status, "completed");
      assert.deepEqual(fixture.retireCalls, ["device-1", "device-2"]);
      assert.deepEqual(applied.result, {
        mode: "real",
        retiredDeviceIds: ["device-1", "device-2"],
        simulatedDeviceIds: [],
        failed: [],
        successCount: 2,
        failureCount: 0,
        total: 2,
      });
      assert.equal(applied.summary, "Executed 2 of 2 actions.");
    } finally {
      fixture.cleanup();
    }
  });

  it("continues applying later actions and reports individual write failures", async () => {
    const fixture = makeWriteAgentFixture({
      devices: [
        managedDevice("device-1", "Pilot laptop 1", "SERIAL-1"),
        managedDevice("device-2", "Pilot laptop 2", "SERIAL-2"),
        managedDevice("device-3", "Pilot laptop 3", "SERIAL-3"),
      ],
      failRetireDeviceIds: new Set(["device-2"]),
    });
    try {
      const planned = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress() {},
      });
      const plan = planned.plan;
      assert.ok(plan);

      const applied = await executeApply({
        run: { ...planned, status: "running" },
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        plan,
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        realWrites: true,
        onProgress() {},
      });

      assert.equal(applied.status, "completed");
      assert.deepEqual(fixture.retireCalls, ["device-1", "device-2", "device-3"]);
      assert.equal(applied.summary, "Executed 2 of 3 actions. 1 failed.");
      assert.deepEqual(applied.result, {
        mode: "real",
        retiredDeviceIds: ["device-1", "device-3"],
        simulatedDeviceIds: [],
        failed: [
          {
            id: "retire-managed-device:1",
            name: "Offboard Pilot laptop 2",
            error: "Graph refused device-2",
          },
        ],
        successCount: 2,
        failureCount: 1,
        total: 3,
      });
      assert.ok(
        applied.logs.some((log) =>
          log.message === 'Failed action "Offboard Pilot laptop 2": Graph refused device-2',
        ),
      );
    } finally {
      fixture.cleanup();
    }
  });
});

describe("write plan validation", () => {
  it("rejects plans rendered without a summary", async () => {
    const fixture = makeWriteAgentFixture({
      devices: [managedDevice("device-1", "Pilot laptop 1", "SERIAL-1")],
      summaryTemplate: "{{ missing.output }}",
    });
    try {
      const planned = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress() {},
      });

      assert.equal(planned.status, "failed");
      assert.match(planned.error ?? "", /returned a plan without a summary/);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects plans rendered without a confirmation phrase", async () => {
    const fixture = makeWriteAgentFixture({
      devices: [managedDevice("device-1", "Pilot laptop 1", "SERIAL-1")],
      confirmationPhraseTemplate: "{{ missing.output }}",
    });
    try {
      const planned = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress() {},
      });

      assert.equal(planned.status, "failed");
      assert.match(
        planned.error ?? "",
        /returned a plan without a confirmation phrase/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects write steps whose source does not render to an action array", async () => {
    const fixture = makeWriteAgentFixture({
      devices: [managedDevice("device-1", "Pilot laptop 1", "SERIAL-1")],
      sourceTemplate: "{{ explain.output.text }}",
    });
    try {
      const planned = await executePlan({
        run: createQueuedRun({
          agent: fixture.agent,
          providerId: "ollama",
          model: "test-model",
        }),
        agent: fixture.agent,
        providerId: "ollama",
        model: "test-model",
        llm: fixture.llm,
        createGraph: () => fixture.graph,
        onProgress() {},
      });

      assert.equal(planned.status, "failed");
      assert.match(planned.error ?? "", /source must resolve to an array/);
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects malformed action templates before accepting a plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openadminos-bad-action-template-"));
    const agent = agentSummary({
      slug: "bad-action-template-agent",
      name: "Bad action template agent",
      description: "Malformed write action template fixture.",
      registryPath: dir,
      mode: "write",
    });
    try {
      writeFileSync(
        join(dir, "manifest.yaml"),
        `descriptor:
  id: bad-action-template-agent
  name: Bad action template agent
  description: Malformed write action template fixture.
  version: 1.0.0
  author:
    name: OpenAdminOS
    verified: true
  category: devices
  mode: write
skills:
  - id: load
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
  - id: explain
    format: llm
    label: Explain plan
    settings:
      prompt: Explain the plan.
  - id: write
    format: write
    label: Build write plan
    settings:
      kind: retire-managed-device
      source: "{{ load.output }}"
      confirmationPhrase: "OFFBOARD {{ actions | size }} DEVICES"
      summary: "{{ explain.output.text }}"
      actionTemplate:
        metadata:
          deviceId: "{{ item.id }}"
definition:
  triggers:
    - id: manual
      kind: manual
`,
      );

      const llm = makeLlm().llm;
      const graph = makeGraph({ devices: [] }).graph;
      const planned = await executePlan({
        run: createQueuedRun({ agent, providerId: "ollama", model: "test-model" }),
        agent,
        providerId: "ollama",
        model: "test-model",
        llm,
        createGraph: () => graph,
        onProgress() {},
      });

      assert.equal(planned.status, "failed");
      assert.match(planned.error ?? "", /actionTemplate\.label/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects brokered write plans missing an actions array", async () => {
    const response = await brokerWritePlan({ summary: "Bad plan.", confirmationPhrase: "BAD 1" });

    assert.equal(response.ok, false);
    assert.match(response.error.message, /without an actions array/);
    assert.equal(response.error.code, "invalid_request");
  });

  it("rejects brokered write plans whose actions are missing required fields", async () => {
    const response = await brokerWritePlan({
      summary: "Bad plan.",
      confirmationPhrase: "BAD 1",
      actions: [{ id: "bad-action", kind: "retire-managed-device" }],
    });

    assert.equal(response.ok, false);
    assert.match(response.error.message, /action missing id\/kind\/label/);
    assert.equal(response.error.code, "invalid_request");
  });
});

describe("read-mode write prevention", () => {
  it("fails before a read-mode template with a write step can reach confirmation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openadminos-read-with-write-step-"));
    const agent = agentSummary({
      slug: "read-with-write-step",
      name: "Read with write step",
      description: "Invalid read-mode fixture with a write step.",
      registryPath: dir,
      mode: "read",
    });
    try {
      writeFileSync(
        join(dir, "manifest.yaml"),
        `descriptor:
  id: read-with-write-step
  name: Read with write step
  description: Invalid read-mode fixture with a write step.
  version: 1.0.0
  author:
    name: OpenAdminOS
    verified: true
  category: devices
  mode: read
skills:
  - id: load
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
  - id: summarize
    format: llm
    label: Summarize devices
    settings:
      prompt: Summarize devices.
  - id: write
    format: write
    label: Build write plan
    settings:
      kind: retire-managed-device
      source: "{{ load.output }}"
      confirmationPhrase: "OFFBOARD {{ actions | size }} DEVICES"
      actionTemplate:
        label: "Offboard {{ item.deviceName }}"
        metadata:
          deviceId: "{{ item.id }}"
definition:
  triggers:
    - id: manual
      kind: manual
  result:
    summary: "{{ summarize.output.text }}"
`,
      );

      const progress: RunStatus[] = [];
      const completed = await executeRun({
        run: createQueuedRun({ agent, providerId: "ollama", model: "test-model" }),
        agent,
        providerId: "ollama",
        model: "test-model",
        llm: makeLlm().llm,
        createGraph: () => makeGraph({ devices: [] }).graph,
        onProgress(next) {
          progress.push(next.status);
        },
      });

      assert.equal(completed.status, "failed");
      assert.match(completed.error ?? "", /read-mode agents cannot declare a write step/);
      assert.ok(!progress.includes("awaiting-confirmation"));
      assert.equal(completed.plan, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeWriteAgentFixture(options: {
  slug?: string;
  name?: string;
  description?: string;
  devices: ManagedDeviceRecord[];
  llmText?: string;
  failRetireDeviceIds?: Set<string>;
  sourceTemplate?: string;
  confirmationPhraseTemplate?: string;
  summaryTemplate?: string;
}): {
  agent: AgentSummary;
  graph: RunGraphApi;
  llm: RunLlmApi;
  llmRequests: unknown[];
  retireCalls: string[];
  cleanup(): void;
} {
  const slug = options.slug ?? "write-plan-agent";
  const name = options.name ?? "Write plan agent";
  const description =
    options.description ?? "Test write agent that offboards managed devices.";
  const dir = mkdtempSync(join(tmpdir(), `openadminos-${slug}-`));
  writeFileSync(
    join(dir, "manifest.yaml"),
    writeAgentManifest({
      slug,
      name,
      description,
      sourceTemplate: options.sourceTemplate ?? "{{ load.output }}",
      confirmationPhraseTemplate:
        options.confirmationPhraseTemplate ??
        "OFFBOARD {{ actions | size }} DEVICES",
      summaryTemplate: options.summaryTemplate ?? "{{ explain.output.text }}",
    }),
    "utf8",
  );
  const graphFixture = makeGraph({
    devices: options.devices,
    failRetireDeviceIds: options.failRetireDeviceIds,
  });
  const llmFixture = makeLlm(
    options.llmText ?? "Review complete. Devices are ready to offboard.",
  );

  return {
    agent: agentSummary({
      slug,
      name,
      description,
      registryPath: dir,
      mode: "write",
    }),
    graph: graphFixture.graph,
    llm: llmFixture.llm,
    llmRequests: llmFixture.requests,
    retireCalls: graphFixture.retireCalls,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeAgentManifest(input: {
  slug: string;
  name: string;
  description: string;
  sourceTemplate: string;
  confirmationPhraseTemplate: string;
  summaryTemplate: string;
}): string {
  return `descriptor:
  id: ${input.slug}
  name: ${input.name}
  description: ${input.description}
  version: 1.0.0
  author:
    name: OpenAdminOS
    verified: true
  category: devices
  mode: write
skills:
  - id: load
    format: graph
    label: Load matching devices
    detail: Load Intune managed devices eligible for offboarding.
    settings:
      method: GET
      path: /deviceManagement/managedDevices
  - id: explain
    format: llm
    label: Explain plan
    detail: Required LLM step.
    settings:
      prompt: "Explain the offboarding plan for {{ load.output | size }} devices."
  - id: write
    format: write
    label: Build write plan
    detail: Builds destructive retire actions.
    settings:
      kind: retire-managed-device
      source: "${input.sourceTemplate}"
      confirmationPhrase: "${input.confirmationPhraseTemplate}"
      summary: "${input.summaryTemplate}"
      actionTemplate:
        label: "Offboard {{ item.deviceName }}"
        description: "Retire managed device {{ item.deviceName }} from Intune."
        metadata:
          deviceId: "{{ item.id }}"
          deviceName: "{{ item.deviceName }}"
          serialNumber: "{{ item.serialNumber }}"
definition:
  triggers:
    - id: manual
      kind: manual
`;
}

function managedDevice(
  id: string,
  deviceName: string,
  serialNumber: string,
): ManagedDeviceRecord & { serialNumber: string } {
  return {
    id,
    deviceName,
    serialNumber,
    userPrincipalName: `${id}@example.com`,
    operatingSystem: "Windows",
    osVersion: "11.0.22631",
    lastSyncDateTime: "2026-05-27T00:00:00.000Z",
    enrolledDateTime: "2026-01-01T00:00:00.000Z",
    complianceState: "compliant",
  };
}

function makeLlm(text = "LLM response."): {
  llm: RunLlmApi;
  requests: unknown[];
} {
  const requests: unknown[] = [];
  const llm: RunLlmApi = {
    available: true,
    defaultModel: "test-model",
    async complete(options) {
      requests.push(options);
      return { text, model: "test-model" };
    },
    async *stream(options) {
      requests.push(options);
      yield {
        delta: text,
        accumulated: text,
        done: true,
        model: "test-model",
      };
    },
  };
  return { llm, requests };
}

function makeGraph(options: {
  devices: ManagedDeviceRecord[];
  failRetireDeviceIds?: Set<string>;
}): {
  graph: RunGraphApi;
  retireCalls: string[];
} {
  const retireCalls: string[] = [];
  return {
    retireCalls,
    graph: {
      async listManagedDevices() {
        return options.devices;
      },
      async retireManagedDevice(deviceId) {
        retireCalls.push(deviceId);
        if (options.failRetireDeviceIds?.has(deviceId)) {
          throw new Error(`Graph refused ${deviceId}`);
        }
      },
      async request(input) {
        if (input.method === "GET" && input.path === "/deviceManagement/managedDevices") {
          return { value: options.devices };
        }
        return { value: [] };
      },
    },
  };
}

function agentSummary(input: {
  slug: string;
  name: string;
  description: string;
  registryPath: string;
  mode: "read" | "write";
}): AgentSummary {
  return {
    id: input.slug,
    slug: input.slug,
    name: input.name,
    description: input.description,
    mode: input.mode,
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    scopes: [],
    author: { name: "OpenAdminOS", verified: true },
    version: "1.0.0",
    registryPath: input.registryPath,
    installedAt: new Date("2026-05-27T00:00:00.000Z").toISOString(),
  };
}

async function brokerWritePlan(params: unknown) {
  const agent = agentSummary({
    slug: "broker-write-agent",
    name: "Broker write agent",
    description: "Broker write plan validation fixture.",
    registryPath: "/tmp/not-used",
    mode: "write",
  });
  const graph = makeGraph({ devices: [] }).graph;
  const llm = makeLlm().llm;
  const ctx: RunContext = {
    agent,
    providerId: "ollama",
    model: "test-model",
    graph,
    llm,
    realWrites: false,
    log() {},
    async step(_label, _detail, fn) {
      return await fn();
    },
  };
  const broker = createSandboxBroker({
    agent: {
      slug: agent.slug,
      mode: "write",
      scopes: ["DeviceManagementManagedDevices.ReadWrite.All"],
      graphOperations: [],
    },
    ctx,
  });
  return await broker.handle({
    id: "plan-1",
    method: "write.plan",
    params: params as WritePlan,
  });
}
