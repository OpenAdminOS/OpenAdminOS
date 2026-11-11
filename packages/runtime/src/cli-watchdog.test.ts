import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { CliWatchdogError, startCliWatchdog } from "./cli-watchdog.js";

describe("startCliWatchdog", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  it("ends a run that goes silent, and output restarts the silence timer", () => {
    let stops = 0;
    const watchdog = startCliWatchdog("Claude Code", { idleMs: 90_000, maxMs: 900_000 }, () => { stops += 1; });
    mock.timers.tick(89_999);
    watchdog.touch();
    mock.timers.tick(89_999);
    assert.equal(stops, 0);
    assert.equal(watchdog.error(), undefined);
    mock.timers.tick(1);
    assert.equal(stops, 1);
    const error = watchdog.error();
    assert.ok(error instanceof CliWatchdogError);
    assert.equal(error.stop, "stalled");
    assert.equal(
      error.message,
      "Claude Code stopped sending output for 90 seconds, so OpenAdminOS ended the request. Test the provider in Settings, then retry.",
    );
    watchdog.clear();
  });

  it("ends a run at the hard cap even while output keeps arriving", () => {
    let stops = 0;
    const watchdog = startCliWatchdog("Codex CLI", { idleMs: 180_000, maxMs: 900_000 }, () => { stops += 1; });
    for (let elapsed = 0; elapsed < 900_000; elapsed += 60_000) {
      mock.timers.tick(60_000);
      watchdog.touch();
    }
    assert.equal(stops, 1);
    const error = watchdog.error();
    assert.equal(error?.stop, "time-limit");
    assert.equal(
      error?.message,
      "Codex CLI was still working after 15 minutes, the limit for one request, so OpenAdminOS ended it. Narrow the request or split it into smaller steps, then retry.",
    );
    // A stopped watchdog does not stop the run twice.
    mock.timers.tick(900_000);
    assert.equal(stops, 1);
    watchdog.clear();
  });

  it("uses only the hard cap when the silence limit is not below it", () => {
    let stops = 0;
    const watchdog = startCliWatchdog("Claude Code", { idleMs: 120_000, maxMs: 60_000 }, () => { stops += 1; });
    mock.timers.tick(60_000);
    assert.equal(stops, 1);
    assert.equal(watchdog.error()?.stop, "time-limit");
    watchdog.clear();
  });

  it("stops nothing once cleared", () => {
    let stops = 0;
    const watchdog = startCliWatchdog("Claude Code", { idleMs: 1_000, maxMs: 5_000 }, () => { stops += 1; });
    watchdog.clear();
    mock.timers.tick(10_000);
    assert.equal(stops, 0);
    assert.equal(watchdog.error(), undefined);
  });
});
