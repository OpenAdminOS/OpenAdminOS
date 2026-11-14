import type { KeyObject } from "node:crypto";

import {
  verifyAuditContinuation,
  type AuditContinuationFailure,
  type AuditLogPosition,
  type AuditLogRangeRow,
} from "@openadminos/runtime";

import { verifyAuditCheckpoint } from "./records.js";

export type SignedContinuationFailure =
  /** The checkpoint is malformed or its signature does not verify with the sandbox key. */
  | "checkpoint-signature-invalid"
  /** The checkpoint is signed, but for another pairing or sandbox than expected. */
  | "checkpoint-pairing-mismatch"
  /** The batch does not end at the signed checkpoint, so its rows are not covered by a signature. */
  | "checkpoint-not-reached"
  | AuditContinuationFailure;

export type SignedContinuationResult =
  | { ok: true; pin: AuditLogPosition }
  | { ok: false; failure: SignedContinuationFailure; seq: number; detail: string };

export interface SignedContinuationExpectation {
  pairingId: string;
  sandboxId: string;
}

/**
 * Checks a batch of a sandbox's audit rows against the desktop's pin and
 * the sandbox's signed checkpoint. The checkpoint signature is checked
 * first, then that it was signed for this pairing and sandbox, then the
 * hash chain with the signed seq and hash as the tip.
 *
 * A batch is accepted only when its last row is the signed checkpoint
 * (or there are no rows and the pin already is). Rows that end before
 * the checkpoint are not covered by the signature: a chained but
 * fabricated row followed by a genuine checkpoint further on would
 * otherwise move the pin. The host signs a checkpoint at the end of each
 * batch. The pin moves only on ok.
 *
 * `sandboxPublicKey` and `expected` come from the stored pairing record.
 */
export function verifySignedContinuation(
  pin: AuditLogPosition,
  rows: readonly AuditLogRangeRow[],
  signedTip: unknown,
  sandboxPublicKey: KeyObject | string,
  expected: SignedContinuationExpectation,
): SignedContinuationResult {
  const checkpoint = verifyAuditCheckpoint(signedTip, sandboxPublicKey);
  if (!checkpoint.ok) {
    return { ok: false, failure: "checkpoint-signature-invalid", seq: -1, detail: checkpoint.detail };
  }
  const tip = checkpoint.value;
  if (tip.pairingId !== expected.pairingId || tip.sandboxId !== expected.sandboxId) {
    return {
      ok: false,
      failure: "checkpoint-pairing-mismatch",
      seq: tip.seq,
      detail: `The checkpoint is signed for pairing ${tip.pairingId} on sandbox ${tip.sandboxId}, not pairing ${expected.pairingId} on sandbox ${expected.sandboxId}.`,
    };
  }
  const result = verifyAuditContinuation(pin, rows, { seq: tip.seq, sha256: tip.sha256 });
  if (result.ok && (result.pin.seq !== tip.seq || result.pin.sha256 !== tip.sha256)) {
    return {
      ok: false,
      failure: "checkpoint-not-reached",
      seq: result.pin.seq,
      detail: `The entries delivered end at entry ${result.pin.seq}, but the signed checkpoint is at entry ${tip.seq}. Only a batch that ends at its signed checkpoint is accepted.`,
    };
  }
  return result;
}
