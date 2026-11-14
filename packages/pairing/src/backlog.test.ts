import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AUDIT_CONTINUATION_START, appendSandboxEvent, AuditLogStore, type AuditLogPosition } from "@openadminos/runtime";

import { verifySignedContinuation } from "./continuation.js";
import { generateDeviceIdentity } from "./identity.js";
import { signAuditCheckpoint, verifyAuditCheckpoint } from "./records.js";

const sandbox = generateDeviceIdentity();
const expected = { pairingId: "pairing-1", sandboxId: "office-mini-pc" };
const context = { tenantId: "11111111-2222-3333-4444-555555555555", organizationId: "org-1", sandboxId: "office-mini-pc", runId: "run_1", agentSlug: "find-inactive-devices", initiator: "schedule" as const };

/** What the host does for one request: a batch after the pin, signed at its last row. */
function hostBatch(store: AuditLogStore, pin: AuditLogPosition, limit: number) {
  const rows = store.readRange(pin.seq, limit);
  const last = rows[rows.length - 1];
  const position = last ? { seq: last.seq, sha256: last.sha256 } : pin;
  const checkpoint = signAuditCheckpoint(
    { ...expected, seq: position.seq, sha256: position.sha256, rowCount: position.seq, at: "2026-11-15T09:00:00.000Z" },
    sandbox.privateKey,
  );
  return { rows, checkpoint };
}

describe("reading a sandbox's audit backlog", () => {
  it("pages a backlog in several batches, each signed at its end", () => {
    const store = new AuditLogStore(":memory:");
    try {
      for (let index = 0; index < 10; index += 1) appendSandboxEvent(store, context, "sandbox.token.acquired", { index });
      let pin = AUDIT_CONTINUATION_START;
      const batches: number[][] = [];
      for (;;) {
        const { rows, checkpoint } = hostBatch(store, pin, 3);
        const result = verifySignedContinuation(pin, rows, checkpoint, sandbox.publicKey, expected);
        assert.ok(result.ok, JSON.stringify(result));
        if (rows.length === 0) {
          assert.deepEqual(result.pin, pin);
          break;
        }
        batches.push(rows.map((row) => row.seq));
        pin = result.pin;
      }
      assert.deepEqual(batches, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10]]);
      assert.deepEqual(pin, store.tip());

      // Rows added later continue from the same pin.
      appendSandboxEvent(store, context, "sandbox.token.acquired", { index: 10 });
      const { rows, checkpoint } = hostBatch(store, pin, 3);
      assert.deepEqual(verifySignedContinuation(pin, rows, checkpoint, sandbox.publicKey, expected), { ok: true, pin: store.tip() });
    } finally {
      store.close();
    }
  });

  it("starts a first sync from a signed position that is not the chain start", () => {
    const store = new AuditLogStore(":memory:");
    try {
      for (let index = 0; index < 5; index += 1) appendSandboxEvent(store, context, "sandbox.token.acquired", { index });
      // As if rows 1 and 2 were pruned before pairing: row 3 is the oldest kept.
      const oldestKept = store.readRange(2, 1)[0]!;
      const start = signAuditCheckpoint(
        { ...expected, seq: oldestKept.seq - 1, sha256: oldestKept.previous_sha256, rowCount: 0, at: "2026-11-15T09:00:00.000Z" },
        sandbox.privateKey,
      );
      const adopted = verifyAuditCheckpoint(start, sandbox.publicKey);
      assert.ok(adopted.ok);
      const pin = { seq: adopted.value.seq, sha256: adopted.value.sha256 };
      const { rows, checkpoint } = hostBatch(store, pin, 10);
      assert.deepEqual(rows.map((row) => row.seq), [3, 4, 5]);
      assert.deepEqual(verifySignedContinuation(pin, rows, checkpoint, sandbox.publicKey, expected), { ok: true, pin: store.tip() });
    } finally {
      store.close();
    }
  });
});
