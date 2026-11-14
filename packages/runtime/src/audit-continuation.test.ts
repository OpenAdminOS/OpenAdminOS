import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { AUDIT_CONTINUATION_START, verifyAuditContinuation, type AuditContinuationFailure } from "./audit-continuation.js";
import { AUDIT_CHAIN_START_HASH, appendSandboxEvent, AuditLogStore, chainHash, type AuditLogPosition, type AuditLogRangeRow } from "./audit-log.js";

const context = { tenantId: "tenant-1", organizationId: "org-1", sandboxId: "mini-pc", runId: "run_1", agentSlug: "find-inactive-devices", initiator: "schedule" as const };

async function withStore(count: number, test: (store: AuditLogStore) => void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "oaos-audit-continuation-"));
  const store = new AuditLogStore(join(dir, "openadminos.db"));
  try {
    for (let index = 0; index < count; index += 1) appendSandboxEvent(store, context, "sandbox.token.acquired", { index });
    test(store);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const position = (row: AuditLogRangeRow): AuditLogPosition => ({ seq: row.seq, sha256: row.sha256 });

describe("AuditLogStore range reads", () => {
  it("reads rows after a seq in order, and the tip", async () => {
    await withStore(0, (store) => {
      assert.deepEqual(store.tip(), AUDIT_CONTINUATION_START);
      assert.deepEqual(store.readRange(0, 10), []);
    });
    await withStore(5, (store) => {
      const rows = store.readRange(2, 2);
      assert.deepEqual(rows.map((row) => row.seq), [3, 4]);
      assert.deepEqual(Object.keys(rows[0]!).sort(), ["event_json", "previous_sha256", "seq", "sha256"]);
      const all = store.readRange(0, 100);
      assert.equal(all.length, 5);
      assert.deepEqual(store.tip(), position(all[4]!));
      assert.throws(() => store.readRange(-1, 1), RangeError);
      assert.throws(() => store.readRange(0, 0), RangeError);
    });
  });
});

describe("verifyAuditContinuation", () => {
  it("accepts a log read in several batches and moves the pin each time", async () => {
    await withStore(7, (store) => {
      let pin = AUDIT_CONTINUATION_START;
      const seen: number[] = [];
      for (;;) {
        const rows = store.readRange(pin.seq, 3);
        const result = verifyAuditContinuation(pin, rows, store.tip());
        assert.equal(result.ok, true, JSON.stringify(result));
        if (!result.ok) return;
        seen.push(...rows.map((row) => row.seq));
        if (rows.length === 0) break;
        pin = result.pin;
      }
      assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual(pin, store.tip());
      // Later appends continue from the same pin.
      appendSandboxEvent(store, context, "sandbox.token.acquired", { index: 7 });
      const result = verifyAuditContinuation(pin, store.readRange(pin.seq, 10), store.tip());
      assert.deepEqual(result, { ok: true, pin: store.tip() });
    });
  });

  it("names each broken continuation", async () => {
    await withStore(5, (store) => {
      const rows = store.readRange(0, 10);
      const tip = store.tip();
      const pinAt2 = position(rows[1]!);
      const cases: { name: string; pin: AuditLogPosition; rows: AuditLogRangeRow[]; tip: AuditLogPosition; failure: AuditContinuationFailure; seq: number }[] = [
        { name: "a skipped seq", pin: pinAt2, rows: [rows[2]!, rows[4]!], tip, failure: "chain-gap", seq: 4 },
        { name: "a batch that starts after the pin", pin: AUDIT_CONTINUATION_START, rows: rows.slice(1), tip, failure: "chain-gap", seq: 1 },
        { name: "a first row not chained to the pin", pin: { seq: 2, sha256: "f".repeat(64) }, rows: rows.slice(2), tip, failure: "chain-fork", seq: 3 },
        {
          name: "a row chained to a different previous hash",
          pin: pinAt2,
          rows: [rows[2]!, { ...rows[3]!, previous_sha256: "e".repeat(64) }],
          tip,
          failure: "chain-fork",
          seq: 4,
        },
        { name: "a row delivered again", pin: pinAt2, rows: [rows[1]!], tip, failure: "chain-fork", seq: 2 },
        { name: "a tip that differs at the last delivered seq", pin: pinAt2, rows: rows.slice(2), tip: { seq: 5, sha256: "d".repeat(64) }, failure: "chain-fork", seq: 5 },
        { name: "a tip below the pin", pin: position(rows[3]!), rows: [], tip: pinAt2, failure: "chain-rollback", seq: 2 },
        { name: "a different hash at the pinned seq", pin: pinAt2, rows: [], tip: { seq: 2, sha256: "c".repeat(64) }, failure: "chain-rollback", seq: 2 },
        { name: "a tip below the rows delivered", pin: pinAt2, rows: rows.slice(2), tip: position(rows[2]!), failure: "chain-rollback", seq: 3 },
        {
          name: "content changed after hashing",
          pin: pinAt2,
          rows: [{ ...rows[2]!, event_json: rows[2]!.event_json.replace('"index":2', '"index":9') }],
          tip,
          failure: "chain-row-invalid",
          seq: 3,
        },
        { name: "content that is not JSON", pin: pinAt2, rows: [{ ...rows[2]!, event_json: "{" }], tip, failure: "chain-row-invalid", seq: 3 },
        { name: "a stored hash that was replaced", pin: pinAt2, rows: [{ ...rows[2]!, sha256: "b".repeat(64) }], tip, failure: "chain-row-invalid", seq: 3 },
        { name: "a seq that is not a number", pin: pinAt2, rows: [{ ...rows[2]!, seq: Number.NaN }], tip, failure: "chain-position-invalid", seq: -1 },
        { name: "a fractional seq", pin: pinAt2, rows: [{ ...rows[2]!, seq: 2.5 }], tip, failure: "chain-position-invalid", seq: -1 },
        { name: "a hash that is not hex", pin: pinAt2, rows: [{ ...rows[2]!, previous_sha256: "Z".repeat(64) }], tip, failure: "chain-position-invalid", seq: 3 },
        { name: "a tip with a negative seq", pin: pinAt2, rows: [], tip: { ...tip, seq: -1 }, failure: "chain-position-invalid", seq: -1 },
        { name: "a pin seq that is not a number", pin: { ...pinAt2, seq: Number.NaN }, rows: [rows[2]!], tip, failure: "chain-position-invalid", seq: -1 },
        { name: "a pin that is null", pin: null as unknown as AuditLogPosition, rows: [rows[2]!], tip, failure: "chain-position-invalid", seq: -1 },
        { name: "a tip that is not an object", pin: pinAt2, rows: [], tip: "tip" as unknown as AuditLogPosition, failure: "chain-position-invalid", seq: -1 },
        { name: "rows that are not a list", pin: pinAt2, rows: { length: 1 } as unknown as AuditLogRangeRow[], tip, failure: "chain-position-invalid", seq: -1 },
        { name: "a row that is null", pin: pinAt2, rows: [null as unknown as AuditLogRangeRow], tip, failure: "chain-position-invalid", seq: -1 },
        { name: "a row that is a string", pin: pinAt2, rows: ["row" as unknown as AuditLogRangeRow], tip, failure: "chain-position-invalid", seq: -1 },
        { name: "a row without a previous hash", pin: pinAt2, rows: [{ ...rows[2]!, previous_sha256: undefined as unknown as string }], tip, failure: "chain-position-invalid", seq: 3 },
        {
          name: "content stored with other spacing than canonical JSON",
          pin: pinAt2,
          rows: [{ ...rows[2]!, event_json: JSON.stringify(JSON.parse(rows[2]!.event_json), null, 1) }],
          tip,
          failure: "chain-row-invalid",
          seq: 3,
        },
      ];
      for (const testCase of cases) {
        const result = verifyAuditContinuation(testCase.pin, testCase.rows, testCase.tip);
        assert.equal(result.ok, false, testCase.name);
        if (result.ok) continue;
        assert.equal(result.failure, testCase.failure, testCase.name);
        assert.equal(result.seq, testCase.seq, testCase.name);
        assert.ok(result.detail.length > 0, testCase.name);
      }
    });
  });

  it("hashes the stored text, so a different spelling of the same value is refused", () => {
    const hashedAs = '{"value":null}';
    const sha256 = chainHash(AUDIT_CHAIN_START_HASH, hashedAs);
    const tip = { seq: 1, sha256 };
    const row = (event_json: string): AuditLogRangeRow => ({ seq: 1, previous_sha256: AUDIT_CHAIN_START_HASH, sha256, event_json });
    assert.deepEqual(verifyAuditContinuation(AUDIT_CONTINUATION_START, [row(hashedAs)], tip), { ok: true, pin: tip });
    // 1e400 parses to Infinity, which canonical JSON writes as null.
    for (const respelled of ['{"value":1e400}', '{"value":2,"value":null}', '{ "value": null }']) {
      const result = verifyAuditContinuation(AUDIT_CONTINUATION_START, [row(respelled)], tip);
      assert.equal(result.ok ? "accepted" : result.failure, "chain-row-invalid", respelled);
    }
  });
});
