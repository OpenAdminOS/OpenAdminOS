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
  PLAN_REVALIDATION_READ_ONLY_COPY,
  planChangedSinceReviewCopy,
  planChangeSinceReview,
  readOnlyRevalidationGraph,
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
        description: "Inactive for {{ item.days }} days"
        severity: destructive
        metadata:
          inactiveDays: "{{ item.days }}"
        request:
          method: PATCH
          path: "/users/{{ item.id }}"
          body:
            accountEnabled: false
            department: "{{ item.department }}"
definition:
  triggers:
    - id: manual
      kind: manual
`;

interface Guest {
  id: string;
  displayName: string;
  days: number;
  department: string;
}

const guest = (id: string): Guest => ({ id, displayName: id, days: 91, department: "Partners" });

/**
 * Plans a write run against a fake tenant, lets the test change the
 * tenant, then confirms it and waits for the run to settle.
 */
async function confirmAfter(change: (guests: Guest[]) => Guest[]) {
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
    let guests = [guest("guest-a"), guest("guest-b")];
    const reads: GraphRequestInput[] = [];
    const writes: GraphRequestInput[] = [];
    const graph: RunGraphApi = {
      request: async (request) => {
        if (request.method === "GET") {
          reads.push(request);
          return { value: structuredClone(guests) };
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
    const { run, writes, revalidationReads } = await confirmAfter(() => [guest("guest-a"), guest("guest-c"), guest("guest-d")]);
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

  it("applies a plan whose wording changed but whose requests did not", async () => {
    // A day boundary between review and confirm: "91 days" becomes "92 days".
    const { run, writes } = await confirmAfter((guests) =>
      guests.map((entry) => ({ ...entry, days: entry.days + 1, displayName: `${entry.displayName} (guest)` })),
    );
    assert.equal(run.status, "completed", run.error);
    assert.equal(writes.length, 2);
  });

  it("applies a plan the tenant gives in another order, in the reviewed order", async () => {
    const { run, writes } = await confirmAfter((guests) => [...guests].reverse());
    assert.equal(run.status, "completed", run.error);
    assert.deepEqual(writes.map((write) => write.path), ["/users/guest-a", "/users/guest-b"]);
  });

  it("refuses a plan whose request body changed and writes nothing", async () => {
    const { run, writes } = await confirmAfter((guests) =>
      guests.map((entry) => (entry.id === "guest-b" ? { ...entry, department: "Contractors" } : entry)),
    );
    assert.equal(writes.length, 0, "no Graph write is sent");
    assert.equal(run.status, "failed");
    assert.equal(
      run.error,
      "The planned actions changed since review: 1 of the 2 actions you reviewed is no longer in the plan, and 1 action is new. Nothing was applied. Select Run again to review a fresh plan.",
    );
  });

  it("compares only what each action sends, and names a changed phrase", () => {
    const action = (id: string, path: string, extra: Record<string, unknown> = {}) => ({
      id, kind: "graph-write", label: path, request: { method: "PATCH" as const, path, body: { accountEnabled: false } }, ...extra,
    });
    const reviewed = { summary: "s", confirmationPhrase: "APPLY 2 CHANGES", actions: [action("0", "/users/a"), action("1", "/users/b")] };
    assert.equal(planChangeSinceReview(reviewed, structuredClone(reviewed)).changed, false);
    assert.equal(planChangeSinceReview(reviewed, { ...reviewed, actions: [action("x", "/users/b"), action("y", "/users/a")] }).changed, false);
    assert.equal(
      planChangeSinceReview(reviewed, {
        ...reviewed,
        summary: "other",
        actions: reviewed.actions.map((entry) => ({ ...entry, label: "Renamed", description: "Inactive for 92 days", metadata: { inactiveDays: "92" } })),
      }).changed,
      false,
    );
    const rebodied = planChangeSinceReview(reviewed, {
      ...reviewed,
      actions: [action("0", "/users/a"), { ...action("1", "/users/b"), request: { method: "PATCH" as const, path: "/users/b", body: { accountEnabled: true } } }],
    });
    assert.deepEqual({ changed: rebodied.changed, removed: rebodied.removed, added: rebodied.added }, { changed: true, removed: 1, added: 1 });

    // A retire carries its target in metadata.deviceId; the rest of its metadata is wording.
    const retire = (deviceId: string, inactiveDays: string) => ({ id: deviceId, kind: "retire-managed-device", label: deviceId, metadata: { deviceId, intuneInactiveDays: inactiveDays } });
    const retires = { summary: "s", confirmationPhrase: "OFFBOARD 1 DEVICES", actions: [retire("device-a", "91")] };
    assert.equal(planChangeSinceReview(retires, { ...retires, actions: [retire("device-a", "92")] }).changed, false);
    assert.equal(planChangeSinceReview(retires, { ...retires, actions: [retire("device-b", "91")] }).changed, true);

    const rephrased = planChangeSinceReview(reviewed, { ...reviewed, confirmationPhrase: "APPLY TWO CHANGES" });
    assert.equal(rephrased.changed, true);
    assert.match(planChangedSinceReviewCopy(rephrased, "office"), /^The proposed actions changed since review: the confirmation phrase is different\. .*Run the assignment again/);
  });

  it("refuses every write attempted during the replan before it reaches Graph", async () => {
    const sent: GraphRequestInput[] = [];
    const graph = readOnlyRevalidationGraph({
      request: async (request) => {
        sent.push(request);
        return { value: [] };
      },
      listManagedDevices: async () => [],
      retireManagedDevice: async () => {
        throw new Error("The underlying retire must not be reached.");
      },
    });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
      await assert.rejects(graph.request({ method, path: "/users/guest-a", body: {} }), { message: PLAN_REVALIDATION_READ_ONLY_COPY });
    }
    await assert.rejects(graph.retireManagedDevice("device-a"), { message: PLAN_REVALIDATION_READ_ONLY_COPY });
    assert.deepEqual(sent, [], "no write reached the Graph client");
    assert.deepEqual(await graph.request({ method: "GET", path: "/users" }), { value: [] });
    assert.equal(sent.length, 1);
  });
});
