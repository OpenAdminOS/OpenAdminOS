import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RefusalLog, type RefusalLogTimers } from "./refusal-log.js";

function capture() {
  const lines: Array<{ message: string; fields: Record<string, unknown> | undefined }> = [];
  let now = 0;
  const pending = new Map<number, () => void>();
  let nextId = 0;
  const timers: RefusalLogTimers = {
    set: (callback) => {
      nextId += 1;
      pending.set(nextId, callback);
      return nextId;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  const log = new RefusalLog((_level, message, fields) => lines.push({ message, fields }), () => now, timers);
  return {
    lines,
    log,
    pending,
    /** Moves the clock and fires the window timer, as setTimeout would. */
    endWindow() {
      now += 60_000;
      for (const [id, callback] of [...pending]) {
        pending.delete(id);
        callback();
      }
    },
  };
}

const peer = (index: number) => `10.0.${Math.floor(index / 256)}.${index % 256}`;

describe("RefusalLog", () => {
  it("writes one line per peer and reason a minute, with the count since the last line", () => {
    const { lines, log, endWindow } = capture();
    for (let index = 0; index < 500; index += 1) log.note("client-not-paired", "Refused.", "10.0.0.5");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.fields?.count, 1);
    log.note("pairing-rate-limited", "Refused.", "10.0.0.5");
    assert.equal(lines.length, 2, "another reason has its own line");
    endWindow();
    log.note("client-not-paired", "Refused.", "10.0.0.5");
    assert.equal(lines.length, 3);
    assert.equal(lines[2]!.fields?.count, 500, "the 499 left out and this one");
  });

  it("keeps a pairing line through a flood of access refusals from many peers", () => {
    const { lines, log } = capture();
    for (let index = 0; index < 1_000; index += 1) log.note("client-not-paired", "Refused.", peer(index));
    log.note("pairing-rate-limited", "Pairing refused.", "192.168.1.20");
    const access = lines.filter((line) => line.fields?.reason === "client-not-paired");
    assert.equal(access.length, 10, "the access group stops at its own cap");
    assert.equal(lines.filter((line) => line.fields?.reason === "pairing-rate-limited").length, 1, "the pairing group has its own budget");
  });

  it("writes the summary when the minute ends, without a further refusal, naming reasons, counts and sample peers", () => {
    const { lines, log, endWindow, pending } = capture();
    for (let index = 0; index < 1_000; index += 1) log.note("client-not-paired", "Refused.", peer(index));
    assert.equal(pending.size, 1, "one window timer");
    endWindow();
    const summary = lines.find((line) => line.fields?.reason === "refusals-left-out");
    assert.ok(summary, "written by the timer");
    assert.equal(summary.fields?.group, "access");
    assert.equal(summary.fields?.count, 990);
    assert.match(summary.message, /client-not-paired=990 \(10\.0\.0\.10, 10\.0\.0\.11, 10\.0\.0\.12, 10\.0\.0\.13, 10\.0\.0\.14, \.\.\.\)/);
    assert.equal(pending.size, 0);
  });

  it("flushes the open window on close and clears its timer", () => {
    const { lines, log, pending } = capture();
    for (let index = 0; index < 20; index += 1) log.note("pairing-rate-limited", "Pairing refused.", peer(index));
    log.close();
    assert.equal(pending.size, 0);
    const summary = lines.find((line) => line.fields?.reason === "refusals-left-out");
    assert.equal(summary?.fields?.group, "pairing");
    assert.equal(summary?.fields?.count, 10);
    log.close();
    assert.equal(lines.filter((line) => line.fields?.reason === "refusals-left-out").length, 1, "nothing to flush twice");
  });
});
