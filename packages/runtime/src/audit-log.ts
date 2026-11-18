import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { RunInitiator } from "@openadminos/agent-sdk";
import type { GraphWriteAuditSink } from "./graph-adapter.js";

/**
 * The append-only audit log in the app database. Each event is written
 * when it happens, with a SHA-256 hash chained to the row before it.
 * SQLite triggers refuse every change to a row, and refuse a delete
 * unless it removes the oldest row and that row is past the retention
 * window. Run-history retention and Disconnect never delete these rows.
 *
 * An anchor file next to the database holds the chain as the app last
 * left it: the hash the oldest kept row is chained to, the newest hash
 * and the row count. Verification compares the table with it, so rows
 * removed from either end, or a table dropped and created again, are
 * found even though the rows left still chain. It detects changes made
 * outside the app to the database alone; someone who rewrites both
 * files can hide a change. The finalHash of an export is the anchor an
 * admin keeps outside this device. A missing anchor is adopted only
 * for an empty table; beside rows it is an integrity error.
 *
 * A `graph.write.result` that cannot be appended is kept in a pending
 * file next to the database until an append records it, so a write that
 * was sent always ends with its result in the log. When that file cannot
 * be written either, the result is only in memory: Settings and the
 * error say so, and every later append, a status read and close try
 * the file again.
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
  | "gateway"
  | "nova"
  | "sandbox";

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
  /** The organization of a sandbox event; opaque to the audit log. */
  organizationId?: string;
  agentSlug?: string;
  /** Who started the run the event belongs to. */
  initiator?: RunInitiator;
  actor?: AuditLogActor;
  details: Record<string, unknown>;
}

export type AuditLogEvent = AuditLogEventSeed & { sha256: string };

/** The stored chain failed verification; nothing is exported from it. */
export class AuditLogIntegrityError extends Error {
  /** `entry` is the row that broke the chain; omitted when the table does not match its anchor. */
  constructor(entry: number | undefined, reason: string) {
    super(
      `The audit log on this device failed its integrity check${entry === undefined ? "" : ` at entry ${entry.toLocaleString("en-US")}`}: ${reason} It was not exported. The log may have been changed outside OpenAdminOS. Keep a copy of openadminos.db and openadminos.db${AUDIT_ANCHOR_SUFFIX} from the app data folder for review, and tell whoever manages this device.`,
    );
    this.name = "AuditLogIntegrityError";
  }
}

/**
 * A change to state would remove records whose audit events are not in
 * the audit log yet, and the audit log could not record them first.
 */
export class AuditLogBehindError extends Error {
  constructor(count: number, cause: unknown) {
    super(
      `This change was not saved: it removes ${count === 1 ? "1 event" : `${count.toLocaleString("en-US")} events`} the audit log has not recorded yet, and the audit log could not record them now. ${cause instanceof Error ? cause.message : String(cause)} Nothing was removed. Check free disk space and permissions of the OpenAdminOS data folder, then try again.`,
      { cause },
    );
    this.name = "AuditLogBehindError";
  }
}

export interface AuditLogChainSummary {
  rowCount: number;
  /** The hash the oldest kept row is chained to. */
  startHash: string;
  finalHash: string;
}

/** The anchor file is the database path with this suffix. */
const AUDIT_ANCHOR_SUFFIX = "-audit-anchor.json";

/** The file of results not recorded yet is the database path with this suffix. */
const AUDIT_PENDING_SUFFIX = "-audit-pending.json";

/**
 * The result of a Graph write that was sent could not be appended. It is
 * kept and recorded with the next append that succeeds; `inMemoryOnly`
 * says the pending file could not hold it, so it is lost if the app quits
 * before then.
 */
