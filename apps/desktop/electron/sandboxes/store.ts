// What the desktop keeps about its paired sandboxes. Nothing here is
// secret: the keys are in the secret store. The pairing records are in one
// JSON file (mode 0600). The audit rows each sandbox sent and the desktop
// verified, the audit pin and the runs still waiting for verification are
// in their own SQLite file (mode 0600), apart from the desktop's own audit
// chain. Rows and the pin move in one transaction.

import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import { RUN_DIGEST_EVENTS, type SignedPairingRecord } from "@openadminos/pairing";
import type { AuditLogPosition, AuditLogRangeRow } from "@openadminos/runtime";

import { atomicRename } from "../atomic-rename.js";
import { writeFileDurably } from "../durable-file.js";

export interface StoredSandboxFailure {
  code: string;
  message: string;
  at: string;
}

export interface StoredSandbox {
  sandboxId: string;
  name: string;
  /** `<IP>:<port>`, IPv6 in brackets. */
  address: string;
  organizationId: string;
  tenantId: string;
  pairing: SignedPairingRecord;
  pairedAt: string;
  /**
   * Where to read runs from. `generation` is the sandbox's cursor
   * generation; `resetSeen` is the generation whose cursor reset was
   * already handled, so it is read from 0 once only.
   */
  runCursor: { after: number; generation?: string; resetSeen?: string };
  /** The highest assignment version signed; reserved here before it is sent. */
  assignmentVersion: number;
  /** Set while a sent assignment's outcome is not known; the next one reconciles first. */
  assignmentPending?: number;
  lastSyncAt?: string;
  /** Set when an integrity failure stopped sync; cleared only by pairing again. */
  failure?: StoredSandboxFailure;
}

interface StateFile {
  version: 1;
  sandboxes: StoredSandbox[];
}

export class SandboxStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SandboxStateError";
  }
}

/** The paired sandboxes, read from the file on every call so a crash loses nothing written. */
export class SandboxStateStore {
  constructor(private readonly path: string) {}

