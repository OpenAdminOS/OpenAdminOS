import type { RunExecutedOn } from "../shared/openAdminOS";

/** Where a run executed: this desktop, or a sandbox on the customer's own infrastructure. */
export const RUN_LOCATION_COPY = {
  label: "Where",
  thisComputer: "This computer",
  filterAll: "Where: All",
  filterOption: (name: string) => `Where: ${name}`,
  /** Run detail line for a sandbox run; it replaces the on-device claim. */
  ranOn: (name: string, model: string) => `Ran on ${name} · local model ${model}`,
  /** Runs list boundary segment for a sandbox run. */
  sandboxBoundary: (name: string) => `local model on ${name}`,
  /** Provider fact of a sandbox run: the model server on the sandbox, not a desktop provider. */
  sandboxProvider: (name: string) => `Local model on ${name}`,
} as const;

/** The Where label: absent or desktop is this computer, a sandbox shows its name. */
export function runLocationLabel(executedOn: RunExecutedOn | undefined): string {
  return executedOn?.kind === "sandbox" ? executedOn.name : RUN_LOCATION_COPY.thisComputer;
}
