import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type { NovaNote, NovaNoteReviewState, NovaNoteSource } from "@openadminos/agent-sdk";

import type { AuditLogEventSeed } from "./audit-log.js";

/**
 * Nova's notes: facts the admin wants Nova to keep for one organization.
 * Kept in openadminos.db on this device, next to Chat. A note Nova
 * proposes waits for review and never reaches a prompt; only a click
 * confirms it. Every change is an audit event with the note text.
 */

export const NOVA_NOTE_MAX_LENGTH = 300;
export const NOVA_NOTES_PER_ORGANIZATION = 200;
/** Days a proposed note waits for review before it expires. */
export const NOVA_PROPOSED_NOTE_DAYS = 30;
/** Characters of confirmed notes Nova reads into one prompt, newest first. */
export const NOVA_NOTES_PROMPT_MAX_CHARS = 2000;

const DAY_MS = 86_400_000;

/** A note request Nova or Settings refuses, with the reason in plain words. */
export class NovaMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NovaMemoryError";
  }
}

export const NOVA_NOTES_FULL =
  `This organization has ${NOVA_NOTES_PER_ORGANIZATION} Nova notes. Forget one in Settings, Nova, before adding another.`;
export const NOVA_NOTES_OFF_BY_POLICY =
  "Your IT department turned Nova notes off. You can forget notes, but not confirm or edit them.";
/** Said when openadminos.db cannot be opened: notes and follow-ups are off, the rest of the app works. */
export const NOVA_RECORDS_UNAVAILABLE =
  "Nova notes and follow-ups are unavailable: OpenAdminOS could not open openadminos.db on this device. Check that the app data folder is writable and has free space, then restart OpenAdminOS.";
export const NOVA_NOTE_NOT_FOUND =
  "That note is no longer on this device. Reopen Settings, Nova, to see the current notes.";