export class AuditLogResultKeptError extends Error {
  constructor(cause: unknown, inMemoryOnly = false) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      inMemoryOnly
        ? `${reason} The request was sent. Its result could not be saved to disk either, so it is only in memory and is lost if OpenAdminOS quits before the audit log records it. Free disk space and check permissions of the OpenAdminOS data folder, and keep OpenAdminOS open; Settings, General shows how many results wait.`
        : `${reason} The request was sent. Its result is kept on this device and recorded once the audit log can record again; Settings, General shows how many results wait.`,
      { cause },
    );
    this.name = "AuditLogResultKeptError";
  }
}

/** Results kept because the audit log could not record them yet. */
export interface AuditLogUnrecordedResults {
  count: number;
  /** A pending file that could not be read; it is left in place for review. */
  unreadableFile?: string;
  /**
   * Some kept results could not be written to the pending file, so they
   * are only in memory and are lost if the app quits before they are
   * recorded. Never set for an in-memory log, which has no file.
   */
  inMemoryOnly?: true;
}

/** The chain as the app last left it, kept outside the table. */
interface AuditLogAnchor {
  version: 1;
  /** The hash the oldest kept row is chained to; a prune moves it. */
  startHash: string;
  /** The hash of the newest row, or startHash when no row is kept. */
  lastHash: string;
  /** Rows chained from startHash up to lastHash. */
  rowCount: number;
}

