import type { RunGraphApi, RunRecord } from "@openadminos/agent-sdk";

export const DRY_RUN_APPLY_ERROR = "Dry runs cannot be applied. Choose Run for real to prepare a fresh plan for review.";
export const DRY_RUN_WRITE_ERROR = "Dry run policy blocks Graph writes. Planning may only read tenant data. Fix the agent to return proposed changes in its plan.";

export function assertRunCanApply(run: RunRecord): void {
  if (run.dryRun || run.status === "planned") throw new Error(DRY_RUN_APPLY_ERROR);
}

export function dryRunGraph(graph: RunGraphApi): RunGraphApi {
  return {
    listManagedDevices: () => graph.listManagedDevices(),
    retireManagedDevice: async () => { throw new Error(DRY_RUN_WRITE_ERROR); },
    request: async (input) => {
      if (input.method !== "GET") throw new Error(DRY_RUN_WRITE_ERROR);
      return graph.request(input);
    },
  };
}
