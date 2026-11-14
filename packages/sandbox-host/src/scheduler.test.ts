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
});
