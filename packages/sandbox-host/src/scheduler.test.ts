import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Scheduler, type SchedulerClock } from "./scheduler.js";

/** A clock whose timers fire only when the test advances time. */
function fakeClock(start = 0) {
  let now = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: SchedulerClock = {
    now: () => now,
    setTimer: (callback, delay) => {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    timers,
    async advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = target;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const HOUR = 3_600_000;

describe("Scheduler", () => {
  it("runs an overdue job once after downtime, not once per missed interval", async () => {
    const fake = fakeClock(100 * HOUR);
    let runs = 0;
    const scheduler = new Scheduler([{ id: "a", intervalMs: HOUR, lastStartedAt: 0, run: async () => { runs += 1; } }], fake.clock);
    try {
      scheduler.start();
      await fake.advance(0);
      assert.equal(runs, 1);
      await fake.advance(HOUR - 1);
      assert.equal(runs, 1);
      await fake.advance(1);
      assert.equal(runs, 2);
    } finally {
      await scheduler.stop();
    }
  });

  it("waits for the interval when the last run is recent", async () => {
    const fake = fakeClock(10 * HOUR);
    let runs = 0;
    const scheduler = new Scheduler([{ id: "a", intervalMs: HOUR, lastStartedAt: 10 * HOUR - 1000, run: async () => { runs += 1; } }], fake.clock);
    try {
      scheduler.start();
      await fake.advance(HOUR - 1001);
      assert.equal(runs, 0);
      await fake.advance(1);
      assert.equal(runs, 1);
    } finally {
      await scheduler.stop();
    }
  });

  it("runs one job at a time and does not stack runs that take longer than the interval", async () => {
    const fake = fakeClock(0);
    let running = 0;
    let maxRunning = 0;
    let runs = 0;
    let release: () => void = () => undefined;
    const scheduler = new Scheduler([{
      id: "a",
      intervalMs: HOUR,
      run: async () => {
        runs += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        running -= 1;
      },
    }], fake.clock);
    try {
      scheduler.start();
      await fake.advance(0);
      await fake.advance(5 * HOUR);
      assert.equal(runs, 1);
      assert.equal(fake.timers.size, 0);
      release();
      await fake.advance(0);
      assert.equal(maxRunning, 1);
      assert.equal(fake.timers.size, 1);
      await fake.advance(HOUR);
      assert.equal(runs, 2);
      release();
    } finally {
      await scheduler.stop();
    }
  });

  it("clears its referenced timers on stop", async () => {
    let runs = 0;
    const scheduler = new Scheduler([{ id: "a", intervalMs: 60_000, lastStartedAt: Date.now(), run: async () => { runs += 1; } }]);
    try {
      scheduler.start();
    } finally {
      await scheduler.stop();
    }
    assert.equal(runs, 0);
  });

  it("replaces its jobs without a restart: kept jobs keep their time, new ones start, removed ones stop", async () => {
    const fake = fakeClock(0);
    const runs: string[] = [];
    const job = (id: string, intervalMs: number, lastStartedAt?: number) => ({
      id,
      intervalMs,
      ...(lastStartedAt !== undefined ? { lastStartedAt } : {}),
      run: async () => {
        runs.push(id);
      },
    });
    const scheduler = new Scheduler([job("a", HOUR), job("b", HOUR)], fake.clock);
    try {
      scheduler.start();
      await fake.advance(0);
      assert.deepEqual(runs.sort(), ["a", "b"]);
      runs.length = 0;
      await fake.advance(HOUR / 2);
      // b is removed, c is new and never ran, a stays with the same interval.
      scheduler.replace([job("a", HOUR), job("c", HOUR, -100 * HOUR)]);
      await fake.advance(0);
      assert.deepEqual(runs, ["c"], "an overdue new job runs once, not once per missed interval");
      await fake.advance(HOUR / 2);
      assert.deepEqual(runs, ["c", "a"], "a kept its due time");
      await fake.advance(3 * HOUR);
      assert.ok(!runs.includes("b"), "a removed job is not armed again");
      assert.deepEqual(scheduler.nextRuns().map((next) => next.id).sort(), ["a", "c"]);
    } finally {
      await scheduler.stop();
    }
  });

  it("applies a changed interval from the last start, and never starts a running job twice", async () => {
    const fake = fakeClock(0);
    let starts = 0;
    let finish: (() => void) | undefined;
    const slow = { id: "a", intervalMs: HOUR, run: () => new Promise<void>((resolve) => { starts += 1; finish = resolve; }) };
    const scheduler = new Scheduler([slow], fake.clock);
    try {
      scheduler.start();
      await fake.advance(0);
      assert.equal(starts, 1);
      scheduler.replace([{ ...slow, intervalMs: 2 * HOUR }]);
      await fake.advance(0);
      assert.equal(starts, 1, "still running: not started again");
      finish?.();
      await fake.advance(0);
      await fake.advance(2 * HOUR - 1);
      assert.equal(starts, 1);
      await fake.advance(1);
      assert.equal(starts, 2, "the new interval counts from the last start");
      finish?.();
      await fake.advance(0);
      // Not running now: the shorter interval counts from the start at 2 hours.
      scheduler.replace([{ ...slow, intervalMs: HOUR }]);
      await fake.advance(HOUR - 1);
      assert.equal(starts, 2);
      await fake.advance(1);
      assert.equal(starts, 3);
      finish?.();
    } finally {
      await scheduler.stop();
    }
  });
});
