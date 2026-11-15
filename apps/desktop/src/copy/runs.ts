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
  /** Run detail fact for a sandbox run: whether the desktop checked it against the sandbox's signed audit chain. */
  auditLabel: "Audit",
  verified: (name: string) => `Verified against ${name}'s audit chain`,
  notVerified: (name: string) => `Reported by ${name}, not verified`,
} as const;

/**
 * The audit line of a sandbox run: verified only when the desktop found
 * the run's finished event in audit rows it checked against a checkpoint
 * signed by that sandbox. Undefined for a run on this computer.
 */
export function runVerificationLabel(run: { executedOn?: RunExecutedOn; attestedBy?: { sandboxId: string } }): string | undefined {
  const sandbox = run.executedOn?.kind === "sandbox" ? run.executedOn : undefined;
  if (!sandbox) return undefined;
  return run.attestedBy?.sandboxId === sandbox.sandboxId ? RUN_LOCATION_COPY.verified(sandbox.name) : RUN_LOCATION_COPY.notVerified(sandbox.name);
}

/** The Where label: absent or desktop is this computer, a sandbox shows its name. */
export function runLocationLabel(executedOn: RunExecutedOn | undefined): string {
  return executedOn?.kind === "sandbox" ? executedOn.name : RUN_LOCATION_COPY.thisComputer;
}