type AnchorRead = { kind: "missing" } | { kind: "unreadable" } | { kind: "ok"; anchor: AuditLogAnchor };

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
  /** Undefined for an in-memory log, which has nothing outside it to compare with. */
  private readonly anchorPath: string | undefined;
  /** Undefined for an in-memory log, whose kept results live only in `pending`. */
  private readonly pendingPath: string | undefined;
  /** Events that could not be appended yet; every append records them first. */
  private pending: AuditLogEventSeed[] = [];
  /** The pending file could not be read, so it is never overwritten. */
  private pendingUnreadable = false;
  /** False while `pending` holds results the pending file does not. */
  private pendingOnDisk = true;

  /** `path` is the app database, or ":memory:" when the host has no data folder. */
  constructor(path: string, private readonly clock: () => Date = () => new Date()) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
      // FULL: an appended event is on disk before the Graph write it records is sent.
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
        if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
      }
    }
    this.migrate();
    this.anchorPath = path === ":memory:" ? undefined : `${path}${AUDIT_ANCHOR_SUFFIX}`;
    this.pendingPath = path === ":memory:" ? undefined : `${path}${AUDIT_PENDING_SUFFIX}`;
    // First run: the empty table becomes the anchor. The anchor ships with
    // the table, so a missing anchor beside rows was removed, and is left
    // missing for verification to report.
    if (this.anchorPath && !existsSync(this.anchorPath) && this.isEmpty()) this.writeAnchor();
    this.loadPending();
  }

  /** Tries once more to save results only in memory, then closes the database. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.retryPendingPersist();
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
        CREATE INDEX IF NOT EXISTS audit_log_sha256 ON audit_log (sha256);
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
   * What is kept because it could not be recorded yet. Results only in
   * memory are first written to the pending file again, so a status
   * read after the disk has room shows them as saved.
   */
  unrecordedResults(): AuditLogUnrecordedResults | undefined {
    this.retryPendingPersist();
    if (this.pending.length === 0 && !this.pendingUnreadable) return undefined;
    return {
      count: this.pending.length,
      ...(this.pendingUnreadable && this.pendingPath ? { unreadableFile: basename(this.pendingPath) } : {}),
      ...(this.pendingOnDisk ? {} : { inMemoryOnly: true as const }),
    };
  }

  /** True when every kept result is in the pending file, or there is no file to keep it in. */
  pendingPersisted(): boolean {
    return this.pendingOnDisk;
  }

  /**
   * Appends like `append`; when that fails, the events are kept, in the
   * pending file when there is one, and recorded by the next append that
   * succeeds. Rethrows the failure.
   */
  appendOrKeep(events: readonly AuditLogEventSeed[]): number {
    try {
      return this.append(events);
    } catch (error) {
      const kept = new Set(this.pending.map((entry) => entry.id));
      for (const event of events) if (!kept.has(event.id)) this.pending.push(event);
      this.persistPending();
      throw error;
    }
  }

  /**
   * Appends the events not stored yet, in the order given, in one
   * transaction, and returns how many were added. Each is chained to the
   * row before it; the transaction keeps the chain linear. Events kept
   * by an earlier failed `appendOrKeep` go first, in the same transaction.
   */
  append(events: readonly AuditLogEventSeed[]): number {
    try {
      return this.appendNow(events);
    } catch (error) {
      // The database refused; the pending file may take what it could not.
      this.retryPendingPersist();
      throw error;
    }
  }

  private appendNow(events: readonly AuditLogEventSeed[]): number {
    const retried = this.pending;
    const all = retried.length > 0 ? [...retried, ...events] : events;
    if (all.length === 0) return 0;
    const exists = this.db.prepare("SELECT 1 FROM audit_log WHERE event_id = ?");
    const insert = this.db.prepare(
      `INSERT INTO audit_log (
        event_id, recorded_at, timestamp, type, source, run_id, tenant_id, initiator,
        event_json, previous_sha256, sha256
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const recordedAt = this.clock().toISOString();
    let added = 0;
    let anchorHolds = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // A table that no longer matches its anchor keeps the anchor as it
      // is, so the next export still reports what changed.
      const anchor = this.anchorState();
      anchorHolds = anchor.holds;
      const last = this.db
        .prepare("SELECT sha256 FROM audit_log ORDER BY seq DESC LIMIT 1")
        .get() as { sha256: string } | undefined;
      // After a prune that removed every row, the chain goes on from the
      // newest hash it removed, which the anchor keeps.
      let previous = last?.sha256 ?? (anchor.holds && anchor.anchor ? anchor.anchor.lastHash : AUDIT_CHAIN_START_HASH);
      for (const event of all) {
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
    // After the commit: an anchor behind the table, as after a crash in
    // between, is accepted and moved forward by the next append.
    if (added > 0 && anchorHolds) this.writeAnchorAfterCommit();
    if (retried.length > 0) {
      this.pending = this.pending.filter((entry) => !retried.includes(entry));
      this.persistPending();
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
    if (this.anchorPath) {
      const read = this.readAnchor();
      if (read.kind === "unreadable") {
        throw new AuditLogIntegrityError(undefined, `its anchor file ${basename(this.anchorPath)} cannot be read.`);
      }
      if (read.kind === "missing") {
        if (rows.length > 0) {
          throw new AuditLogIntegrityError(
            undefined,
            `its anchor file ${basename(this.anchorPath)} is missing while the log holds ${rows.length === 1 ? "1 entry" : `${rows.length.toLocaleString("en-US")} entries`}. The anchor was removed outside OpenAdminOS, so entries removed from the log can no longer be found.`,
          );
        }
        this.writeAnchor();
      } else {
        const mismatch = this.anchorMismatch(read.anchor, { countRows: true });
        if (mismatch) throw new AuditLogIntegrityError(undefined, mismatch);
        // An empty table stays chained to where the last prune left it.
        if (rows.length === 0) {
          return { events, chain: { rowCount: 0, startHash: read.anchor.startHash, finalHash: read.anchor.lastHash } };
        }
        if (read.anchor.lastHash !== previous || read.anchor.startHash !== startHash) this.writeAnchorAfterCommit();
      }
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
      const anchorHolds = this.anchorState().holds;
      const newest = this.db.prepare("SELECT sha256 FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { sha256: string } | undefined;
      while (Number(remove.run().changes) > 0) removed += 1;
      // Before the commit: if it does not happen, the rows the anchor
      // passes over are still chained to its start, which is accepted.
      if (removed > 0 && anchorHolds) this.writeAnchor(newest?.sha256);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return removed;
  }

  /** Whether the table matches its anchor, or there is no anchor to match yet. */
  private anchorState(): { holds: boolean; anchor?: AuditLogAnchor } {
    if (!this.anchorPath) return { holds: false };
    const read = this.readAnchor();
    // Adopted only by an empty table; beside rows it was removed.
    if (read.kind === "missing") return { holds: this.isEmpty() };
    if (read.kind === "unreadable") return { holds: false };
    return { holds: this.anchorMismatch(read.anchor, { countRows: false }) === undefined, anchor: read.anchor };
  }

  /**
   * Why the table does not match the anchor, or undefined when it does.
   * Rows newer than the anchor, and older rows its start passes over,
   * are accepted: they are what an append or prune interrupted between
   * the table and the anchor file leaves. Before an append or prune the
   * rows are not counted, which keeps it to index lookups; a row missing
   * in between still breaks the chain and the count at export.
   */
  private anchorMismatch(anchor: AuditLogAnchor, options: { countRows: boolean }): string | undefined {
    const table = this.db.prepare("SELECT MIN(seq) AS first FROM audit_log").get() as { first: number | null };
    if (table.first === null) {
      return anchor.rowCount === 0
        ? undefined
        : `the audit log table is empty, but this device recorded ${anchor.rowCount.toLocaleString("en-US")} entries in it. The table was emptied, or dropped and created again, outside OpenAdminOS.`;
    }
    const firstSeq = table.first;
    const position = (hash: string): number | undefined => {
      const row = this.db.prepare("SELECT seq FROM audit_log WHERE sha256 = ?").get(hash) as { seq: number } | undefined;
      if (row) return row.seq;
      const first = this.db.prepare("SELECT previous_sha256 FROM audit_log WHERE seq = ?").get(firstSeq) as { previous_sha256: string };
      return first.previous_sha256 === hash ? firstSeq - 1 : undefined;
    };
    const last = position(anchor.lastHash);
    if (last === undefined) {
      return "the newest entries this device recorded are missing. The end of the log was removed, or the table was replaced, outside OpenAdminOS.";
    }
    const start = position(anchor.startHash);
    if (start === undefined || start > last) {
      return "the oldest entries this device kept are missing. Entries were removed before their retention ended, or the table was replaced, outside OpenAdminOS.";
    }
    if (!options.countRows) return undefined;
    const between = this.db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE seq > ? AND seq <= ?").get(start, last) as { count: number };
    if (between.count !== anchor.rowCount) {
      return `it holds ${between.count.toLocaleString("en-US")} entries where this device recorded ${anchor.rowCount.toLocaleString("en-US")}.`;
    }
    return undefined;
  }

  private isEmpty(): boolean {
    return this.db.prepare("SELECT 1 FROM audit_log LIMIT 1").get() === undefined;
  }

  /** Writes the pending file again when it does not hold every kept result. */
  private retryPendingPersist(): void {
    if (!this.pendingOnDisk) this.persistPending();
  }

  /** Loads the pending file; events stored since it was written are dropped. */
  private loadPending(): void {
    if (!this.pendingPath || !existsSync(this.pendingPath)) return;
    let events: AuditLogEventSeed[] | undefined;
    try {
      const value = JSON.parse(readFileSync(this.pendingPath, "utf8")) as unknown;
      if (Array.isArray(value) && value.every(isEventSeed)) events = value;
    } catch {
      // Unreadable below.
    }
    if (!events) {
      this.pendingUnreadable = true;
      console.warn(`[audit] ${basename(this.pendingPath)} cannot be read; it is left in place and Settings reports it.`);
      return;
    }
    this.pending = events.filter((event) => !this.has(event.id));
    if (this.pending.length !== events.length) this.persistPending();
  }

  /**
   * Writes the pending events durably, or removes the file when none are
   * left. When it cannot, the events stay in memory only and
   * `pendingOnDisk` says so until a later append, status read or close
   * writes the file. An unreadable pending file is never overwritten;
   * once the admin has moved it away, the next try writes a new one.
   */
  private persistPending(): void {
    if (!this.pendingPath) return;
    if (this.pendingUnreadable) {
      if (existsSync(this.pendingPath)) {
        this.pendingOnDisk = this.pending.length === 0;
        return;
      }
      this.pendingUnreadable = false;
    }
    try {
      if (this.pending.length === 0) rmSync(this.pendingPath, { force: true });
      else writeFileDurablySync(this.pendingPath, `${JSON.stringify(this.pending)}\n`);
      this.pendingOnDisk = true;
    } catch (error) {
      this.pendingOnDisk = this.pending.length === 0;
      console.warn(`[audit] ${basename(this.pendingPath)} could not be updated; the events are only in memory until the audit log records them or the file can be written. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readAnchor(): AnchorRead {
    if (!this.anchorPath || !existsSync(this.anchorPath)) return { kind: "missing" };
    try {
      const value = JSON.parse(readFileSync(this.anchorPath, "utf8")) as Partial<AuditLogAnchor>;
      if (
        value.version === 1 &&
        typeof value.startHash === "string" &&
        typeof value.lastHash === "string" &&
        typeof value.rowCount === "number" &&
        Number.isInteger(value.rowCount) &&
        value.rowCount >= 0
      ) {
        return { kind: "ok", anchor: value as AuditLogAnchor };
      }
    } catch {
      // Unreadable below.
    }
    return { kind: "unreadable" };
  }

  /**
   * Writes the anchor for the table as this connection sees it, durably.
   * `emptiedAfter` is the newest hash a prune that may empty the table
   * removed, which an empty table stays chained to.
   */
  private writeAnchor(emptiedAfter?: string): void {
    if (!this.anchorPath) return;
    const first = this.db.prepare("SELECT seq, previous_sha256 FROM audit_log ORDER BY seq ASC LIMIT 1").get() as { seq: number; previous_sha256: string } | undefined;
    const last = this.db.prepare("SELECT seq, sha256 FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { seq: number; sha256: string } | undefined;
    const empty = emptiedAfter ?? AUDIT_CHAIN_START_HASH;
    const anchor: AuditLogAnchor = {
      version: 1,
      startHash: first?.previous_sha256 ?? empty,
      lastHash: last?.sha256 ?? empty,
      // Rows are appended with consecutive numbers and removed only from
      // the oldest, so the span of numbers is the count the app left.
      rowCount: first && last ? last.seq - first.seq + 1 : 0,
    };
    writeFileDurablySync(this.anchorPath, `${JSON.stringify(anchor)}\n`);
  }

  /**
   * The rows are committed by now, so a failed anchor write leaves the
   * anchor behind the table, which verification accepts; it is said in
   * the log and the next append writes it again.
   */
  private writeAnchorAfterCommit(): void {
    try {
      this.writeAnchor();
    } catch (error) {
      console.warn(`[audit] the audit log anchor could not be updated; the next append writes it. ${error instanceof Error ? error.message : String(error)}`);
    }
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
      // The write was sent, so its result is kept until it is recorded.
      try {
        store.appendOrKeep([{
          ...base,
          id: `graph-write:${result.attemptId}:result`,
          timestamp: clock().toISOString(),
          type: "graph.write.result",
          details: { ...result },
        }]);
      } catch (error) {
        throw new AuditLogResultKeptError(error, !store.pendingPersisted());
      }
    },
  };
}

/** A Graph request a sandbox is about to send. Never carries a body or the query itself. */
export interface GraphRequestAuditAttempt {
  /** Shared by the attempt and its result. */
  attemptId: string;
  method: string;
  /** Path relative to the Graph version segment, without the query string. */
  path: string;
  /** SHA-256 hex of the query string, when the request has one. */
  queryDigest?: string;
}

export interface GraphRequestAuditResult {
  attemptId: string;
  method: string;
  path: string;
  /** `refused` when the sandbox did not send the request. */
  outcome: "ok" | "failed" | "refused";
  status?: number;
  requestId?: string;
  /** Named reason for a refusal or a failure before a response arrived. */
  reason?: string;
  durationMs: number;
}

/**
 * Records every Graph request a sandbox makes, all methods. `attempted`
 * must finish before the request is sent; a rejection stops the request.
 */
export interface GraphRequestAuditSink {
  attempted(attempt: GraphRequestAuditAttempt): void | Promise<void>;
  result(result: GraphRequestAuditResult): void | Promise<void>;
}

export interface SandboxAuditContext {
  tenantId: string;
  organizationId: string;
  sandboxId: string;
  runId?: string;
  agentSlug?: string;
  initiator?: RunInitiator;
}

/**
 * The sandbox audit sink: one `graph.request.attempted` event before each
 * request, appended with the throwing `append` so a request the log could
 * not record is never sent, and one `graph.request.result` after it. The
 * desktop keeps `graphWriteAuditSink`, which records writes only.
 */
export function graphRequestAuditSink(
  store: AuditLogStore,
  context: SandboxAuditContext,
  clock: () => Date = () => new Date(),
): GraphRequestAuditSink {
  const base = sandboxEventBase(context);
  return {
    attempted(attempt) {
      store.append([{
        ...base,
        id: `graph-request:${attempt.attemptId}:attempted`,
        timestamp: clock().toISOString(),
        type: "graph.request.attempted",
        details: { ...attempt, sandboxId: context.sandboxId },
      }]);
    },
    result(result) {
      try {
        store.appendOrKeep([{
          ...base,
          id: `graph-request:${result.attemptId}:result`,
          timestamp: clock().toISOString(),
          type: "graph.request.result",
          details: { ...result, sandboxId: context.sandboxId },
        }]);
      } catch (error) {
        throw new AuditLogResultKeptError(error, !store.pendingPersisted());
      }
    },
  };
}

/** Appends one sandbox event with the throwing `append`; a failure is the caller's to report. */
export function appendSandboxEvent(
  store: AuditLogStore,
  context: SandboxAuditContext,
  type: string,
  details: Record<string, unknown>,
  clock: () => Date = () => new Date(),
): void {
  store.append([{
    ...sandboxEventBase(context),
    id: `sandbox:${type}:${randomUUID()}`,
    timestamp: clock().toISOString(),
    type,
    details: { ...details, sandboxId: context.sandboxId },
  }]);
}

function sandboxEventBase(context: SandboxAuditContext) {
  return {
    source: "sandbox" as const,
    tenantId: context.tenantId,
    organizationId: context.organizationId,
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.agentSlug ? { agentSlug: context.agentSlug } : {}),
    ...(context.initiator ? { initiator: context.initiator } : {}),
  };
}

