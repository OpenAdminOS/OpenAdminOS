import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RunInitiator } from "@openadminos/agent-sdk";
import type { GraphWriteAuditSink } from "@openadminos/runtime";

/**
 * The append-only audit log in the app database. Each event is written
 * when it happens, with a SHA-256 hash chained to the row before it.
 * SQLite triggers refuse every change to a row, and refuse a delete
 * unless it removes the oldest row and that row is past the retention
 * window. Run-history retention and Disconnect never delete these rows.
 */

/** The hash the first row is chained to. */
export const AUDIT_CHAIN_START_HASH = "0".repeat(64);

/**
 * Days a row is kept before SQLite allows deleting it: the longest
 * run-history retention Settings allows, so the audit of a run never
 * expires before the run could.
 */
export const AUDIT_LOG_RETENTION_DAYS = 3_650;

export type AuditLogEventSource =
  | "run-history"
  | "connector-audit"
  | "hosted-provider-consent"
  | "configuration-change"
  | "graph-write"
  | "gateway";

export interface AuditLogActor {
  kind: "connected-admin" | "local-admin";
  tenantId?: string;
  tenantName?: string;
  username?: string;
  homeAccountId?: string;
}

/** One audit event. Its canonical JSON is what the chain hashes. */
export interface AuditLogEventSeed {
  id: string;
  timestamp: string;
  type: string;
  source: AuditLogEventSource;
  runId?: string;
  tenantId?: string;
  agentSlug?: string;
  /** Who started the run the event belongs to. */
  initiator?: RunInitiator;
  actor?: AuditLogActor;
  details: Record<string, unknown>;
}

export type AuditLogEvent = AuditLogEventSeed & { sha256: string };

/** The stored chain failed verification; nothing is exported from it. */
export class AuditLogIntegrityError extends Error {
  constructor(entry: number, reason: string) {
    super(
      `The audit log on this device failed its integrity check at entry ${entry.toLocaleString("en-US")}: ${reason} It was not exported. The log may have been changed outside OpenAdminOS. Keep a copy of openadminos.db from the app data folder for review, and tell whoever manages this device.`,
    );
    this.name = "AuditLogIntegrityError";
  }
}

export interface AuditLogChainSummary {
  rowCount: number;
  /** The hash the oldest kept row is chained to. */
  startHash: string;
  finalHash: string;
}

interface AuditLogRow {
  seq: number;
  event_id: string;
  event_json: string;
  previous_sha256: string;
  sha256: string;
}

const RETENTION_CUTOFF_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-" + AUDIT_LOG_RETENTION_DAYS + " days')";

export class AuditLogStore {
  private readonly db: DatabaseSync;
  private closed = false;

