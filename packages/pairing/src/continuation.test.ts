import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUDIT_CONTINUATION_START, canonicalJson, chainHash, type AuditLogPosition, type AuditLogRangeRow } from "@openadminos/runtime";

import { verifySignedContinuation } from "./continuation.js";
import { exportDevicePublicKey, generateDeviceIdentity } from "./identity.js";
import { signAuditCheckpoint, type SignedAuditCheckpoint } from "./records.js";

const sandbox = generateDeviceIdentity();
const expected = { pairingId: "pairing-1", sandboxId: "office-mini-pc" };

/** A chain of `count` rows built the way the runtime's audit log builds it. */
function chain(count: number): AuditLogRangeRow[] {
  const rows: AuditLogRangeRow[] = [];
  let previous = AUDIT_CONTINUATION_START.sha256;
  for (let seq = 1; seq <= count; seq += 1) {
    const event = { kind: "sandbox.token.acquired", index: seq };
    const sha256 = chainHash(previous, canonicalJson(event));
    rows.push({ seq, previous_sha256: previous, sha256, event_json: canonicalJson(event) });
    previous = sha256;
  }
  return rows;
}

function tipOf(rows: readonly AuditLogRangeRow[]): AuditLogPosition {
  const last = rows[rows.length - 1];
  return last ? { seq: last.seq, sha256: last.sha256 } : AUDIT_CONTINUATION_START;
}

function signedTip(position: AuditLogPosition, overrides: Partial<{ pairingId: string; sandboxId: string }> = {}): SignedAuditCheckpoint {
  return signAuditCheckpoint({ ...expected, ...overrides, seq: position.seq, sha256: position.sha256, rowCount: position.seq, at: "2026-11-14T13:00:00.000Z" }, sandbox.privateKey);
}

