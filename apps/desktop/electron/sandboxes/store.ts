// What the desktop keeps about its paired sandboxes. Nothing here is
// secret: the keys are in the secret store. The pairing records and pins
// are in one JSON file (mode 0600), and the audit rows each sandbox sent
// and the desktop verified are in their own SQLite file, apart from the
// desktop's own audit chain.

import { mkdir, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";

import type { SignedPairingRecord } from "@openadminos/pairing";
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
  /** The last audit row of the sandbox the desktop verified. */
  auditPin: AuditLogPosition;
  /**
   * Where to read runs from. `generation` is the sandbox's cursor
   * generation; `resetSeen` is the generation whose cursor reset was
   * already handled, so it is read from 0 once only.
   */
  runCursor: { after: number; generation?: string; resetSeen?: string };
  assignmentVersion: number;
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
      throw new SandboxStateError(`The list of paired sandboxes at ${this.path} is not valid JSON. Restore it from a backup, or remove it and pair the sandboxes again.`, { cause: error });
    }
    const file = parsed as Partial<StateFile> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.sandboxes)) {
      throw new SandboxStateError(`The list of paired sandboxes at ${this.path} has an unknown format. Remove it and pair the sandboxes again.`);
    }
    return file.sandboxes;
  }

  async write(sandboxes: readonly StoredSandbox[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
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

export interface VerifiedFinish {
  /** The signed checkpoint that covered the finished event. */
  checkpointSeq: number;
  verifiedAt: string;
}

/** Audit rows the desktop verified, per pairing. Rows are added, never changed. */
export class SandboxAuditStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
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
        checkpoint_seq INTEGER NOT NULL,
        verified_at TEXT NOT NULL,
        PRIMARY KEY (pairing_id, seq)
      );
      CREATE INDEX IF NOT EXISTS sandbox_audit_run ON sandbox_audit (pairing_id, run_id);
    `);
  }

  /** Stores a verified batch in one transaction; rows stored before are kept as they are. */
  addBatch(pairingId: string, sandboxId: string, rows: readonly AuditLogRangeRow[], checkpointSeq: number, verifiedAt: string): void {
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO sandbox_audit (pairing_id, sandbox_id, seq, previous_sha256, sha256, event_json, type, run_id, checkpoint_seq, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) {
        const event = parseEvent(row.event_json);
        insert.run(pairingId, sandboxId, row.seq, row.previous_sha256, row.sha256, row.event_json, event.type ?? null, event.runId ?? null, checkpointSeq, verifiedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Where the verified rows of a pairing hold the run's finished event. */
  finished(pairingId: string, runId: string): VerifiedFinish | undefined {
    const row = this.db
      .prepare("SELECT checkpoint_seq, verified_at FROM sandbox_audit WHERE pairing_id = ? AND run_id = ? AND type = 'sandbox.run.finished' ORDER BY seq ASC LIMIT 1")
      .get(pairingId, runId) as { checkpoint_seq: number; verified_at: string } | undefined;
    return row ? { checkpointSeq: row.checkpoint_seq, verifiedAt: row.verified_at } : undefined;
  }

  count(pairingId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM sandbox_audit WHERE pairing_id = ?").get(pairingId) as { count: number };
    return Number(row.count);
  }

  close(): void {
    this.db.close();
  }
}

function parseEvent(json: string): { type?: string; runId?: string } {
  try {
    const value = JSON.parse(json) as { type?: unknown; runId?: unknown };
    return {
      ...(typeof value.type === "string" ? { type: value.type } : {}),
      ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    };
  } catch {
    // The row passed the chain check, so its text is canonical JSON; this is not reached.
    return {};
  }
}
