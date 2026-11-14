import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

describe("InstanceLock takeover guard", () => {
  it("leaves a stale lock alone while a live host holds the takeover guard", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "sandbox.lock");
      const stale = JSON.stringify({ pid: 2_147_483_000 });
      writeFileSync(path, stale);
      writeFileSync(`${path}.takeover`, JSON.stringify({ pid: process.ppid }));
      assert.throws(() => new InstanceLock(path).acquire(), (error: unknown) => error instanceof SandboxRefusal && error.reason === "already-running");
      assert.equal(readFileSync(path, "utf8"), stale, "the lock was not touched");
    } finally {
      cleanup();
    }
  });

  it("clears a guard left by a dead host and takes over", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "sandbox.lock");
      writeFileSync(path, JSON.stringify({ pid: 2_147_483_000 }));
      writeFileSync(`${path}.takeover`, JSON.stringify({ pid: 2_147_483_001 }));
      const lock = new InstanceLock(path);
      lock.acquire();
      assert.equal(existsSync(`${path}.takeover`), false);
      assert.equal((JSON.parse(readFileSync(path, "utf8")) as { pid: number }).pid, process.pid);
      lock.release();
      assert.equal(existsSync(path), false);
    } finally {
      cleanup();
    }
  });

  it("never removes a live lock: a host that finds one under the guard refuses", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "sandbox.lock");
      const live = JSON.stringify({ pid: process.ppid });
      writeFileSync(path, live);
      assert.throws(() => new InstanceLock(path).acquire(), SandboxRefusal);
      assert.equal(readFileSync(path, "utf8"), live);
      assert.equal(existsSync(`${path}.takeover`), false);
    } finally {
      cleanup();
    }
  });
});

describe("InstanceLock takeover race", () => {
  it("lets exactly one of three hosts take over a stale lock at the same moment", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "sandbox.lock");
      writeFileSync(path, JSON.stringify({ pid: 2_147_483_000 }));
      const child = join(dir, "child.mts");
      writeFileSync(child, `
import { InstanceLock } from ${JSON.stringify(new URL("./lock.ts", import.meta.url).pathname)};
const [path, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* start together */ }
const lock = new InstanceLock(path);
try {
  lock.acquire();
  process.stdout.write("acquired");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  lock.release();
} catch (error) {
  process.stdout.write("refused:" + (error.reason ?? error.message));
}
`);
      const startAt = String(Date.now() + 2000);
      const run = () =>
        new Promise<string>((resolve, reject) => {
          const proc = spawn(process.execPath, ["--import", "tsx", child, path, startAt], { stdio: ["ignore", "pipe", "inherit"] });
          let out = "";
          proc.stdout.on("data", (chunk) => (out += String(chunk)));
          proc.on("error", reject);
          proc.on("close", () => resolve(out));
        });
      const results = (await Promise.all([run(), run(), run()])).sort();
      assert.deepEqual(results, ["acquired", "refused:already-running", "refused:already-running"]);
    } finally {
      cleanup();
    }
  });
});
