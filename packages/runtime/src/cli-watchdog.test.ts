import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";

import { CLI_WATCHDOG_MAX_LIMIT_MS, CliWatchdogError, cliWatchdogLimits, startCliWatchdog } from "./cli-watchdog.js";

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

  it("does not count a pause the consumer causes as silence, and restarts the silence timer on the next touch", () => {
    let stops = 0;
    const watchdog = startCliWatchdog("Claude Code", { idleMs: 1_000, maxMs: 60_000 }, () => { stops += 1; });
    mock.timers.tick(999);
    watchdog.pauseIdle();
    mock.timers.tick(10_000);
    assert.equal(stops, 0, "a consumer holding a chunk does not end the run");
    watchdog.touch();
    mock.timers.tick(999);
    assert.equal(stops, 0);
    mock.timers.tick(1);
    assert.equal(watchdog.error()?.stop, "stalled");
    watchdog.clear();
  });

  it("keeps only the hard cap once the output has ended", () => {
    let stops = 0;
    const watchdog = startCliWatchdog("Codex CLI", { idleMs: 1_000, maxMs: 60_000 }, () => { stops += 1; });
    watchdog.endOutput();
    watchdog.touch();
    mock.timers.tick(59_999);
    assert.equal(stops, 0, "no silence limit after the output ended");
    mock.timers.tick(1);
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

  it("bounds the wait for the first output by the silence limit and names its variable", () => {
    let stops = 0;
    const env = { idleMs: "OPENADMINOS_CLAUDE_CODE_IDLE_TIMEOUT_MS", maxMs: "OPENADMINOS_CLAUDE_CODE_TIMEOUT_MS" };
    const watchdog = startCliWatchdog("Claude Code", { idleMs: 90_000, maxMs: 900_000, env }, () => { stops += 1; });
    mock.timers.tick(90_000);
    assert.equal(stops, 1);
    assert.equal(
      watchdog.error()?.message,
      "Claude Code stopped sending output for 90 seconds, so OpenAdminOS ended the request. Test the provider in Settings, then retry. If the model works silently for longer, set OPENADMINOS_CLAUDE_CODE_IDLE_TIMEOUT_MS to a higher limit in milliseconds and restart OpenAdminOS.",
    );
    watchdog.clear();

    const capped = startCliWatchdog("Claude Code", { idleMs: 90_000, maxMs: 60_000, env }, () => undefined);
    mock.timers.tick(60_000);
    assert.match(capped.error()?.message ?? "", /To allow longer requests, set OPENADMINOS_CLAUDE_CODE_TIMEOUT_MS in milliseconds and restart OpenAdminOS\.$/);
    capped.clear();
  });
});

describe("cliWatchdogLimits", () => {
  const env = { idleMs: "IDLE_MS", maxMs: "MAX_MS" };
  const defaults = { idleMs: 90_000, maxMs: 900_000 };

  it("takes an option first, then the environment, then the default", () => {
    assert.deepEqual(cliWatchdogLimits({ defaults, env, environment: {} }), { ...defaults, env });
    assert.deepEqual(
      cliWatchdogLimits({ defaults, env, environment: { IDLE_MS: "300000", MAX_MS: " 3600000 " } }),
      { idleMs: 300_000, maxMs: 3_600_000, env },
    );
    assert.deepEqual(
      cliWatchdogLimits({ idleMs: 500, maxMs: 1_000, defaults, env, environment: { IDLE_MS: "300000", MAX_MS: "3600000" } }),
      { idleMs: 500, maxMs: 1_000, env },
    );
  });

  it("ignores a value that is not a positive whole number of milliseconds", () => {
    for (const value of ["", "abc", "0", "-5", "1.5", "90s", "1e6", "99999999999999999999", "2147483648", "86400000000"]) {
      assert.deepEqual(
        cliWatchdogLimits({ defaults, env, environment: { IDLE_MS: value, MAX_MS: value } }),
        { ...defaults, env },
        JSON.stringify(value),
      );
    }
  });

  it("ignores an option that is not a positive whole number of milliseconds up to the timer limit", () => {
    for (const value of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, CLI_WATCHDOG_MAX_LIMIT_MS + 1, 86_400_000_000]) {
      assert.deepEqual(
        cliWatchdogLimits({ idleMs: value, maxMs: value, defaults, env, environment: {} }),
        { ...defaults, env },
        String(value),
      );
      // The environment, then the default, applies in its place.
      assert.deepEqual(
        cliWatchdogLimits({ idleMs: value, maxMs: value, defaults, env, environment: { IDLE_MS: "300000" } }),
        { idleMs: 300_000, maxMs: defaults.maxMs, env },
        String(value),
      );
    }
    assert.deepEqual(
      cliWatchdogLimits({ idleMs: CLI_WATCHDOG_MAX_LIMIT_MS, maxMs: 1, defaults, env, environment: {} }),
      { idleMs: CLI_WATCHDOG_MAX_LIMIT_MS, maxMs: 1, env },
    );
  });

  it("takes the longest limit a Node timer can wait, and ignores a longer one", () => {
    assert.equal(CLI_WATCHDOG_MAX_LIMIT_MS, 2 ** 31 - 1);
    assert.deepEqual(
      cliWatchdogLimits({ defaults, env, environment: { IDLE_MS: String(CLI_WATCHDOG_MAX_LIMIT_MS), MAX_MS: String(CLI_WATCHDOG_MAX_LIMIT_MS + 1) } }),
      { idleMs: CLI_WATCHDOG_MAX_LIMIT_MS, maxMs: defaults.maxMs, env },
    );
  });
});
