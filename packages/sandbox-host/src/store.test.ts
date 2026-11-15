import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("pages runs by a cursor that grows with every write", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"), 3);
      assert.equal(store.latestCursor(), 0);
      for (let index = 0; index < 4; index += 1) store.write(run(index));
      // run_0000 was pruned; the rest come in write order.
      const first = store.listAfter(0, 2).runs;
      assert.deepEqual(first.map((entry) => entry.run.id), ["run_0001", "run_0002"]);
      const second = store.listAfter(first[1]!.cursor, 10).runs;
      assert.deepEqual(second.map((entry) => entry.run.id), ["run_0003"]);
      const empty = store.listAfter(second[0]!.cursor, 10);
      assert.deepEqual(empty, { runs: [], next: second[0]!.cursor, generation: empty.generation, problems: [] }, "no cursor-reset condition");
      // A run written again moves to a new cursor, once.
      store.write({ ...run(2), summary: "again" });
      const changed = store.listAfter(second[0]!.cursor, 10).runs;
      assert.deepEqual(changed.map((entry) => [entry.run.id, entry.run.summary]), [["run_0002", "again"]]);
      assert.equal(changed[0]!.cursor, store.latestCursor());
      // A new store reads the same index.
      assert.deepEqual(new RunStore(join(dir, "runs"), 3).listAfter(0, 10).runs.map((entry) => entry.run.id), ["run_0001", "run_0003", "run_0002"]);
      assert.throws(() => store.listAfter(-1, 1), RangeError);
      assert.throws(() => store.listAfter(0, 0), RangeError);
    } finally {
      cleanup();
    }
  });

  it("gives a run written after the last index update a new cursor at startup", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      store.write(run(1, "running"));
      const seen = store.latestCursor();
      const index = readFileSync(join(dir, "runs", "cursor.json"), "utf8");
      store.write({ ...run(1), summary: "done" });
      // As if the host stopped between the run file and the index.
      writeFileSync(join(dir, "runs", "cursor.json"), index);
      const restarted = new RunStore(join(dir, "runs"));
      const page = restarted.listAfter(seen, 10);
      assert.deepEqual(page.runs.map((entry) => [entry.run.id, entry.run.status, entry.run.summary]), [["run_0001", "completed", "done"]]);
      assert.ok(page.next > seen);
      // Reconciled once: a second start finds nothing new.
      assert.deepEqual(new RunStore(join(dir, "runs")).listAfter(page.next, 10).runs, []);
    } finally {
      cleanup();
    }
  });

  it("passes an unreadable run file and names it, so the reader does not stall", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      const path = store.write(run(1));
      store.write(run(2));
      writeFileSync(path, "not json");
      const page = store.listAfter(0, 10);
      assert.deepEqual(page.runs.map((entry) => entry.run.id), ["run_0002"]);
      assert.equal(page.problems.length, 1);
      assert.equal(page.problems[0]!.reason, "storage-corrupt");
      assert.equal(page.problems[0]!.runId, "run_0001");
      assert.equal(page.next, store.latestCursor());
    } finally {
      cleanup();
    }
  });

  it("refuses an index whose entries name unsafe paths, and rebuilds it", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      store.write(run(1));
      const index = JSON.parse(readFileSync(join(dir, "runs", "cursor.json"), "utf8")) as { runs: Record<string, { file: string }> };
      index.runs.run_0001!.file = "../../../etc/passwd";
      writeFileSync(join(dir, "runs", "cursor.json"), JSON.stringify(index));
      const rebuilt = new RunStore(join(dir, "runs"));
      const page = rebuilt.listAfter(0, 10);
      assert.deepEqual(page.runs.map((entry) => entry.run.id), ["run_0001"]);
      const written = JSON.parse(readFileSync(join(dir, "runs", "cursor.json"), "utf8")) as { runs: Record<string, { file: string }> };
      assert.match(written.runs.run_0001!.file, /^[0-9T-]+Z_run_0001\.json$/);
    } finally {
      cleanup();
    }
  });

  it("numbers a lost index above its high-water mark even when the clock went back", () => {
    const { dir, cleanup } = tempDir();
    try {
      let now = 5_000_000;
      const store = new RunStore(join(dir, "runs"), undefined, () => now);
      for (let index = 0; index < 3; index += 1) store.write(run(index));
      const seen = store.listAfter(0, 10);
      // The index is lost and the clock was set back, below every cursor given out.
      rmSync(join(dir, "runs", "cursor.json"));
      now = 10;
      const rebuilt = new RunStore(join(dir, "runs"), undefined, () => now).listAfter(seen.next, 10);
      assert.deepEqual(rebuilt.runs.map((entry) => entry.run.id), ["run_0000", "run_0001", "run_0002"]);
      assert.ok(rebuilt.runs.every((entry) => entry.cursor > seen.next));
      assert.equal(rebuilt.generation, seen.generation, "the same generation: the reader's cursor still holds");
      assert.equal(rebuilt.condition, undefined);
    } finally {
      cleanup();
    }
  });

  it("says cursor-reset with a new generation when the index and its high-water mark are both lost", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"), undefined, () => 1_000);
      store.write(run(1));
      const before = store.listAfter(0, 10);
      rmSync(join(dir, "runs", "cursor.json"));
      rmSync(join(dir, "runs", "cursor-high-water.json"));
      const after = new RunStore(join(dir, "runs"), undefined, () => 2).listAfter(0, 10);
      assert.equal(after.condition?.code, "cursor-reset");
      assert.notEqual(after.generation, before.generation);
      assert.deepEqual(after.runs.map((entry) => entry.run.id), ["run_0001"]);
      // A fresh data folder is not a reset.
      const { dir: fresh, cleanup: cleanFresh } = tempDir();
      try {
        assert.equal(new RunStore(join(fresh, "runs")).listAfter(0, 10).condition, undefined);
      } finally {
        cleanFresh();
      }
    } finally {
      cleanup();
    }
  });

  it("rebuilds an index with duplicate cursors, a cursor of 0, or a counter below its cursors", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      store.write(run(1));
      store.write(run(2));
      const path = join(dir, "runs", "cursor.json");
      const good = JSON.parse(readFileSync(path, "utf8")) as { counter: number; runs: Record<string, { cursor: number }> };
      const variants = [
        { ...good, runs: { ...good.runs, run_0002: { ...good.runs.run_0002!, cursor: good.runs.run_0001!.cursor } } },
        { ...good, runs: { ...good.runs, run_0001: { ...good.runs.run_0001!, cursor: 0 } } },
        { ...good, counter: 1 },
      ];
      for (const variant of variants) {
        writeFileSync(path, JSON.stringify(variant));
        const page = new RunStore(join(dir, "runs")).listAfter(0, 10);
        const cursors = page.runs.map((entry) => entry.cursor);
        assert.equal(new Set(cursors).size, 2);
        assert.ok(cursors.every((cursor) => cursor > good.counter), "rebuilt above the high-water mark");
      }
    } finally {
      cleanup();
    }
  });

  it("rebuilds a lost index above any earlier cursor", () => {
    const { dir, cleanup } = tempDir();
    try {
      const store = new RunStore(join(dir, "runs"));
      store.write(run(1));
      const before = store.latestCursor();
      writeFileSync(join(dir, "runs", "cursor.json"), "not json");
      const rebuilt = new RunStore(join(dir, "runs"));
      const entries = rebuilt.listAfter(before, 10).runs;
      assert.deepEqual(entries.map((entry) => entry.run.id), ["run_0001"]);
      assert.ok(entries[0]!.cursor > before);
    } finally {
      cleanup();
    }
  });


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

describe("HealthStore write failures", () => {
  it("keeps the earlier state when health.json cannot be written", () => {
    const { dir, cleanup } = tempDir();
    const folder = join(dir, "data");
    try {
      mkdirSync(folder, { mode: 0o700 });
      const path = join(folder, "health.json");
      const health = new HealthStore(path, "mini-pc");
      health.update("a", { lastNoticeReason: "model-unreachable" }, new Date());
      chmodSync(folder, 0o500);
      assert.throws(() => health.update("a", { lastNoticeReason: "certificate-expired" }, new Date()));
      assert.equal(health.get("a").lastNoticeReason, "model-unreachable", "memory does not run ahead of the file");
      chmodSync(folder, 0o700);
      assert.equal(new HealthStore(path, "mini-pc").get("a").lastNoticeReason, "model-unreachable");
    } finally {
      chmodSync(folder, 0o700);
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
