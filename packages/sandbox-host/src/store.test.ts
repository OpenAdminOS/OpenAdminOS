import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { RunRecord } from "@openadminos/agent-sdk";

import { HealthStore, RunStore, writeFileAtomic } from "./store.js";
import { tempDir } from "./test-support.js";

function run(index: number, status: RunRecord["status"] = "completed"): RunRecord {
  const queuedAt = new Date(Date.UTC(2026, 10, 14, 0, 0, index)).toISOString();
  return { id: `run_${index.toString().padStart(4, "0")}`, agentSlug: "find-inactive-devices", status, queuedAt, steps: [], logs: [] };
}

describe("RunStore", () => {
  it("keeps the newest runs per agent and removes the rest", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"), 5);
      for (let index = 0; index < 8; index += 1) store.write(run(index));
      const runs = store.list("find-inactive-devices");
      assert.deepEqual(runs.map((entry) => entry.id), ["run_0003", "run_0004", "run_0005", "run_0006", "run_0007"]);
      assert.equal(store.latest("find-inactive-devices")?.id, "run_0007");
    } finally {
      cleanup();
    }
  });

  it("writes atomically: no temporary file is left and rewriting replaces the record", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      const path = store.write(run(1, "running"));
      store.write({ ...run(1), summary: "done" });
      const folder = join(dir, "runs", "find-inactive-devices");
      assert.deepEqual(readdirSync(folder), [path.split("/").pop()]);
      assert.equal((JSON.parse(readFileSync(path, "utf8")) as RunRecord).summary, "done");
      writeFileAtomic(join(dir, "x.json"), "{}");
      assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
    } finally {
      cleanup();
    }
  });

  it("marks runs left running as interrupted", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      store.write(run(1, "running"));
      store.write(run(2));
      assert.equal(store.markInterrupted(new Date()), 1);
      const [first, second] = store.list("find-inactive-devices");
      assert.equal(first?.status, "failed");
      assert.match(first?.error ?? "", /Interrupted/);
      assert.equal(second?.status, "completed");
    } finally {
      cleanup();
    }
  });

  it("rejects agent names that would leave the runs folder", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      assert.throws(() => store.write({ ...run(1), agentSlug: "../escape" }));
    } finally {
      cleanup();
    }
  });
});

describe("unreadable files", () => {
  it("names unreadable run files and keeps an unreadable health.json aside", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      store.write(run(1));
      writeFileSync(join(dir, "runs", "find-inactive-devices", "2026-broken.json"), "{not json");
      writeFileSync(join(dir, "runs", "find-inactive-devices", "2026-null.json"), "null");
      writeFileSync(join(dir, "runs", "find-inactive-devices", "2026-shape.json"), JSON.stringify({ id: 1, steps: "x" }));
      assert.deepEqual(store.unreadableFiles(), ["find-inactive-devices/2026-broken.json", "find-inactive-devices/2026-null.json", "find-inactive-devices/2026-shape.json"]);
      assert.equal(store.list("find-inactive-devices").length, 1);
      for (const shape of ['{"version":1,"agents":[]}', "null", '{"version":1,"agents":{"a":{"lastRun":5}}}']) {
        const path = join(dir, `health-${shape.length}.json`);
        writeFileSync(path, shape);
        assert.ok(new HealthStore(path, "mini-pc").problem, shape);
      }
      writeFileSync(join(dir, "health.json"), "{not json");
      const health = new HealthStore(join(dir, "health.json"), "mini-pc");
      assert.match(health.problem ?? "", /health\.json-?.*could not be read|could not be read/);
      assert.ok(readdirSync(dir).some((name) => name.startsWith("health.json.unreadable-")));
    } finally {
      cleanup();
    }
  });
});

describe("HealthStore", () => {
  it("keeps the last run and the last refusal per agent across reloads", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "health.json");
      const health = new HealthStore(path, "mini-pc");
      health.update("a", { lastRefusal: { reason: "identity-has-no-roles", message: "m", at: "t" } }, new Date());
      health.update("a", { lastRun: { runId: "r", status: "completed" } }, new Date());
      const reloaded = new HealthStore(path, "mini-pc");
      assert.equal(reloaded.get("a").lastRefusal?.reason, "identity-has-no-roles");
      assert.equal(reloaded.get("a").lastRun?.runId, "r");
    } finally {
      cleanup();
    }
  });
});