  /** `path` is the app database, or ":memory:" when the host has no data folder. */
  constructor(path: string, private readonly clock: () => Date = () => new Date()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
      }
    }
    this.migrate();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private migrate(): void {
    // The triggers are created again on every open, so a changed
    // retention window applies to rows already stored.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id TEXT NOT NULL UNIQUE,
          recorded_at TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          source TEXT NOT NULL,
          run_id TEXT,
          tenant_id TEXT,
          initiator TEXT,
          event_json TEXT NOT NULL,
          previous_sha256 TEXT NOT NULL,
          sha256 TEXT NOT NULL
        );
        DROP TRIGGER IF EXISTS audit_log_refuse_update;
        CREATE TRIGGER audit_log_refuse_update BEFORE UPDATE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only: a row cannot be changed');
        END;
        DROP TRIGGER IF EXISTS audit_log_refuse_replace;
        CREATE TRIGGER audit_log_refuse_replace BEFORE INSERT ON audit_log
        WHEN EXISTS (SELECT 1 FROM audit_log WHERE event_id = NEW.event_id OR seq = NEW.seq)
        BEGIN
          SELECT RAISE(ABORT, 'audit_log is append-only: a row cannot be replaced');
        END;
        DROP TRIGGER IF EXISTS audit_log_refuse_delete;
        CREATE TRIGGER audit_log_refuse_delete BEFORE DELETE ON audit_log
        WHEN OLD.recorded_at > ${RETENTION_CUTOFF_SQL}
          OR OLD.seq <> (SELECT MIN(seq) FROM audit_log)
        BEGIN
          SELECT RAISE(ABORT, 'audit_log rows are deleted only oldest first, after ${AUDIT_LOG_RETENTION_DAYS} days');
        END;
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  has(eventId: string): boolean {
    return this.db.prepare("SELECT 1 FROM audit_log WHERE event_id = ?").get(eventId) !== undefined;
  }

  /**
   * Appends the events not stored yet, in the order given, in one
   * transaction, and returns how many were added. Each is chained to the
   * row before it; the transaction keeps the chain linear.
   */
  append(events: readonly AuditLogEventSeed[]): number {
    if (events.length === 0) return 0;
    const exists = this.db.prepare("SELECT 1 FROM audit_log WHERE event_id = ?");
    const insert = this.db.prepare(
      `INSERT INTO audit_log (
        event_id, recorded_at, timestamp, type, source, run_id, tenant_id, initiator,
        event_json, previous_sha256, sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const recordedAt = this.clock().toISOString();
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db
        .prepare("SELECT sha256 FROM audit_log ORDER BY seq DESC LIMIT 1")
        .get() as { sha256: string } | undefined;
      let previous = last?.sha256 ?? AUDIT_CHAIN_START_HASH;
      for (const event of events) {
        if (exists.get(event.id) !== undefined) continue;
        const json = canonicalJson(event);
        const sha256 = chainHash(previous, json);
        insert.run(
          event.id,
          recordedAt,
          event.timestamp,
          event.type,
          event.source,
          event.runId ?? null,
          event.tenantId ?? null,
          event.initiator ?? null,
          json,
          previous,
          sha256,
        );
        previous = sha256;
        added += 1;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return added;
  }

  /**
   * Every stored event in the order it was recorded, after verifying the
   * whole chain. Throws AuditLogIntegrityError at the first broken row.
   */
  readVerified(): { events: AuditLogEvent[]; chain: AuditLogChainSummary } {
    const rows = this.db
      .prepare("SELECT seq, event_id, event_json, previous_sha256, sha256 FROM audit_log ORDER BY seq ASC")
      .all() as unknown as AuditLogRow[];
    const startHash = rows[0]?.previous_sha256 ?? AUDIT_CHAIN_START_HASH;
    let previous = startHash;
    const events: AuditLogEvent[] = [];
    for (const row of rows) {
      if (row.previous_sha256 !== previous) {
        throw new AuditLogIntegrityError(row.seq, "it is not chained to the entry before it, so an entry is missing or was changed.");
      }
      if (chainHash(previous, row.event_json) !== row.sha256) {
        throw new AuditLogIntegrityError(row.seq, "its stored hash does not match its content.");
      }
      let event: AuditLogEventSeed;
      try {
        event = JSON.parse(row.event_json) as AuditLogEventSeed;
      } catch {
        throw new AuditLogIntegrityError(row.seq, "its content is not valid JSON.");
      }
      if (event.id !== row.event_id) {
        throw new AuditLogIntegrityError(row.seq, "its id does not match its content.");
      }
      events.push({ ...event, sha256: row.sha256 });
      previous = row.sha256;
    }
    return { events, chain: { rowCount: rows.length, startHash, finalHash: previous } };
  }

  /** Deletes rows past the retention window, oldest first. Returns how many. */
  pruneExpired(): number {
    const remove = this.db.prepare(
      `DELETE FROM audit_log
       WHERE seq = (SELECT MIN(seq) FROM audit_log) AND recorded_at <= ${RETENTION_CUTOFF_SQL}`,
    );
    let removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      while (Number(remove.run().changes) > 0) removed += 1;
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }
}

/**
 * The audit sink for a Graph adapter: one `graph.write.attempted` and one
 * `graph.write.result` event per write, sharing the attempt id. They
 * carry the method, path and body digest, never the body.
 */
export function graphWriteAuditSink(
  store: AuditLogStore,
  context: {
    tenantId: string;
    actor?: AuditLogActor;
    runId?: string;
    agentSlug?: string;
    initiator?: RunInitiator;
  },
  clock: () => Date = () => new Date(),
): GraphWriteAuditSink {
  const base = {
    source: "graph-write" as const,
    tenantId: context.tenantId,
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.agentSlug ? { agentSlug: context.agentSlug } : {}),
    ...(context.initiator ? { initiator: context.initiator } : {}),
    ...(context.actor ? { actor: context.actor } : {}),
  };
  return {
    attempted(attempt) {
      store.append([{
        ...base,
        id: `graph-write:${attempt.attemptId}:attempted`,
        timestamp: clock().toISOString(),
        type: "graph.write.attempted",
        details: { ...attempt },
      }]);
    },
    result(result) {
      store.append([{
        ...base,
        id: `graph-write:${result.attemptId}:result`,
        timestamp: clock().toISOString(),
        type: "graph.write.result",
        details: { ...result },
      }]);
    },
  };
}

export function chainHash(previousHash: string, canonicalEvent: string): string {
  return createHash("sha256").update(previousHash).update(canonicalEvent).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}
