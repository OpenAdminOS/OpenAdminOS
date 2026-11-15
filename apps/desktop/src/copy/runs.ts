import type { RunAttestation, RunExecutedOn } from "../shared/openAdminOS";

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

const FINGERPRINT = /^[0-9A-HJKMNP-TV-Z]{52}$/;

/**
 * Whether the run detail may say a sandbox run was verified: a sandbox
 * run whose attestation names that same sandbox, with every field well
 * formed and the key fingerprint the desktop recorded at import. The one
 * check behind the audit label, its icon and its tone.
 */
export function isRunVerified(run: { executedOn?: RunExecutedOn; attestedBy?: RunAttestation }): boolean {
  const sandbox = run.executedOn?.kind === "sandbox" ? run.executedOn : undefined;
  const attested = run.attestedBy;
  if (!sandbox || !attested || typeof attested !== "object") return false;
  return (
    attested.sandboxId === sandbox.sandboxId &&
    typeof attested.pairingKeyFingerprint === "string" &&
    FINGERPRINT.test(attested.pairingKeyFingerprint) &&
    (sandbox.pairingKeyFingerprint === undefined || sandbox.pairingKeyFingerprint === attested.pairingKeyFingerprint) &&
    Number.isSafeInteger(attested.checkpointSeq) &&
    attested.checkpointSeq >= 0 &&
    typeof attested.verifiedAt === "string" &&
    !Number.isNaN(Date.parse(attested.verifiedAt))
  );
}

/** The audit line of a sandbox run; undefined for a run on this computer. */
export function runVerificationLabel(run: { executedOn?: RunExecutedOn; attestedBy?: RunAttestation }): string | undefined {
  const sandbox = run.executedOn?.kind === "sandbox" ? run.executedOn : undefined;
  if (!sandbox) return undefined;
  return isRunVerified(run) ? RUN_LOCATION_COPY.verified(sandbox.name) : RUN_LOCATION_COPY.notVerified(sandbox.name);
}

/** The Where label: absent or desktop is this computer, a sandbox shows its name. */
export function runLocationLabel(executedOn: RunExecutedOn | undefined): string {
  return executedOn?.kind === "sandbox" ? executedOn.name : RUN_LOCATION_COPY.thisComputer;
}
