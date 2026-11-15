import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { runRecordDigest } from "./run-digest.js";

describe("runRecordDigest", () => {
  it("hashes canonical JSON, so key order and whitespace do not matter and content does", () => {
    const run = { id: "run_1", status: "completed", result: { b: 1, a: [1, 2] } };
    const reordered = JSON.parse(JSON.stringify({ result: { a: [1, 2], b: 1 }, status: "completed", id: "run_1" }, null, 2)) as unknown;
    assert.equal(runRecordDigest(run), runRecordDigest(reordered));
    assert.equal(runRecordDigest(run), createHash("sha256").update('{"id":"run_1","result":{"a":[1,2],"b":1},"status":"completed"}').digest("hex"));
    assert.notEqual(runRecordDigest(run), runRecordDigest({ ...run, status: "failed" }));
  });
});
