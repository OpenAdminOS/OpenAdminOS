import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { InstanceLock } from "./lock.js";
import { SandboxRefusal } from "./refusal.js";
import { tempDir } from "./test-support.js";

describe("InstanceLock", () => {
  it("refuses a second host on the same data folder and takes over a stale lock", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "sandbox.lock");
      writeFileSync(path, JSON.stringify({ pid: process.ppid }));
      assert.throws(() => new InstanceLock(path).acquire(), (error: unknown) => error instanceof SandboxRefusal && error.reason === "already-running");
      writeFileSync(path, JSON.stringify({ pid: 2_147_483_000 }));
      const lock = new InstanceLock(path);
      lock.acquire();
      lock.release();
      // This pid from an earlier process, as after a container restart.
      writeFileSync(path, JSON.stringify({ pid: process.pid, processStartedAt: 1 }));
      const restarted = new InstanceLock(path);
      restarted.acquire();
      assert.throws(() => new InstanceLock(path).acquire(), (error: unknown) => error instanceof SandboxRefusal && error.reason === "already-running");
      restarted.release();
    } finally {
      cleanup();
    }
  });
});
