import assert from "node:assert/strict";
import { it } from "node:test";
import type { RunGraphApi, RunRecord } from "@openadminos/agent-sdk";
import { assertRunCanApply, dryRunGraph } from "./dry-run.js";

it("blocks every Graph write method and the legacy retire operation while preserving reads", async () => {
  const requests: string[] = [];
  const graph = dryRunGraph({
    request: async input => { requests.push(input.method); return { value: [] }; },
    listManagedDevices: async () => [],
    retireManagedDevice: async () => { requests.push("retire"); },
  } satisfies RunGraphApi);
  for (const method of ["POST", "PATCH", "PUT", "DELETE"] as const) {
    await assert.rejects(graph.request({ method, path: "/users/test" }), /Dry run policy blocks Graph writes/);
  }
  await assert.rejects(graph.retireManagedDevice("test"), /Dry run policy blocks Graph writes/);
  assert.deepEqual(requests, []);
  assert.deepEqual(await graph.request({ method: "GET", path: "/users" }), { value: [] });
  assert.deepEqual(await graph.listManagedDevices(), []);
  assert.deepEqual(requests, ["GET"]);
});

it("refuses apply even if a planned run lost its dry-run flag or has an inconsistent status", () => {
  for (const run of [{ status: "planned" }, { status: "awaiting-confirmation", dryRun: true }]) {
    assert.throws(() => assertRunCanApply(run as RunRecord), /Dry runs cannot be applied/);
  }
});
