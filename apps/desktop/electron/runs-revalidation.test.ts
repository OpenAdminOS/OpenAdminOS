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
  PLAN_REVALIDATION_MODEL_COPY,
  PLAN_REVALIDATION_READ_ONLY_COPY,
  planChangedSinceReviewCopy,
  planChangeSinceReview,
  readOnlyRevalidationGraph,
  readOnlyRevalidationTransport,
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

/** The same agent with a model step before the plan. */
const MANIFEST_WITH_MODEL = MANIFEST.replace(
  "  - id: plan\n",
  `  - id: review
    format: llm
    label: Review guest accounts
    settings:
      prompt: "Review {{ load.output | size }} guest accounts."
  - id: plan
`,
);

/** What the fake model reports for each call. */
const CALL_USAGE = { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.25 };

interface Guest {
  id: string;
  displayName: string;
  days: number;
  department: string;
}

const guest = (id: string): Guest => ({ id, displayName: id, days: 91, department: "Partners" });

/**
 * Plans a write run against a fake tenant, lets the test change the
 * tenant, then confirms it and waits for the run to settle. A change
 * that returns an Error makes every later tenant read fail with it.
 */
async function confirmAfter(
  change: (guests: Guest[]) => Guest[] | Error,
  options: { withModel?: boolean; cancelDuringReplan?: boolean; applyHost?: { buildLlm?: Error; buildGraph?: Error } } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "plan-revalidation-"));
  try {
    await writeFile(join(dir, "manifest.yaml"), options.withModel ? MANIFEST_WITH_MODEL : MANIFEST);
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
    let readError: Error | undefined;
    const reads: GraphRequestInput[] = [];
    const writes: GraphRequestInput[] = [];
    const graph: RunGraphApi = {
      request: async (request) => {
        if (request.method === "GET") {
          reads.push(request);
          if (readError) throw readError;
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
    let modelCalls = 0;
    let service!: RunService;
    let runId = "";
    const llm: RunLlmApi = options.withModel
      ? {
          available: true,
          defaultModel: "model-1",
          complete: async () => {
            throw new Error("The runtime streams.");
          },
          async *stream() {
            modelCalls += 1;
            yield { delta: "Reviewed.", accumulated: "Reviewed.", done: true, model: "model-1", tokenUsage: CALL_USAGE };
            // The second call is the replan's: the admin cancels right after it.
            if (options.cancelDuringReplan && modelCalls === 2) await service.cancelRun(runId);
          },
        }
      : {
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
    runId = planned.id;
    let settled!: () => void;
    const done = new Promise<void>((resolve) => (settled = resolve));
    // A cancelled run is not reported as finished: it has settled once the
    // run's own snapshot lands after the cancel.
    let cancelledWrites = 0;
    const host = {
      read: async () => state,
      write: async (next: RunPersistedState) => {
        state = next;
        if (next.runs[0]?.status === "cancelled" && (cancelledWrites += 1) === 2) settled();
      },
      serialize: async <T>(task: () => Promise<T>) => task(),
      listProviders: async () => [],
      buildLlm: async () => {
        if (options.applyHost?.buildLlm) throw options.applyHost.buildLlm;
        return llm;
      },
      buildGraph: async () => {
        if (options.applyHost?.buildGraph) throw options.applyHost.buildGraph;
        return { tenantId: "tenant-1", tenantSession: {} as never, createGraph: () => graph };
      },
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
    const changed = change(guests);
    if (changed instanceof Error) readError = changed;
    else guests = changed;
    service = new RunService(host as unknown as RunServiceHost);
    await service.confirmRun(planned.id, planned.plan!.confirmationPhrase);
    await done;
    return { run: state.runs[0]!, writes, revalidationReads: reads.length - readsWhenPlanned, modelCalls };
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

  it("refuses a plan that could not be checked against the tenant and writes nothing", async () => {
    const { run, writes, revalidationReads } = await confirmAfter(() => new Error("Graph is unavailable."));
    assert.equal(revalidationReads, 1, "the plan is read again before apply");
    assert.equal(writes.length, 0, "no Graph write is sent");
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /^The plan could not be checked against the tenant before applying, so nothing was applied\. .*Graph is unavailable\./);
  });

  it("says nothing was applied when the model or the Graph sign-in fails before the replan", async () => {
    for (const [applyHost, reason] of [
      [{ buildGraph: new Error("The Microsoft sign-in for Contoso expired. Reconnect it in Connections.") }, "The Microsoft sign-in for Contoso expired. Reconnect it in Connections."],
      [{ buildLlm: new Error("Ollama isn't running. Start it with ollama serve, then try again.") }, "Ollama isn't running. Start it with ollama serve, then try again."],
    ] as const) {
      const { run, writes } = await confirmAfter((guests) => guests, { applyHost });
      assert.equal(writes.length, 0, "no Graph write is sent");
      assert.equal(run.status, "failed");
      assert.equal(run.error, `Nothing was applied: ${reason}`);
    }
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

  it("counts the model calls of the replan in the run's usage when it applies", async () => {
    const { run, writes, modelCalls } = await confirmAfter((guests) => guests, { withModel: true });
    assert.equal(run.status, "completed", run.error);
    assert.equal(writes.length, 2);
    assert.ok(modelCalls >= 2, "the plan and the replan both call the model");
    assert.deepEqual(
      { calls: run.usage?.calls, promptTokens: run.usage?.promptTokens, costUsd: run.usage?.costUsd, tokens: run.tokens?.totalTokens },
      { calls: modelCalls, promptTokens: 100 * modelCalls, costUsd: 0.25 * modelCalls, tokens: 120 * modelCalls },
    );
  });

  it("counts the model calls of the replan in the run's usage when it refuses, and says a model can plan differently", async () => {
    const { run, writes, modelCalls } = await confirmAfter(() => [guest("guest-a")], { withModel: true });
    assert.equal(writes.length, 0, "no Graph write is sent");
    assert.equal(run.status, "failed");
    assert.equal(modelCalls, 2, "the plan and the replan each call the model once");
    assert.deepEqual(
      { calls: run.usage?.calls, promptTokens: run.usage?.promptTokens, costUsd: run.usage?.costUsd, tokens: run.tokens?.totalTokens },
      { calls: 2, promptTokens: 200, costUsd: 0.5, tokens: 240 },
    );
    assert.equal(
      run.error,
      `The planned actions changed since review: 1 of the 2 actions you reviewed is no longer in the plan. Nothing was applied. ${PLAN_REVALIDATION_MODEL_COPY} Select Run again to review a fresh plan.`,
    );
    assert.equal(
      PLAN_REVALIDATION_MODEL_COPY,
      "An agent that uses a model can plan differently on a second pass, even when the tenant has not changed.",
    );
  });

  it("counts the model calls of the replan in the run's usage when it is cancelled", async () => {
    const { run, writes, modelCalls } = await confirmAfter((guests) => guests, { withModel: true, cancelDuringReplan: true });
    assert.equal(run.status, "cancelled");
    assert.equal(writes.length, 0, "no Graph write is sent");
    assert.equal(modelCalls, 2);
    assert.deepEqual(
      { calls: run.usage?.calls, promptTokens: run.usage?.promptTokens, costUsd: run.usage?.costUsd },
      { calls: 2, promptTokens: 200, costUsd: 0.5 },
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
    // A retire that also carries a request still retires its deviceId, so an
    // unchanged request must not hide a swapped device.
    const retireWithRequest = (deviceId: string) => ({ ...retire(deviceId, "91"), request: { method: "POST" as const, path: "/deviceManagement/managedDevices/retire" } });
    assert.equal(
      planChangeSinceReview(
        { ...retires, actions: [retireWithRequest("device-a")] },
        { ...retires, actions: [retireWithRequest("device-b")] },
      ).changed,
      true,
    );

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

  it("refuses a connector's Graph write during the replan before it is sent", async () => {
    const sent: string[] = [];
    let egressChecks = 0;
    const transport = readOnlyRevalidationTransport({
      fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        sent.push(`${init?.method ?? "GET"} ${String(input)}`);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      assertEgress: () => {
        egressChecks += 1;
      },
    });
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      await assert.rejects(
        transport.fetch("https://graph.microsoft.com/v1.0/me/sendMail", { method, body: "{}" }),
        { message: `${method} /v1.0/me/sendMail was not sent. ${PLAN_REVALIDATION_READ_ONLY_COPY}` },
      );
    }
    await assert.rejects(
      transport.fetch(new Request("https://graph.microsoft.us/v1.0/teams/team-1/channels/channel-1/messages", { method: "POST", body: "{}" })),
      { message: `POST /v1.0/teams/team-1/channels/channel-1/messages was not sent. ${PLAN_REVALIDATION_READ_ONLY_COPY}` },
    );
    // The fully qualified name with a trailing dot, in any case, reaches
    // the same Graph host and is refused the same way.
    for (const host of ["graph.microsoft.com.", "GRAPH.Microsoft.com."]) {
      await assert.rejects(
        transport.fetch(`https://${host}/v1.0/me/sendMail`, { method: "POST", body: "{}" }),
        { message: `POST /v1.0/me/sendMail was not sent. ${PLAN_REVALIDATION_READ_ONLY_COPY}` },
      );
    }
    assert.deepEqual(sent, [], "no write reached the transport");

    await transport.fetch("https://graph.microsoft.com/v1.0/me/mailFolders");
    await transport.fetch("https://hooks.example.com/notify", { method: "POST", body: "{}" });
    assert.deepEqual(sent, ["GET https://graph.microsoft.com/v1.0/me/mailFolders", "POST https://hooks.example.com/notify"]);
    transport.assertEgress?.();
    assert.equal(egressChecks, 1, "the transport's egress check still applies");
  });
});
