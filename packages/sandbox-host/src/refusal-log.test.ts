import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RefusalLog } from "./refusal-log.js";

function capture() {
  const lines: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
  let now = 0;
  const log = new RefusalLog((_level, message, fields) => lines.push({ message, fields }), () => now);
  return { lines, log, advance: (ms: number) => (now += ms) };
}

describe("RefusalLog", () => {
  it("writes one line per peer and reason a minute, with the count since the last line", () => {
    const { lines, log, advance } = capture();
    for (let index = 0; index < 500; index += 1) log.note("client-not-paired", "Refused.", "10.0.0.5");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.fields?.count, 1);
    log.note("pairing-rate-limited", "Refused.", "10.0.0.5");
    assert.equal(lines.length, 2, "another reason has its own line");
    advance(60_000);
    log.note("client-not-paired", "Refused.", "10.0.0.5");
    assert.equal(lines.length, 3);
    assert.equal(lines[2]!.fields?.count, 500, "the 499 left out and this one");
  });

  it("writes at most 10 lines a minute in total, then one summary line", () => {
    const { lines, log, advance } = capture();
    for (let index = 0; index < 1_000; index += 1) log.note("client-not-paired", "Refused.", `10.0.${Math.floor(index / 256)}.${index % 256}`);
    assert.equal(lines.length, 10);
    advance(60_000);
    log.note("client-not-paired", "Refused.", "10.9.9.9");
    assert.equal(lines.length, 12);
    assert.equal(lines[10]!.fields?.reason, "refusals-left-out");
    assert.equal(lines[10]!.fields?.count, 990);
  });
});
