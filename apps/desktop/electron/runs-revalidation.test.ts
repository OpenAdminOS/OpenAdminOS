import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type {
  AgentSummary,
  GraphRequestInput,
  RunGraphApi,
  RunLlmApi,
  RunRecord,
} from "@openadminos/agent-sdk";
import { createQueuedRun, executePlan } from "@openadminos/runtime";

import {
  planChangedSinceReviewCopy,
  planChangeSinceReview,
  RunService,
  type RunPersistedState,
  type RunServiceHost,
} from "./runs.js";

const MANIFEST = `descriptor:
  id: revalidation-fixture
  name: Revalidation test
  description: Test plan revalidation before apply.
  version: 1.0.0
  category: policies
  mode: write
  author:
    name: Test
skills:
  - id: load
    format: graph
    label: Read guest accounts
    settings:
      method: GET
      path: /users
  - id: plan
    format: write
    label: Plan disables
    settings:
      kind: graph-write
      source: "{{ load.output }}"
      confirmationPhrase: "DISABLE {{ actions | size }} GUESTS"
      summary: Review the proposed disables.
      actionTemplate:
        label: "Disable {{ item.displayName }}"
        severity: destructive
        request:
          method: PATCH
          path: "/users/{{ item.id }}"
          body:
            accountEnabled: false
definition:
  triggers:
    - id: manual
      kind: manual
`;

/**
 * Plans a write run against a fake tenant, lets the test change the
 * tenant, then confirms it and waits for the run to settle.
 */
async function confirmAfter(change: (guests: string[]) => string[]) {
  const dir = await mkdtemp(join(tmpdir(), "plan-revalidation-"));
  try {
    await writeFile(join(dir, "manifest.yaml"), MANIFEST);
    const agent: AgentSummary = {
      id: "revalidation-fixture",
      slug: "revalidation-fixture",
      name: "Revalidation test",
      description: "Test",
      version: "1.0.0",
      mode: "write",
      category: "policies",
      tier: "agent",
      requiresEntraTier: "free",
      scopes: [],
      author: { name: "Test", verified: false },
      installedAt: new Date().toISOString(),
      registryPath: dir,
    };
    let guests = ["guest-a", "guest-b"];
    const reads: GraphRequestInput[] = [];
    const writes: GraphRequestInput[] = [];
    const graph: RunGraphApi = {
      request: async (request) => {
        if (request.method === "GET") {
          reads.push(request);
          return { value: guests.map((id) => ({ id, displayName: id })) };
        }
        writes.push(request);
        return {};
      },
      listManagedDevices: async () => [],
      retireManagedDevice: async () => {
        throw new Error("Not used by this agent.");
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
      run: { ...createQueuedRun({ agent, providerId: "ollama" }), tenantId: "tenant-1" },
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
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    const host = {
      read: async () => state,
      write: async (next: RunPersistedState) => {
        state = next;
      },
      serialize: async <T>(task: () => Promise<T>) => task(),
      listProviders: async () => [],
      buildLlm: async () => llm,
      buildGraph: async () => ({ tenantId: "tenant-1", tenantSession: {} as never, createGraph: () => graph }),
      selfTrainingPromptOverlay: () => undefined,
      readConnectorConfigs: async () => ({}),
      connectorSecretsFor: () => ({ get: async () => undefined, set: async () => {}, remove: async () => {} }),
      recordLearningEventSafely: () => {},
      emitStateChanged: () => {},
      notifyRunFinished: (_run: RunRecord) => settled(),
      enqueueRunDeliveries: async () => {},
      processPendingRunDeliveries: async () => {},
    } satisfies Partial<RunServiceHost>;
    const readsWhenPlanned = reads.length;
    guests = change(guests);
    await new RunService(host as unknown as RunServiceHost).confirmRun(planned.id, planned.plan!.confirmationPhrase);
    await done;
    return { run: state.runs[0]!, writes, revalidationReads: reads.length - readsWhenPlanned };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("write plans are checked against the tenant before apply", () => {
  it("applies a plan the tenant still gives", async () => {
    const { run, writes, revalidationReads } = await confirmAfter((guests) => guests);
    assert.equal(revalidationReads, 1, "the plan is read again before apply");
    assert.equal(run.status, "completed", run.error);
    assert.deepEqual(writes.map((write) => `${write.method} ${write.path}`), ["PATCH /users/guest-a", "PATCH /users/guest-b"]);
  });

  it("refuses a plan that changed since review and writes nothing", async () => {
    const { run, writes, revalidationReads } = await confirmAfter(() => ["guest-a", "guest-c", "guest-d"]);
    assert.equal(revalidationReads, 1);
    assert.equal(writes.length, 0, "no Graph write is sent");
    assert.equal(run.status, "failed");
    assert.equal(
      run.error,
      "The planned actions changed since review: 1 of the 2 actions you reviewed is no longer in the plan, and 2 actions are new. Nothing was applied. Select Run again to review a fresh plan.",
    );
  });

  it("refuses a plan the tenant no longer gives any action for", async () => {
    const { run, writes } = await confirmAfter(() => []);
    assert.equal(writes.length, 0);
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /2 of the 2 actions you reviewed are no longer in the plan\. Nothing was applied\./);
  });

  it("names a reorder or a changed phrase when no action was added or removed", () => {
    const action = (id: string, path: string) => ({ id, kind: "graph-write", label: path, request: { method: "PATCH" as const, path } });
    const reviewed = { summary: "s", confirmationPhrase: "APPLY 2 CHANGES", actions: [action("0", "/users/a"), action("1", "/users/b")] };
    const reordered = planChangeSinceReview(reviewed, { ...reviewed, actions: [action("0", "/users/b"), action("1", "/users/a")] });
    assert.equal(reordered.changed, true);
    assert.match(planChangedSinceReviewCopy(reordered, "agent"), /the 2 actions you reviewed are in a different order/);
    const rephrased = planChangeSinceReview(reviewed, { ...reviewed, confirmationPhrase: "APPLY TWO CHANGES" });
    assert.match(planChangedSinceReviewCopy(rephrased, "office"), /^The proposed actions changed since review: the confirmation phrase is different\. .*Run the assignment again/);
    assert.equal(planChangeSinceReview(reviewed, structuredClone(reviewed)).changed, false);
  });
});