/**
 * Wraps a sink so every failure, a throw or a rejection of an async
 * sink, is passed to `noteFailure` and then rethrown or rejected, so a
 * failed attempt still refuses the write.
 */
export function trackedAuditSink(
  sink: GraphWriteAuditSink,
  noteFailure: (error: unknown) => void,
): GraphWriteAuditSink {
  const failed = (error: unknown): never => {
    noteFailure(error);
    throw error;
  };
  const tracked = <T>(record: (input: T) => void | Promise<void>) => (input: T): void | Promise<void> => {
    let recorded: void | Promise<void>;
    try {
      recorded = record(input);
    } catch (error) {
      return failed(error);
    }
    return recorded instanceof Promise ? recorded.catch(failed) : recorded;
  };
  return { attempted: tracked(sink.attempted), result: tracked(sink.result) };
}

function isEventSeed(value: unknown): value is AuditLogEventSeed {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.timestamp === "string" &&
    typeof record.type === "string" &&
    typeof record.source === "string" &&
    record.details !== null &&
    typeof record.details === "object"
  );
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

/** Write to a temporary file, flush it, rename it over `path`, then flush the folder. */
function writeFileDurablySync(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporary, "w", 0o600);
    try {
      writeSync(file, content);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  // Windows cannot open a folder to flush it; the rename is durable there.
  if (process.platform === "win32") return;
  const folder = openSync(dirname(path), "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}
