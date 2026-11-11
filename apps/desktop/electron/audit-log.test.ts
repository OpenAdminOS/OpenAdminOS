import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("accepts a table and anchor left by the app, rows appended after the anchor, and a first open without one", async () => {
    await withDatabase((path) => {
      storeWith(path, ["a", "b"]);
      // An upgrade: rows from before the anchor existed become its start.
      rmSync(`${path}-audit-anchor.json`);
      const upgraded = new AuditLogStore(path);
      try {
        assert.deepEqual(upgraded.readVerified().events.map((entry) => entry.id), ["a", "b"]);
      } finally {
        upgraded.close();
      }
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
