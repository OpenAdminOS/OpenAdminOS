import type { RunRecord } from "@openadminos/agent-sdk";

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
