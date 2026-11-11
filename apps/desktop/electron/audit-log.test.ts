import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { createGraphAdapter, GraphWriteAuditError } from "@openadminos/runtime";

import {
  AUDIT_CHAIN_START_HASH,
  AUDIT_LOG_RETENTION_DAYS,
  AuditLogIntegrityError,
  AuditLogStore,
  canonicalJson,
  graphWriteAuditSink,
  trackedAuditSink,
  type AuditLogEventSeed,
} from "./audit-log.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function event(id: string, timestamp = "2026-11-01T10:00:00.000Z"): AuditLogEventSeed {
  return { id, timestamp, type: "provider.changed", source: "configuration-change", details: { providerId: "ollama" } };
}

async function withDatabase(test: (path: string) => Promise<void> | void): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-audit-log-"));
  try {
    await test(join(dir, "openadminos.db"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("append-only audit log", () => {
  it("chains each row to the one before it when it is inserted, and skips events already stored", async () => {
    await withDatabase((path) => {
      const store = new AuditLogStore(path);
      try {
        assert.equal(store.append([event("a"), event("b")]), 2);
        assert.equal(store.append([event("b"), event("c")]), 1);
        const { events, chain } = store.readVerified();
        assert.deepEqual(events.map((entry) => entry.id), ["a", "b", "c"]);
        let previous = AUDIT_CHAIN_START_HASH;
        for (const stored of events) {
          const { sha256, ...withoutHash } = stored;
          assert.equal(sha256, createHash("sha256").update(previous).update(canonicalJson(withoutHash)).digest("hex"));
          previous = sha256;
        }
        assert.deepEqual(chain, { rowCount: 3, startHash: AUDIT_CHAIN_START_HASH, finalHash: previous });
      } finally {
        store.close();
      }
    });
  });

  it("refuses every update and every replace", async () => {
    await withDatabase((path) => {
      const store = new AuditLogStore(path);
      store.append([event("a")]);
      store.close();
      const db = new DatabaseSync(path);
      try {
        assert.throws(() => db.prepare("UPDATE audit_log SET type = 'changed'").run(), /append-only: a row cannot be changed/);
        assert.throws(
          () => db.prepare(`INSERT OR REPLACE INTO audit_log (event_id, recorded_at, timestamp, type, source, event_json, previous_sha256, sha256)
            VALUES ('a', 'x', 'x', 'x', 'x', '{}', 'x', 'x')`).run(),
          /append-only: a row cannot be replaced/,
        );
      } finally {
        db.close();
      }
    });
  });

  it("refuses to delete a row inside the retention window, or any row but the oldest", async () => {
    await withDatabase((path) => {
      const old = new Date(Date.now() - (AUDIT_LOG_RETENTION_DAYS + 30) * DAY_MS);
      const oldStore = new AuditLogStore(path, () => old);
      oldStore.append([event("old-1"), event("old-2")]);
      oldStore.close();
      const store = new AuditLogStore(path);
      store.append([event("recent")]);
      store.close();
      const db = new DatabaseSync(path);
      try {
        assert.throws(() => db.prepare("DELETE FROM audit_log WHERE event_id = 'recent'").run(), /deleted only oldest first, after 3650 days/);
        assert.throws(() => db.prepare("DELETE FROM audit_log WHERE event_id = 'old-2'").run(), /deleted only oldest first/);
        assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /deleted only oldest first/);
        assert.equal((db.prepare("SELECT COUNT(*) AS count FROM audit_log").get() as { count: number }).count, 3);
        // The oldest row past the window can go.
        assert.equal(Number(db.prepare("DELETE FROM audit_log WHERE event_id = 'old-1'").run().changes), 1);
      } finally {
        db.close();
      }
    });
  });

  it("prunes only rows past the retention window, and the rest still verifies", async () => {
    await withDatabase((path) => {
      const old = new Date(Date.now() - (AUDIT_LOG_RETENTION_DAYS + 1) * DAY_MS);
      const oldStore = new AuditLogStore(path, () => old);
      oldStore.append([event("old-1"), event("old-2")]);
      oldStore.close();
      const store = new AuditLogStore(path);
      try {
        store.append([event("recent")]);
        assert.equal(store.pruneExpired(), 2);
        assert.equal(store.pruneExpired(), 0);
        const { events, chain } = store.readVerified();
        assert.deepEqual(events.map((entry) => entry.id), ["recent"]);
        assert.notEqual(chain.startHash, AUDIT_CHAIN_START_HASH);
      } finally {
        store.close();
      }
    });
  });

  it("reports a changed row as a failed integrity check", async () => {
    await withDatabase((path) => {
      const store = new AuditLogStore(path);
      store.append([event("a"), event("b")]);
      store.close();
      const db = new DatabaseSync(path);
      db.exec("DROP TRIGGER audit_log_refuse_update");
      db.prepare("UPDATE audit_log SET event_json = replace(event_json, 'ollama', 'openai') WHERE event_id = 'b'").run();
      db.close();
      const reopened = new AuditLogStore(path);
      try {
        assert.throws(() => reopened.readVerified(), (error) => {
          assert.ok(error instanceof AuditLogIntegrityError);
          assert.match(error.message, /integrity check at entry 2: its stored hash does not match its content\. It was not exported\./);
          return true;
        });
      } finally {
        reopened.close();
      }
    });
  });
});

describe("audit log anchor", () => {
  function storeWith(path: string, ids: string[]): void {
    const store = new AuditLogStore(path);
    store.append(ids.map((id) => event(id)));
    store.close();
  }

  function bypass(path: string, sql: string): void {
    const db = new DatabaseSync(path);
    try {
      db.exec("DROP TRIGGER IF EXISTS audit_log_refuse_delete");
      db.exec(sql);
    } finally {
      db.close();
    }
  }

  function assertIntegrityError(path: string, reason: RegExp): void {
    const store = new AuditLogStore(path);
    try {
      assert.throws(() => store.readVerified(), (error) => {
        assert.ok(error instanceof AuditLogIntegrityError);
        assert.match(error.message, /^The audit log on this device failed its integrity check: /);
        assert.match(error.message, reason);
        assert.match(error.message, /Keep a copy of openadminos\.db and openadminos\.db-audit-anchor\.json from the app data folder/);
        return true;
      });
    } finally {
      store.close();
    }
  }

  it("finds the newest entries removed, although the rows left still chain", async () => {
    await withDatabase((path) => {
      storeWith(path, ["a", "b", "c"]);
      bypass(path, "DELETE FROM audit_log WHERE event_id = 'c'");
      assertIntegrityError(path, /the newest entries this device recorded are missing/);
    });
  });

  it("finds the oldest entries removed before their retention ended", async () => {
    await withDatabase((path) => {
      storeWith(path, ["a", "b", "c"]);
      bypass(path, "DELETE FROM audit_log WHERE event_id = 'a'");
      assertIntegrityError(path, /the oldest entries this device kept are missing/);
    });
  });

  it("finds a table that was dropped and created again, and keeps reporting it after new appends", async () => {
    await withDatabase((path) => {
      storeWith(path, ["a", "b"]);
      bypass(path, "DROP TABLE audit_log");
      assertIntegrityError(path, /the audit log table is empty, but this device recorded 2 entries in it/);
      // New rows in the new table do not move the anchor over the loss.
      storeWith(path, ["c"]);
      assertIntegrityError(path, /the newest entries this device recorded are missing/);
    });
  });

  it("accepts a table and anchor left by the app, rows appended after the anchor, and a first open of an empty table", async () => {
    await withDatabase((path) => {
      // A first open: the empty table becomes the anchor before any row.
      new AuditLogStore(path).close();
      assert.deepEqual(JSON.parse(readFileSync(`${path}-audit-anchor.json`, "utf8")), {
        version: 1,
        startHash: AUDIT_CHAIN_START_HASH,
        lastHash: AUDIT_CHAIN_START_HASH,
        rowCount: 0,
      });
      storeWith(path, ["a", "b"]);
      const anchorBefore = readFileSync(`${path}-audit-anchor.json`, "utf8");
      // An append whose anchor write did not happen, as after a crash.
      storeWith(path, ["c"]);
      writeFileSync(`${path}-audit-anchor.json`, anchorBefore);
      const store = new AuditLogStore(path);
      try {
        assert.deepEqual(store.readVerified().events.map((entry) => entry.id), ["a", "b", "c"]);
        const anchor = JSON.parse(readFileSync(`${path}-audit-anchor.json`, "utf8")) as { rowCount: number };
        assert.equal(anchor.rowCount, 3);
      } finally {
        store.close();
      }
    });
  });

  it("moves its start with a prune, and continues the chain after every row was pruned", async () => {
    await withDatabase((path) => {
      const old = new Date(Date.now() - (AUDIT_LOG_RETENTION_DAYS + 1) * DAY_MS);
      const oldStore = new AuditLogStore(path, () => old);
      oldStore.append([event("old-1"), event("old-2")]);
      const lastPruned = oldStore.readVerified().chain.finalHash;
      assert.equal(oldStore.pruneExpired(), 2);
      assert.deepEqual(oldStore.readVerified().chain, { rowCount: 0, startHash: lastPruned, finalHash: lastPruned });
      oldStore.close();
      const store = new AuditLogStore(path);
      try {
        store.append([event("recent")]);
        const { events, chain } = store.readVerified();
        assert.deepEqual(events.map((entry) => entry.id), ["recent"]);
        assert.equal(chain.startHash, lastPruned);
      } finally {
        store.close();
      }
    });
  });

  it("reports a missing anchor beside rows, and appends and prunes do not anchor the table again", async () => {
    await withDatabase((path) => {
      storeWith(path, ["a", "b"]);
      rmSync(`${path}-audit-anchor.json`);
      assertIntegrityError(path, /its anchor file openadminos\.db-audit-anchor\.json is missing while the log holds 2 entries\. The anchor was removed outside OpenAdminOS/);
      storeWith(path, ["c"]);
      const store = new AuditLogStore(path);
      try {
        store.pruneExpired();
      } finally {
        store.close();
      }
      assert.equal(existsSync(`${path}-audit-anchor.json`), false);
      assertIntegrityError(path, /is missing while the log holds 3 entries/);
    });
  });

  it("adopts a missing anchor when the table is empty", async () => {
    await withDatabase((path) => {
      new AuditLogStore(path).close();
      rmSync(`${path}-audit-anchor.json`);
      const store = new AuditLogStore(path);
      try {
        assert.deepEqual(store.readVerified().chain, { rowCount: 0, startHash: AUDIT_CHAIN_START_HASH, finalHash: AUDIT_CHAIN_START_HASH });
      } finally {
        store.close();
      }
      storeWith(path, ["a"]);
      const reopened = new AuditLogStore(path);
      try {
        assert.deepEqual(reopened.readVerified().events.map((entry) => entry.id), ["a"]);
      } finally {
        reopened.close();
      }
    });
  });

  it("reports an anchor file that cannot be read", async () => {
    await withDatabase((path) => {
      storeWith(path, ["a"]);
      writeFileSync(`${path}-audit-anchor.json`, "not json");
      assertIntegrityError(path, /its anchor file openadminos\.db-audit-anchor\.json cannot be read/);
    });
  });
});

describe("Graph write audit sink", () => {
  it("records the attempt before the request and the result after it, with one attempt id and no body", async () => {
    const store = new AuditLogStore(":memory:");
    let storedBeforeSend = -1;
    const graph = createGraphAdapter({
      tokenProvider: async () => "token",
      writeAudit: graphWriteAuditSink(store, {
        tenantId: "tenant-1",
        runId: "run-1",
        agentSlug: "offboarding",
        initiator: "schedule",
        actor: { kind: "connected-admin", tenantId: "tenant-1", username: "admin@contoso.example" },
      }),
      fetchImpl: (async () => {
        storedBeforeSend = store.readVerified().events.length;
        return new Response(null, { status: 204, headers: { "request-id": "graph-request-1" } });
      }) as typeof fetch,
    });
    await graph.request({ method: "PATCH", path: "/users/user-1", body: { department: "Finance" } });
    const { events } = store.readVerified();
    assert.equal(storedBeforeSend, 1);
    assert.deepEqual(events.map((entry) => entry.type), ["graph.write.attempted", "graph.write.result"]);
    const [attempted, result] = events;
    assert.equal(attempted?.details.attemptId, result?.details.attemptId);
    for (const entry of events) {
      assert.equal(entry.source, "graph-write");
      assert.equal(entry.runId, "run-1");
      assert.equal(entry.tenantId, "tenant-1");
      assert.equal(entry.agentSlug, "offboarding");
      assert.equal(entry.initiator, "schedule");
      assert.equal(entry.details.method, "PATCH");
      assert.equal(entry.details.path, "/users/user-1");
    }
    assert.equal(result?.details.outcome, "ok");
    assert.equal(result?.details.status, 204);
    assert.equal(result?.details.requestId, "graph-request-1");
    assert.doesNotMatch(JSON.stringify(events), /Finance/);
    store.close();
  });

  it("refuses the write and sends nothing when the audit log cannot record it", async () => {
    const store = new AuditLogStore(":memory:");
    store.close();
    let sent = 0;
    const graph = createGraphAdapter({
      tokenProvider: async () => "token",
      writeAudit: graphWriteAuditSink(store, { tenantId: "tenant-1" }),
      fetchImpl: (async () => {
        sent += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await assert.rejects(graph.request({ method: "DELETE", path: "/groups/group-1" }), (error) => {
      assert.ok(error instanceof GraphWriteAuditError);
      assert.match(error.message, /^DELETE \/groups\/group-1 was not sent: the audit log could not record it\./);
      return true;
    });
    assert.equal(sent, 0);
  });
});

describe("tracked audit sink", () => {
  it("notes a rejection of an async sink and refuses the write, as it does a throw", async () => {
    const noted: string[] = [];
    let sent = 0;
    const sink = trackedAuditSink({
      attempted: async () => {
        throw new Error("database is locked");
      },
      result: () => {
        throw new Error("disk I/O error");
      },
    }, (error) => noted.push(error instanceof Error ? error.message : String(error)));
    const graph = createGraphAdapter({
      tokenProvider: async () => "token",
      writeAudit: sink,
      fetchImpl: (async () => {
        sent += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await assert.rejects(graph.request({ method: "POST", path: "/groups", body: {} }), (error) => {
      assert.ok(error instanceof GraphWriteAuditError);
      return true;
    });
    assert.equal(sent, 0);
    assert.throws(() => sink.result({ attemptId: "a", method: "POST", path: "/groups", outcome: "ok", attempts: 1, durationMs: 1 }), /disk I\/O error/);
    assert.deepEqual(noted, ["database is locked", "disk I/O error"]);
  });
});

describe("Graph write results the audit log could not record", () => {
  function result(attemptId: string): AuditLogEventSeed {
    return {
      id: `graph-write:${attemptId}:result`,
      timestamp: "2026-11-01T10:00:00.000Z",
      type: "graph.write.result",
      source: "graph-write",
      tenantId: "tenant-1",
      details: { attemptId, method: "POST", path: "/me/sendMail", outcome: "ok", status: 202, attempts: 1, durationMs: 5 },
    };
  }

  /**
   * A store whose database refuses appends while `failing` is set, as
   * with a full disk. The refusal is planted below `append`, so what
   * `append` does after a refusal still runs.
   */
  function failingStore(path: string): { store: AuditLogStore; fail(on: boolean): void } {
    const store = new AuditLogStore(path);
    const inner = store as unknown as { appendNow(events: readonly AuditLogEventSeed[]): number };
    const appendNow = inner.appendNow.bind(store);
    let failing = false;
    inner.appendNow = (events) => {
      if (failing) throw new Error("database or disk is full");
      return appendNow(events);
    };
    return { store, fail: (on) => (failing = on) };
  }

  /** Makes the pending file unwritable by putting a folder with a file in it at its path. */
  function blockPendingFile(path: string): () => void {
    const pendingPath = `${path}-audit-pending.json`;
    mkdirSync(pendingPath);
    writeFileSync(join(pendingPath, "keep"), "");
    return () => rmSync(pendingPath, { recursive: true, force: true });
  }

  it("says a kept result is only in memory while the pending file cannot be written, and saves it once it can", async () => {
    await withDatabase((path) => {
      const first = failingStore(path);
      const unblock = blockPendingFile(path);
      first.fail(true);
      assert.throws(() => first.store.appendOrKeep([result("attempt-1")]), /database or disk is full/);
      assert.deepEqual(first.store.unrecordedResults(), { count: 1, inMemoryOnly: true });
      assert.equal(first.store.pendingPersisted(), false);

      // A later append the database refuses tries the file again.
      unblock();
      assert.throws(() => first.store.append([event("refused")]), /database or disk is full/);
      assert.equal(first.store.pendingPersisted(), true);
      assert.deepEqual(first.store.unrecordedResults(), { count: 1 });
      assert.deepEqual(JSON.parse(readFileSync(`${path}-audit-pending.json`, "utf8")).map((entry: { id: string }) => entry.id), ["graph-write:attempt-1:result"]);
      first.store.close();

      // So it survives a restart.
      const second = new AuditLogStore(path);
      try {
        assert.deepEqual(second.unrecordedResults(), { count: 1 });
      } finally {
        second.close();
      }
    });
  });

  it("tries again to save a result only in memory when the status is read and when it closes", async () => {
    await withDatabase((path) => {
      const read = failingStore(path);
      let unblock = blockPendingFile(path);
      read.fail(true);
      assert.throws(() => read.store.appendOrKeep([result("attempt-1")]));
      assert.equal(read.store.unrecordedResults()?.inMemoryOnly, true);
      unblock();
      assert.deepEqual(read.store.unrecordedResults(), { count: 1 }, "a status read saves it");
      assert.ok(existsSync(`${path}-audit-pending.json`));

      // The file goes and its path is blocked again, so the next result is only in memory.
      rmSync(`${path}-audit-pending.json`);
      unblock = blockPendingFile(path);
      assert.throws(() => read.store.appendOrKeep([result("attempt-2")]));
      assert.equal(read.store.pendingPersisted(), false);
      unblock();
      read.store.close();
      const reopened = new AuditLogStore(path);
      try {
        assert.deepEqual(reopened.unrecordedResults(), { count: 2 }, "close saved both");
      } finally {
        reopened.close();
      }
    });
  });

  it("says the result is only in memory in the error when the pending file cannot be written", async () => {
    await withDatabase(async (path) => {
      const { store, fail } = failingStore(path);
      const unblock = blockPendingFile(path);
      const warnings: string[] = [];
      try {
        const graph = createGraphAdapter({
          tokenProvider: async () => "token",
          writeAudit: graphWriteAuditSink(store, { tenantId: "tenant-1", runId: "run-1" }),
          log: (level, message) => {
            if (level === "warn") warnings.push(message);
          },
          fetchImpl: (async () => {
            fail(true);
            return new Response(null, { status: 204 });
          }) as typeof fetch,
        });
        await graph.request({ method: "PATCH", path: "/users/user-1", body: { department: "Finance" } });
        assert.match(warnings[0] ?? "", /The request was sent\. Its result could not be saved to disk either, so it is only in memory and is lost if OpenAdminOS quits before the audit log records it\. Free disk space and check permissions of the OpenAdminOS data folder, and keep OpenAdminOS open; Settings, General shows how many results wait\.$/);
        assert.doesNotMatch(warnings[0] ?? "", /kept on this device/);
      } finally {
        unblock();
        store.close();
      }
    });
  });

  it("keeps a result that cannot be appended, across a restart, until an append records it", async () => {
    await withDatabase((path) => {
      const first = failingStore(path);
      first.store.append([event("before")]);
      first.fail(true);
      assert.throws(() => first.store.appendOrKeep([result("attempt-1")]), /database or disk is full/);
      assert.deepEqual(first.store.unrecordedResults(), { count: 1 });
      first.store.close();
      assert.ok(existsSync(`${path}-audit-pending.json`));

      const second = new AuditLogStore(path);
      try {
        assert.deepEqual(second.unrecordedResults(), { count: 1 });
        // An unrelated append records the kept result first, in the same transaction.
        assert.equal(second.append([event("after")]), 2);
        assert.equal(second.unrecordedResults(), undefined);
        assert.equal(existsSync(`${path}-audit-pending.json`), false);
        assert.deepEqual(second.readVerified().events.map((entry) => entry.id), ["before", "graph-write:attempt-1:result", "after"]);
      } finally {
        second.close();
      }
    });
  });

  it("drops a kept result that is already stored when it loads", async () => {
    await withDatabase((path) => {
      const store = new AuditLogStore(path);
      store.append([result("attempt-1")]);
      store.close();
      writeFileSync(`${path}-audit-pending.json`, JSON.stringify([result("attempt-1")]));
      const reopened = new AuditLogStore(path);
      try {
        assert.equal(reopened.unrecordedResults(), undefined);
        assert.equal(existsSync(`${path}-audit-pending.json`), false);
      } finally {
        reopened.close();
      }
    });
  });

  it("reports a file of kept results that cannot be read and never overwrites it", async () => {
    await withDatabase((path) => {
      writeFileSync(`${path}-audit-pending.json`, "not json");
      const { store, fail } = failingStore(path);
      try {
        assert.deepEqual(store.unrecordedResults(), { count: 0, unreadableFile: "openadminos.db-audit-pending.json" });
        fail(true);
        assert.throws(() => store.appendOrKeep([result("attempt-2")]));
        // The unreadable file is kept, so the new result is only in memory.
        assert.deepEqual(store.unrecordedResults(), { count: 1, unreadableFile: "openadminos.db-audit-pending.json", inMemoryOnly: true });
        assert.equal(readFileSync(`${path}-audit-pending.json`, "utf8"), "not json");
        // Once the admin moves it away, the next try saves the result in a new file.
        rmSync(`${path}-audit-pending.json`);
        assert.deepEqual(store.unrecordedResults(), { count: 1 });
        assert.deepEqual(JSON.parse(readFileSync(`${path}-audit-pending.json`, "utf8")).map((entry: { id: string }) => entry.id), ["graph-write:attempt-2:result"]);
      } finally {
        store.close();
      }
    });
  });

  it("sends the write, says the result is kept, and records it with the next append", async () => {
    const store = new AuditLogStore(":memory:");
    const append = store.append.bind(store);
    let failResults = true;
    store.append = (events) => {
      if (failResults && events.some((entry) => entry.type === "graph.write.result")) throw new Error("database or disk is full");
      return append(events);
    };
    const warnings: string[] = [];
    let sent = 0;
    const graph = createGraphAdapter({
      tokenProvider: async () => "token",
      writeAudit: graphWriteAuditSink(store, { tenantId: "tenant-1", runId: "run-1" }),
      log: (level, message) => {
        if (level === "warn") warnings.push(message);
      },
      fetchImpl: (async () => {
        sent += 1;
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await graph.request({ method: "PATCH", path: "/users/user-1", body: { department: "Finance" } });
    assert.equal(sent, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /^The audit log could not record the result of PATCH \/users\/user-1\. database or disk is full The request was sent\. Its result is kept on this device and recorded once the audit log can record again; Settings, General shows how many results wait\.$/);
    assert.deepEqual(store.unrecordedResults(), { count: 1 });
    failResults = false;
    store.append([event("later")]);
    assert.equal(store.unrecordedResults(), undefined);
    assert.deepEqual(store.readVerified().events.map((entry) => entry.type), ["graph.write.attempted", "graph.write.result", "provider.changed"]);
    store.close();
  });
});
