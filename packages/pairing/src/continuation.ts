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
 * the sandbox's signed tip. The checkpoint signature is checked first,
 * then the hash chain with the signed seq and hash as the tip. The pin
 * moves only on ok.
 *
 * `sandboxPublicKey` comes from the stored pairing record. With
 * `expected`, a checkpoint signed for another pairing or sandbox is
 * refused too.
 */
export function verifySignedContinuation(
  pin: AuditLogPosition,
  rows: readonly AuditLogRangeRow[],
  signedTip: unknown,
  sandboxPublicKey: KeyObject | string,
  expected?: SignedContinuationExpectation,
): SignedContinuationResult {
  const checkpoint = verifyAuditCheckpoint(signedTip, sandboxPublicKey);
  if (!checkpoint.ok) {
    return { ok: false, failure: "checkpoint-signature-invalid", seq: -1, detail: checkpoint.detail };
  }
  const tip = checkpoint.value;
  if (expected && (tip.pairingId !== expected.pairingId || tip.sandboxId !== expected.sandboxId)) {
    return {
      ok: false,
      failure: "checkpoint-pairing-mismatch",
      seq: tip.seq,
      detail: `The checkpoint is signed for pairing ${tip.pairingId} on sandbox ${tip.sandboxId}, not pairing ${expected.pairingId} on sandbox ${expected.sandboxId}.`,
    };
  }
  return verifyAuditContinuation(pin, rows, { seq: tip.seq, sha256: tip.sha256 });
}
