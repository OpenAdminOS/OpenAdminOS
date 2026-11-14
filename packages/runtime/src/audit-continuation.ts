import {
  AUDIT_CHAIN_START_HASH,
  canonicalJson,
  chainHash,
  type AuditLogPosition,
  type AuditLogRangeRow,
} from "./audit-log.js";

/**
 * Checks that rows read from another audit log, for example a sandbox's,
 * continue the chain from the last row already accepted. The reader
 * keeps a pin (seq and hash of that row), reads the next batch with
 * `readRange(pin.seq, limit)` and then the `tip()`, and moves the pin
 * only when this returns ok.
 *
 * Only the hash chain is checked. Signatures over checkpoints are out of
 * scope here: they need the pairing keys, which come later.
 */

/** The pin before any row is accepted. */
export const AUDIT_CONTINUATION_START: AuditLogPosition = { seq: 0, sha256: AUDIT_CHAIN_START_HASH };

export type AuditContinuationFailure =
  /** A seq was skipped: a row is missing between two delivered ones. */
  | "chain-gap"
  /** A row is not chained to the row before it or to the pin, or the tip disagrees at a seq. */
  | "chain-fork"
  /** The log is now shorter than what was accepted, or holds a different row at the pinned seq. */
  | "chain-rollback"
  /** A row's stored hash is not the hash of its content, or the content is not stored as canonical JSON. */
  | "chain-row-invalid"
  /** A seq is not a non-negative whole number, a hash is not 64 lowercase hex characters, or the pin, tip, rows or a row is not the right shape. */
  | "chain-position-invalid";

export type AuditContinuationResult =
  | { ok: true; pin: AuditLogPosition }
  | { ok: false; failure: AuditContinuationFailure; seq: number; detail: string };

/**
 * `rows` are the rows after `pin`, oldest first; `tip` is the source's
 * newest position, read after the rows. On ok, `pin` is the last row
 * accepted, or the old pin when there were no rows.
 */
export function verifyAuditContinuation(
  pin: AuditLogPosition,
  rows: readonly AuditLogRangeRow[],
  tip: AuditLogPosition,
): AuditContinuationResult {
  // Reject malformed input first: NaN or a fraction passes every
  // comparison below and would let a broken chain through, and a missing
  // object would throw instead of naming the problem.
  for (const [name, position] of [["pin", pin], ["tip", tip]] as const) {
    if (!isObject(position) || !isPosition(position.seq, position.sha256)) {
      return fail("chain-position-invalid", seqOf(position), `the ${name} is not a valid audit position.`);
    }
  }
  if (!Array.isArray(rows)) {
    return fail("chain-position-invalid", -1, "the delivered entries are not a list.");
  }
  for (const row of rows) {
    if (!isObject(row) || !isPosition(row.seq, row.sha256) || typeof row.previous_sha256 !== "string" || !HASH.test(row.previous_sha256) || typeof row.event_json !== "string") {
      return fail("chain-position-invalid", seqOf(row), "a delivered entry has an invalid seq or hash.");
    }
  }
  if (tip.seq < pin.seq) {
    return fail("chain-rollback", tip.seq, `the log ends at entry ${tip.seq}, before entry ${pin.seq} that was already accepted.`);
  }
  if (tip.seq === pin.seq && tip.sha256 !== pin.sha256) {
    return fail("chain-rollback", pin.seq, `entry ${pin.seq} is not the entry that was accepted.`);
  }

  let previous = pin;
  for (const row of rows) {
    if (row.seq > previous.seq + 1) {
      return fail("chain-gap", previous.seq + 1, `entry ${previous.seq + 1} is missing; the next entry delivered is ${row.seq}.`);
    }
    if (row.seq <= previous.seq) {
      return fail("chain-fork", row.seq, `entry ${row.seq} was delivered again after entry ${previous.seq}.`);
    }
    if (row.previous_sha256 !== previous.sha256) {
      return fail("chain-fork", row.seq, `entry ${row.seq} is not chained to entry ${previous.seq}.`);
    }
    let canonical: string;
    try {
      canonical = canonicalJson(JSON.parse(row.event_json));
    } catch {
      return fail("chain-row-invalid", row.seq, `entry ${row.seq} does not hold valid JSON.`);
    }
    // The writer stores canonical JSON and hashes that string. Text that
    // parses to the same value but is spelled differently (1e400 for
    // null, a duplicate key) is not what was hashed.
    if (canonical !== row.event_json) {
      return fail("chain-row-invalid", row.seq, `entry ${row.seq} is not stored as canonical JSON.`);
    }
    if (chainHash(row.previous_sha256, row.event_json) !== row.sha256) {
      return fail("chain-row-invalid", row.seq, `the stored hash of entry ${row.seq} does not match its content.`);
    }
    previous = { seq: row.seq, sha256: row.sha256 };
  }

  if (tip.seq < previous.seq) {
    return fail("chain-rollback", tip.seq, `the log ends at entry ${tip.seq}, before entry ${previous.seq} that was delivered.`);
  }
  if (tip.seq === previous.seq && tip.sha256 !== previous.sha256) {
    return fail("chain-fork", previous.seq, `the newest entry ${previous.seq} differs from the entry delivered.`);
  }
  return { ok: true, pin: previous };
}

const HASH = /^[0-9a-f]{64}$/;

function isPosition(seq: unknown, sha256: unknown): boolean {
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 && typeof sha256 === "string" && HASH.test(sha256);
}

/** The seq of a malformed input when it has a usable one, for the failure; -1 otherwise. */
function seqOf(value: unknown): number {
  const seq = isObject(value) ? value.seq : undefined;
  return typeof seq === "number" && Number.isSafeInteger(seq) ? seq : -1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function fail(failure: AuditContinuationFailure, seq: number, detail: string): AuditContinuationResult {
  return { ok: false, failure, seq, detail };
}
