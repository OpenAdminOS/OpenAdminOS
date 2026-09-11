import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RunService,
  type RunServiceHost,
  type RunPersistedState,
} from "./runs.js";
import type { RunRecord } from "@openadminos/agent-sdk";

test("persisted scheduled outcomes and delivered reports use tenant and assessment-specific evidence", async () => {
  let state = {
    activeProviderId: "ollama",
    installedAgents: [],
    tenants: [],
    runs: [],
  } as RunPersistedState;
  const deliveries: RunRecord[] = [];
  const host = {
    read: async () => state,
    write: async (s: RunPersistedState) => {
      state = s;
    },
    serialize: async (fn: () => Promise<unknown>) => fn(),
    notifyRunFinished() {},
    emitStateChanged() {},
    enqueueRunDeliveries: async (r: RunRecord) => {
      deliveries.push(r);
    },
    processPendingRunDeliveries: async () => {},
  } as unknown as RunServiceHost;
  const service = new RunService(host);
  const base: RunRecord = {
    id: "b",
    tenantId: "tenant-b",
    agentSlug: "one",
    assessmentKey: "v1",
    trigger: "schedule",
    status: "completed",
    queuedAt: new Date().toISOString(),
    steps: [],
    logs: [],
    result: [
      { id: "1", count: 4 },
      { id: "2", count: 9 },
    ],
  };
  await service.persistRunSnapshot(base);
  await service.persistRunSnapshot({ ...base, id: "a", tenantId: "tenant-a" });
  assert.equal(deliveries.at(-1)?.changeState, "new");
  await service.persistRunSnapshot({
    ...base,
    id: "a2",
    tenantId: "tenant-a",
    result: [...(base.result as unknown[])].reverse(),
  });
  assert.equal(deliveries.at(-1)?.changeState, "unchanged");
  await service.persistRunSnapshot({
    ...base,
    id: "a3",
    tenantId: "tenant-a",
    assessmentKey: "v2",
  });
  assert.equal(deliveries.at(-1)?.changeState, "new");
  await service.persistRunSnapshot({
    ...base,
    id: "a4",
    tenantId: "tenant-a",
    result: [{ id: "1", count: 5 }],
  });
  assert.equal(deliveries.at(-1)?.changeState, "changed");
});

test("structured result fields outside a data property remain part of the assessment",async()=>{
 const {fingerprintRunOutput}=await import("./run-delivery-format.js");
 const run={id:"test",agentSlug:"test",status:"completed",queuedAt:"2026-09-11T00:00:00Z",steps:[],logs:[],result:{data:[],count:1}} as RunRecord;
 assert.notEqual(fingerprintRunOutput(run),fingerprintRunOutput({...run,result:{data:[],count:2}}));
});
