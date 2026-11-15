import type { RunRecord } from "@openadminos/agent-sdk";
import { runRecordDigest } from "@openadminos/pairing";

/** A run this desktop executed. Runs a paired sandbox reported are never compared with them as earlier runs. */
export function ranOnThisDesktop(run: RunRecord): boolean {
  return run.executedOn === undefined || run.executedOn.kind === "desktop";
}

/**
 * The binding a sandbox run was imported under: sandbox, organization,
 * tenant and the fingerprint of the sandbox's key. Undefined for a desktop
 * run or a sandbox run that lacks any of them.
 */
export function sandboxRunBinding(run: RunRecord): string | undefined {
  const executedOn = run.executedOn;
  if (executedOn?.kind !== "sandbox" || !executedOn.pairingKeyFingerprint || !run.tenantId) return undefined;
  return JSON.stringify([executedOn.sandboxId, executedOn.organizationId, run.tenantId.toLowerCase(), executedOn.pairingKeyFingerprint]);
}

/**
 * The record of a sandbox run as run history keeps it: read normalization
 * applied (`usage` is null when absent) and without the attestation, which
 * the desktop sets later.
 */
export function storedSandboxRun(run: RunRecord): RunRecord {
  const { attestedBy: _attestedBy, ...rest } = run;
  return JSON.parse(JSON.stringify({ ...rest, usage: run.usage ?? null })) as RunRecord;
}

/** The digest of a sandbox run as stored, the same before and after a state.json round trip. */
export function storedSandboxRunDigest(run: RunRecord): string {
  return runRecordDigest(storedSandboxRun(run));
}
