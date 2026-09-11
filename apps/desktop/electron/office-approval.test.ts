import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  AgentSummary,
  RunGraphApi,
  RunLlmApi,
  RunRecord,
} from "@openadminos/agent-sdk";
import { createQueuedRun, executePlan } from "@openadminos/runtime";
import {
  RunService,
  type RunPersistedState,
  type RunServiceHost,
} from "./runs.js";
for (const changed of [false, true])
  test(`office approval ${changed ? "rejects a changed proposal without writing" : "revalidates and applies an unchanged proposal"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "team-approval-"));
    try {
      await writeFile(
        join(dir, "manifest.yaml"),
        `descriptor:
  id: office-approval-fixture
  name: Team approval test
  description: Test proposal freshness.
  version: 1.0.0
  category: devices
  mode: write
  author:
    name: Test
skills:
  - id: load
    format: graph
    label: Read proposed targets
    settings:
      method: GET
      path: /deviceManagement/managedDevices
  - id: plan
    format: write
    label: Plan retirement
    settings:
      kind: retire-managed-device
      source: "{{ load.output }}"
      confirmationPhrase: "RETIRE {{ actions | size }} DEVICES"
      summary: Review the proposed retirement.
      actionTemplate:
        label: "Retire {{ item.deviceName }}"
        metadata:
          deviceId: "{{ item.id }}"
definition:
  triggers:
    - id: manual
      kind: manual
`,
      );
      const agent: AgentSummary = {
        id: "office-approval-fixture",
        slug: "office-approval-fixture",
        name: "Test",
        description: "Test",
        version: "1.0.0",
        mode: "write",
        category: "devices",
        tier: "agent",
        requiresEntraTier: "free",
        scopes: [],
        author: { name: "Test", verified: false },
        installedAt: new Date().toISOString(),
        registryPath: dir,
      };
      let target = "device-a",
        reads = 0,
        writes = 0,
        reviewed = 0;
      const graph: RunGraphApi = {
        request: async () => {
          reads++;
          return { value: [{ id: target, deviceName: target }] };
        },
        listManagedDevices: async () => {
          reads++;
          return [
            {
              id: target,
              deviceName: target,
              userPrincipalName: "test@example.invalid",
              operatingSystem: "Windows",
              osVersion: "11",
              lastSyncDateTime: "2026-01-01T00:00:00Z",
              enrolledDateTime: "2025-01-01T00:00:00Z",
              complianceState: "noncompliant",
            },
          ];
        },
        retireManagedDevice: async () => {
          writes++;
        },
      };
      const llm: RunLlmApi = {
        available: false,
        complete: async () => {
          throw new Error("Unused");
        },
        async *stream() {
          throw new Error("Unused");
        },
      };
      const planned = await executePlan({
        agent,
        run: {
          ...createQueuedRun({ agent, providerId: "ollama" }),
          tenantId: "test",
          office: { missionId: "mission", personaId: "owner", step: 0 },
        },
        providerId: "ollama",
        createGraph: () => graph,
        llm,
        onProgress: () => {},
      });
      assert.equal(planned.status, "awaiting-confirmation", planned.error);
      let state: RunPersistedState = {
        activeProviderId: "ollama",
        installedAgents: [agent],
        tenants: [],
        runs: [planned],
      };
      let terminal!: () => void;
      const done = new Promise<void>((resolve) => (terminal = resolve));
      const host = {
        read: async () => state,
        write: async (next: RunPersistedState) => {
          state = next;
        },
        serialize: async <T>(fn: () => Promise<T>) => fn(),
        listProviders: async () => [],
        buildLlm: async () => llm,
        buildGraph: async () => ({
          tenantId: "test",
          tenantSession: {} as never,
          createGraph: () => graph,
        }),
        selfTrainingPromptOverlay: () => undefined,
        readConnectorConfigs: async () => ({}),
        connectorSecretsFor: () => ({ get: async () => undefined,set:async()=>{},remove:async()=>{} }),
        validateOfficeApproval: async () => {
          reviewed++;
        },
        recordLearningEventSafely: () => {},
        emitStateChanged: () => {},
        notifyRunFinished: (_r: RunRecord) => terminal(),
        enqueueRunDeliveries: async () => {},
        processPendingRunDeliveries: async () => {},
      } satisfies Partial<RunServiceHost>;
      if (changed) target = "device-b";
      await new RunService(host as unknown as RunServiceHost).confirmRun(
        planned.id,
        planned.plan!.confirmationPhrase,
      );
      await Promise.race([
        done,
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Apply did not settle")),
            3000,
          );
          timer.unref();
        }),
      ]);
      assert.equal(reviewed, 1);
      assert.equal(reads, 2);
      assert.equal(writes, changed ? 0 : 1);
      assert.equal(state.runs[0].status, changed ? "failed" : "completed");
      if (changed)
        assert.match(state.runs[0].error!, /actions changed since review/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