/** Opens openadminos.db for Nova's notes and follow-ups, or an in-memory database without a data folder. */
export function openNovaDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    chmodSync(path, 0o600);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    for (const sidecar of [`${path}-wal`, `${path}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }
  return db;
}

interface NoteRow {
  id: string;
  tenant_id: string;
  organization_id: string | null;
  text: string;
  review_state: NovaNoteReviewState;
  source: NovaNoteSource;
  session_id: string | null;
  conversation_id: string | null;
  turn_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  expires_at: string | null;
  revision: number;
}

function noteOf(row: NoteRow): NovaNote {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.organization_id ? { organizationId: row.organization_id } : {}),
    text: row.text,
    reviewState: row.review_state,
    source: row.source,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    createdAt: row.created_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

/** The note text as stored: one trimmed text within the limit. Throws the designed refusal otherwise. */
export function novaNoteText(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!text) throw new NovaMemoryError("A note needs some text.");
  if (text.length > NOVA_NOTE_MAX_LENGTH) throw new NovaMemoryError(`A note can have at most ${NOVA_NOTE_MAX_LENGTH} characters. Shorten it and try again.`);
  return text;
}

export interface NovaNoteProposal {
  tenantId: string;
  organizationId?: string;
  text: string;
  source: NovaNoteSource;
  sessionId?: string;
  conversationId?: string;
  turnId?: string;
}

export interface NovaMemoryOptions {
  /** Records audit events; keeps them when the audit log cannot take them now. Never throws. */
  audit: (events: AuditLogEventSeed[]) => void;
  /** Throws when the tenant is being disconnected: nothing is written for it then. */
  assertWritable?: (tenantId: string, what: string) => void;
  clock?: () => Date;
}

export class NovaMemory {
  private readonly clock: () => Date;

  constructor(private readonly db: DatabaseSync, private readonly options: NovaMemoryOptions) {
    this.clock = options.clock ?? (() => new Date());
    db.exec(`CREATE TABLE IF NOT EXISTS nova_memory_notes (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      organization_id TEXT,
      text TEXT NOT NULL,
      review_state TEXT NOT NULL CHECK (review_state IN ('proposed', 'confirmed', 'edited')),
      source TEXT NOT NULL CHECK (source IN ('user-said', 'nova-proposed')),
      session_id TEXT,
      conversation_id TEXT,
      turn_id TEXT,
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      expires_at TEXT,
      revision INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS nova_memory_notes_tenant ON nova_memory_notes (tenant_id, review_state);`);
  }

  /** Notes of one tenant, newest first. Expired proposals are removed first. */
  list(tenantId: string): NovaNote[] {
    this.expire();
    return (this.db
      .prepare("SELECT * FROM nova_memory_notes WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC")
      .all(tenantId) as unknown as NoteRow[]).map(noteOf);
  }

  get(id: string): NovaNote | undefined {
    const row = this.db.prepare("SELECT * FROM nova_memory_notes WHERE id = ?").get(id) as unknown as NoteRow | undefined;
    return row ? noteOf(row) : undefined;
  }

  /**
   * Stores a note for review. It reaches no prompt until it is confirmed.
   * Refused past the per-organization limit.
   */
  propose(input: NovaNoteProposal): NovaNote {
    const text = novaNoteText(input.text);
    this.options.assertWritable?.(input.tenantId, "Nova note");
    this.expire();
    const count = (this.db.prepare("SELECT COUNT(*) AS count FROM nova_memory_notes WHERE tenant_id = ?").get(input.tenantId) as { count: number }).count;
    if (count >= NOVA_NOTES_PER_ORGANIZATION) throw new NovaMemoryError(NOVA_NOTES_FULL);
    const now = this.clock();
    const note: NovaNote = {
      id: `note_${randomUUID()}`,
      tenantId: input.tenantId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      text,
      reviewState: "proposed",
      source: input.source,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + NOVA_PROPOSED_NOTE_DAYS * DAY_MS).toISOString(),
    };
    this.db
      .prepare(`INSERT INTO nova_memory_notes (id, tenant_id, organization_id, text, review_state, source, session_id, conversation_id, turn_id, created_at, expires_at)
        VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?)`)
      .run(note.id, note.tenantId, note.organizationId ?? null, note.text, note.source, note.sessionId ?? null, note.conversationId ?? null, note.turnId ?? null, note.createdAt, note.expiresAt ?? null);
    this.record(note, "proposed", `nova-memory:${note.id}:proposed`);
    return note;
  }

  /** The admin confirmed a proposed note with a click. A confirmed note no longer expires. */
  confirm(id: string): NovaNote {
    const note = this.require(id);
    if (note.reviewState !== "proposed") return note;
    this.options.assertWritable?.(note.tenantId, "Nova note");
    const reviewedAt = this.clock().toISOString();
    this.db.prepare("UPDATE nova_memory_notes SET review_state = 'confirmed', reviewed_at = ?, expires_at = NULL WHERE id = ? AND review_state = 'proposed'").run(reviewedAt, id);
    const confirmed = this.require(id);
    this.record(confirmed, "confirmed", `nova-memory:${id}:confirmed`);
    return confirmed;
  }

  /** The admin rewrote a note in Settings. An edited note counts as reviewed. */
  edit(id: string, value: unknown): NovaNote {
    const note = this.require(id);
    const text = novaNoteText(value);
    if (text === note.text && note.reviewState !== "proposed") return note;
    this.options.assertWritable?.(note.tenantId, "Nova note");
    const reviewedAt = this.clock().toISOString();
    this.db.prepare("UPDATE nova_memory_notes SET text = ?, review_state = 'edited', reviewed_at = ?, expires_at = NULL, revision = revision + 1 WHERE id = ?").run(text, reviewedAt, id);
    const row = this.db.prepare("SELECT revision FROM nova_memory_notes WHERE id = ?").get(id) as { revision: number };
    const edited = this.require(id);
    this.record(edited, "edited", `nova-memory:${id}:edited:${row.revision}`, { previousText: note.text });
    return edited;
  }

  /** Deletes a note at the admin's request. */
  forget(id: string): void {
    const note = this.require(id);
    this.db.prepare("DELETE FROM nova_memory_notes WHERE id = ?").run(id);
    this.record(note, "forgotten", `nova-memory:${id}:forgotten`);
  }

  /**
   * Forgets a note only while it is still proposed, when its Nova card is
   * cancelled. A note confirmed or edited in Settings meanwhile stays.
   */
  discardProposed(id: string): void {
    const note = this.get(id);
    if (!note || note.reviewState !== "proposed") return;
    const changed = this.db.prepare("DELETE FROM nova_memory_notes WHERE id = ? AND review_state = 'proposed'").run(id).changes;
    if (Number(changed) === 1) this.record(note, "forgotten", `nova-memory:${id}:forgotten`);
  }

  /** Removes proposed notes past their review window. Returns how many. */
  expire(): number {
    const now = this.clock().toISOString();
    const rows = this.db
      .prepare("SELECT * FROM nova_memory_notes WHERE review_state = 'proposed' AND expires_at IS NOT NULL AND expires_at <= ?")
      .all(now) as unknown as NoteRow[];
    if (rows.length === 0) return 0;
    const remove = this.db.prepare("DELETE FROM nova_memory_notes WHERE id = ?");
    for (const row of rows) remove.run(row.id);
    for (const row of rows) this.record(noteOf(row), "expired", `nova-memory:${row.id}:expired`);
    return rows.length;
  }

  /**
   * Confirmed and edited notes of one tenant for a prompt, newest first,
   * within `NOVA_NOTES_PROMPT_MAX_CHARS`. Proposed notes never.
   */
  promptNotes(tenantId: string): string[] {
    const rows = this.db
      .prepare("SELECT text FROM nova_memory_notes WHERE tenant_id = ? AND review_state IN ('confirmed', 'edited') ORDER BY COALESCE(reviewed_at, created_at) DESC, rowid DESC")
      .all(tenantId) as { text: string }[];
    const notes: string[] = [];
    let used = 0;
    for (const { text } of rows) {
      if (used + text.length > NOVA_NOTES_PROMPT_MAX_CHARS) break;
      notes.push(text);
      used += text.length;
    }
    return notes;
  }

  /** Deletes every note of a disconnected tenant. The purge is in the audit log before the rows go. */
  purgeTenant(tenantId: string): number {
    const rows = this.db.prepare("SELECT * FROM nova_memory_notes WHERE tenant_id = ?").all(tenantId) as unknown as NoteRow[];
    if (rows.length === 0) return 0;
    this.options.audit(rows.map((row) => this.event(noteOf(row), "purged", `nova-memory:${row.id}:purged`, { text: undefined })));
    this.db.prepare("DELETE FROM nova_memory_notes WHERE tenant_id = ?").run(tenantId);
    return rows.length;
  }

  private require(id: string): NovaNote {
    const note = typeof id === "string" ? this.get(id) : undefined;
    if (!note) throw new NovaMemoryError(NOVA_NOTE_NOT_FOUND);
    return note;
  }

  private record(note: NovaNote, change: string, id: string, extra: Record<string, unknown> = {}): void {
    this.options.audit([this.event(note, change, id, extra)]);
  }

  private event(note: NovaNote, change: string, id: string, extra: Record<string, unknown>): AuditLogEventSeed {
    const details: Record<string, unknown> = {
      noteId: note.id,
      ...(note.organizationId ? { organizationId: note.organizationId } : {}),
      text: note.text,
      source: note.source,
      reviewState: note.reviewState,
      ...(note.sessionId ? { sessionId: note.sessionId } : {}),
      ...(note.conversationId ? { conversationId: note.conversationId } : {}),
      ...(note.turnId ? { turnId: note.turnId } : {}),
      ...extra,
    };
    for (const key of Object.keys(details)) if (details[key] === undefined) delete details[key];
    return {
      id,
      timestamp: this.clock().toISOString(),
      type: `nova.memory-note-${change}`,
      source: "nova",
      tenantId: note.tenantId,
      details,
    };
  }
}