  async read(): Promise<StoredSandbox[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new SandboxStateError(`The list of paired sandboxes could not be read: ${(error as Error).message}.`, { cause: error });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new SandboxStateError(`The list of paired sandboxes at ${this.path} is not valid JSON.`, { cause: error });
    }
    const file = parsed as Partial<StateFile> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.sandboxes)) {
      throw new SandboxStateError(`The list of paired sandboxes at ${this.path} has an unknown format.`);
    }
    return file.sandboxes;
  }

  async write(sandboxes: readonly StoredSandbox[]): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    if (sandboxes.length === 0) {
      await rm(this.path, { force: true });
      return;
    }
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file: StateFile = { version: 1, sandboxes: [...sandboxes] };
    try {
      await writeFileDurably(temporary, `${JSON.stringify(file, null, 2)}\n`, { durable: true, mode: 0o600 });
      await atomicRename(temporary, this.path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** The newest verified finished or rewritten event of a run. */
export interface VerifiedRunEvent {
  seq: number;
  /** The signed checkpoint that covered the event. */
  checkpointSeq: number;
  verifiedAt: string;
  agentSlug?: string;
  status?: string;
  runDigest?: string;
}

/** A run imported unverified, checked again on every sync. */
export interface UnverifiedRun {
  runId: string;
  /** The digest of the record as the sandbox sent it, which a verified event must name. */
  digest: string;
  /** The digest of the record as stored in run history, which must still be there to attest it. */
  storedDigest: string;
  agentSlug: string;
  status: string;
}

/** A delivered row has the seq of a stored row but another hash. */
export class AuditSeqConflictError extends Error {
  constructor(readonly seq: number) {
    super(`The sandbox sent audit entry ${seq} with another hash than the one already verified.`);
    this.name = "AuditSeqConflictError";
  }
}

/** Verified audit rows, the pin and the runs waiting for verification, per pairing. */
export class SandboxAuditStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sandbox_audit (
        pairing_id TEXT NOT NULL,
        sandbox_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        previous_sha256 TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        event_json TEXT NOT NULL,
        type TEXT,
        run_id TEXT,
        agent_slug TEXT,
        status TEXT,
        run_digest TEXT,
        checkpoint_seq INTEGER NOT NULL,
        verified_at TEXT NOT NULL,
        PRIMARY KEY (pairing_id, seq)
      );
      CREATE INDEX IF NOT EXISTS sandbox_audit_run ON sandbox_audit (pairing_id, run_id);
      CREATE TABLE IF NOT EXISTS sandbox_pin (
        pairing_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        sha256 TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sandbox_unverified (
        pairing_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        digest TEXT NOT NULL,
        stored_digest TEXT NOT NULL,
        agent_slug TEXT NOT NULL,
        status TEXT NOT NULL,
        checked_at TEXT,
        PRIMARY KEY (pairing_id, run_id)
      );
    `);
  }

  /** The first pin of a pairing, from its signed start checkpoint. */
  start(pairingId: string, pin: AuditLogPosition): void {
    this.db.prepare("INSERT OR REPLACE INTO sandbox_pin (pairing_id, seq, sha256) VALUES (?, ?, ?)").run(pairingId, pin.seq, pin.sha256);
  }

  pin(pairingId: string): AuditLogPosition | undefined {
    const row = this.db.prepare("SELECT seq, sha256 FROM sandbox_pin WHERE pairing_id = ?").get(pairingId) as { seq: number; sha256: string } | undefined;
    return row ? { seq: Number(row.seq), sha256: row.sha256 } : undefined;
  }

  /**
   * Stores a verified batch and moves the pin to its end in one
   * transaction. A row already stored with the same hash is kept; one
   * with another hash throws `AuditSeqConflictError` and nothing changes.
   */
  acceptBatch(pairingId: string, sandboxId: string, rows: readonly AuditLogRangeRow[], pin: AuditLogPosition, verifiedAt: string): void {
    const existing = this.db.prepare("SELECT sha256 FROM sandbox_audit WHERE pairing_id = ? AND seq = ?");
    const insert = this.db.prepare(
      "INSERT INTO sandbox_audit (pairing_id, sandbox_id, seq, previous_sha256, sha256, event_json, type, run_id, agent_slug, status, run_digest, checkpoint_seq, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const stored = existing.get(pairingId, row.seq) as { sha256: string } | undefined;
        if (stored) {
          if (stored.sha256 !== row.sha256) throw new AuditSeqConflictError(row.seq);
          continue;
        }
        const event = parseEvent(row.event_json);
        insert.run(pairingId, sandboxId, row.seq, row.previous_sha256, row.sha256, row.event_json, event.type ?? null, event.runId ?? null, event.agentSlug ?? null, event.status ?? null, event.runDigest ?? null, pin.seq, verifiedAt);
      }
      this.db.prepare("INSERT OR REPLACE INTO sandbox_pin (pairing_id, seq, sha256) VALUES (?, ?, ?)").run(pairingId, pin.seq, pin.sha256);
      this.beforeCommit();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** A seam for tests that stand in for a crash before the commit. */
  protected beforeCommit(): void {}

  /** The newest verified finished or rewritten event of the run. */
  latestRunEvent(pairingId: string, runId: string): VerifiedRunEvent | undefined {
    const row = this.db
      .prepare(`SELECT seq, checkpoint_seq, verified_at, agent_slug, status, run_digest FROM sandbox_audit WHERE pairing_id = ? AND run_id = ? AND type IN (${RUN_DIGEST_EVENTS.map(() => "?").join(", ")}) ORDER BY seq DESC LIMIT 1`)
      .get(pairingId, runId, ...RUN_DIGEST_EVENTS) as
      | { seq: number; checkpoint_seq: number; verified_at: string; agent_slug: string | null; status: string | null; run_digest: string | null }
      | undefined;
    if (!row) return undefined;
    return {
      seq: Number(row.seq),
      checkpointSeq: Number(row.checkpoint_seq),
      verifiedAt: row.verified_at,
      ...(row.agent_slug ? { agentSlug: row.agent_slug } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.run_digest ? { runDigest: row.run_digest } : {}),
    };
  }

  addUnverified(pairingId: string, run: UnverifiedRun): void {
    this.db
      .prepare("INSERT OR REPLACE INTO sandbox_unverified (pairing_id, run_id, digest, stored_digest, agent_slug, status) VALUES (?, ?, ?, ?, ?, ?)")
      .run(pairingId, run.runId, run.digest, run.storedDigest, run.agentSlug, run.status);
  }

  listUnverified(pairingId: string, limit: number): UnverifiedRun[] {
    const rows = this.db
      // The ones checked longest ago first, never checked before all of them, so every entry gets a turn.
      .prepare("SELECT run_id, digest, stored_digest, agent_slug, status FROM sandbox_unverified WHERE pairing_id = ? ORDER BY checked_at IS NOT NULL, checked_at, run_id LIMIT ?")
      .all(pairingId, limit) as Array<{ run_id: string; digest: string; stored_digest: string; agent_slug: string; status: string }>;
    return rows.map((row) => ({ runId: row.run_id, digest: row.digest, storedDigest: row.stored_digest, agentSlug: row.agent_slug, status: row.status }));
  }

  /** Records that these entries were checked now, so the next sync starts with others. */
  markChecked(pairingId: string, runIds: readonly string[], at: string): void {
    const update = this.db.prepare("UPDATE sandbox_unverified SET checked_at = ? WHERE pairing_id = ? AND run_id = ?");
    for (const runId of runIds) update.run(at, pairingId, runId);
  }

  removeUnverified(pairingId: string, runId: string): void {
    this.db.prepare("DELETE FROM sandbox_unverified WHERE pairing_id = ? AND run_id = ?").run(pairingId, runId);
  }

  count(pairingId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM sandbox_audit WHERE pairing_id = ?").get(pairingId) as { count: number };
    return Number(row.count);
  }

  /** Removes everything kept for a pairing; imported runs keep their attestation. */
  removePairing(pairingId: string): void {
    this.db.exec("BEGIN");
    try {
      for (const table of ["sandbox_audit", "sandbox_pin", "sandbox_unverified"]) {
        this.db.prepare(`DELETE FROM ${table} WHERE pairing_id = ?`).run(pairingId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}

function parseEvent(json: string): { type?: string; runId?: string; agentSlug?: string; status?: string; runDigest?: string } {
  try {
    const value = JSON.parse(json) as { type?: unknown; runId?: unknown; agentSlug?: unknown; details?: { status?: unknown; runDigest?: unknown } };
    const details = typeof value.details === "object" && value.details !== null ? value.details : {};
    return {
      ...(typeof value.type === "string" ? { type: value.type } : {}),
      ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
      ...(typeof value.agentSlug === "string" ? { agentSlug: value.agentSlug } : {}),
      ...(typeof details.status === "string" ? { status: details.status } : {}),
      ...(typeof details.runDigest === "string" ? { runDigest: details.runDigest } : {}),
    };
  } catch {
    // The row passed the chain check, so its text is canonical JSON; this is not reached.
    return {};
  }
}