describe("verifySignedContinuation", () => {
  it("accepts batches that each end at their signed checkpoint", () => {
    const rows = chain(6);
    const first = verifySignedContinuation(AUDIT_CONTINUATION_START, rows.slice(0, 3), signedTip(tipOf(rows.slice(0, 3))), sandbox.publicKey, expected);
    assert.deepEqual(first, { ok: true, pin: tipOf(rows.slice(0, 3)) });
    assert.ok(first.ok);
    const second = verifySignedContinuation(first.pin, rows.slice(3), signedTip(tipOf(rows)), exportDevicePublicKey(sandbox.publicKey), expected);
    assert.deepEqual(second, { ok: true, pin: tipOf(rows) });
    // Nothing new: no rows and a checkpoint at the pin.
    assert.deepEqual(verifySignedContinuation(second.ok ? second.pin : AUDIT_CONTINUATION_START, [], signedTip(tipOf(rows)), sandbox.publicKey, expected), { ok: true, pin: tipOf(rows) });
    // An empty log signed at the chain start.
    assert.deepEqual(verifySignedContinuation(AUDIT_CONTINUATION_START, [], signedTip(AUDIT_CONTINUATION_START), sandbox.publicKey, expected), { ok: true, pin: AUDIT_CONTINUATION_START });
  });

  it("does not move the pin for a batch that ends before its signed checkpoint", () => {
    const rows = chain(6);
    const partial = verifySignedContinuation(AUDIT_CONTINUATION_START, rows.slice(0, 3), signedTip(tipOf(rows)), sandbox.publicKey, expected);
    assert.equal(partial.ok, false);
    if (!partial.ok) {
      assert.equal(partial.failure, "checkpoint-not-reached");
      assert.equal(partial.seq, 3);
      assert.ok(!("pin" in partial));
    }
    const none = verifySignedContinuation(AUDIT_CONTINUATION_START, [], signedTip(tipOf(rows)), sandbox.publicKey, expected);
    assert.equal(none.ok ? "accepted" : none.failure, "checkpoint-not-reached");
  });

  it("refuses a fabricated row followed by a genuine checkpoint further on", () => {
    const genuine = chain(2);
    // The attacker makes row 1 chained to the start, with a valid hash of its own content.
    const forgedEvent = { kind: "sandbox.token.acquired", index: 999 };
    const forgedJson = canonicalJson(forgedEvent);
    const forged: AuditLogRangeRow = { seq: 1, previous_sha256: AUDIT_CONTINUATION_START.sha256, sha256: chainHash(AUDIT_CONTINUATION_START.sha256, forgedJson), event_json: forgedJson };
    // The sandbox's real checkpoint at row 2.
    const result = verifySignedContinuation(AUDIT_CONTINUATION_START, [forged], signedTip(tipOf(genuine)), sandbox.publicKey, expected);
    assert.equal(result.ok ? "accepted" : result.failure, "checkpoint-not-reached");
    // With the forged row and the genuine row 2, the chain breaks at row 2.
    const both = verifySignedContinuation(AUDIT_CONTINUATION_START, [forged, genuine[1]!], signedTip(tipOf(genuine)), sandbox.publicKey, expected);
    assert.equal(both.ok ? "accepted" : both.failure, "chain-fork");
  });

  it("names a checkpoint signed with another key, tampered or malformed", () => {
    const rows = chain(3);
    const tip = signedTip(tipOf(rows));
    const failureOf = (signed: unknown, key = sandbox.publicKey): string => {
      const result = verifySignedContinuation(AUDIT_CONTINUATION_START, rows, signed, key, expected);
      return result.ok ? "accepted" : result.failure;
    };
    assert.equal(failureOf(tip, generateDeviceIdentity().publicKey), "checkpoint-signature-invalid");
    assert.equal(failureOf({ ...tip, checkpoint: { ...tip.checkpoint, sha256: "b".repeat(64) } }), "checkpoint-signature-invalid");
    assert.equal(failureOf({ ...tip, signature: "x" }), "checkpoint-signature-invalid");
    assert.equal(failureOf({ checkpoint: tip.checkpoint }), "checkpoint-signature-invalid");
    assert.equal(failureOf(null), "checkpoint-signature-invalid");
    // A checkpoint signed by the desktop, not the sandbox.
    const desktop = generateDeviceIdentity();
    assert.equal(failureOf(signAuditCheckpoint(tip.checkpoint, desktop.privateKey)), "checkpoint-signature-invalid");
  });

  it("names a malformed expectation instead of throwing", () => {
    const rows = chain(2);
    for (const bad of [undefined, null, "pairing-1", [], { pairingId: "pairing-1" }, { pairingId: "", sandboxId: "office-mini-pc" }, { pairingId: "pairing-1", sandboxId: 7 }]) {
      const result = verifySignedContinuation(AUDIT_CONTINUATION_START, rows, signedTip(tipOf(rows)), sandbox.publicKey, bad as unknown as typeof expected);
      assert.equal(result.ok ? "accepted" : result.failure, "expectation-invalid", JSON.stringify(bad));
    }
  });

  it("names a checkpoint signed for another pairing or sandbox", () => {
    const rows = chain(2);
    for (const other of [{ pairingId: "pairing-0" }, { sandboxId: "another-pc" }]) {
      const result = verifySignedContinuation(AUDIT_CONTINUATION_START, rows, signedTip(tipOf(rows), other), sandbox.publicKey, expected);
      assert.equal(result.ok ? "accepted" : result.failure, "checkpoint-pairing-mismatch");
    }
  });

  it("passes the chain failures through", () => {
    const rows = chain(5);
    const tip = signedTip(tipOf(rows));
    const failureOf = (pin: AuditLogPosition, batch: AuditLogRangeRow[], signed: SignedAuditCheckpoint = tip): string => {
      const result = verifySignedContinuation(pin, batch, signed, sandbox.publicKey, expected);
      return result.ok ? "accepted" : result.failure;
    };
    assert.equal(failureOf(AUDIT_CONTINUATION_START, [rows[0]!, rows[2]!]), "chain-gap");
    assert.equal(failureOf(tipOf(rows.slice(0, 2)), [rows[1]!]), "chain-fork");
    // The sandbox now signs a tip before the pin: the log was rolled back.
    assert.equal(failureOf(tipOf(rows), [], signedTip(tipOf(rows.slice(0, 2)))), "chain-rollback");
    const edited = { ...rows[0]!, event_json: canonicalJson({ kind: "sandbox.token.acquired", index: 99 }) };
    assert.equal(failureOf(AUDIT_CONTINUATION_START, [edited]), "chain-row-invalid");
    assert.equal(failureOf({ seq: 1.5, sha256: rows[0]!.sha256 }, []), "chain-position-invalid");
    // Rows that end at another hash than the signed tip at that seq.
    const forked = chain(5);
    forked[4] = { ...forked[4]!, sha256: chainHash(forked[3]!.sha256, canonicalJson({ kind: "other" })), event_json: JSON.stringify({ kind: "other" }) };
    assert.equal(failureOf(tipOf(rows.slice(0, 4)), [forked[4]!]), "chain-fork");
  });
});
