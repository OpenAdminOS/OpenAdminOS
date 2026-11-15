import type { KeyObject } from "node:crypto";

import { isTlsSpkiPin } from "./certificate.js";
import { PairingError } from "./errors.js";
import { isDevicePublicKey } from "./identity.js";
import { sign, verify } from "./signatures.js";
import { isCount, isIdentifier, isIsoTimestamp, isPlainObject, isSha256Hex, isTenantId, keyProblems } from "./validate.js";

/**
 * What a desktop and a sandbox agreed on when they paired. One desktop
 * per sandbox: a new pairing replaces the old one, and pairing again is
 * also the recovery after an integrity failure.
 */
export interface PairingRecord {
  pairingId: string;
  sandboxId: string;
  sandboxName: string;
  organizationId: string;
  /** Lowercase tenant id. */
  tenantId: string;
  /** Ed25519 public keys, raw base64url. */
  sandboxPublicKey: string;
  /** Pin of the sandbox's TLS key: 64 lowercase hex. */
  tlsSpkiSha256: string;
  desktopPublicKey: string;
  /** ISO 8601 in UTC, as `toISOString` writes it. */
  createdAt: string;
}

/**
 * The sandbox's signed statement of a position in its audit log: the
 * last row of the batch it sends with it (the reader's pin when the
 * batch is empty), not the log's newest row. Each batch gets its own
 * checkpoint, so every row a reader accepts is covered by a signature.
 */
export interface AuditCheckpoint {
  pairingId: string;
  sandboxId: string;
  /** The seq of the batch's last row; for an empty batch, the pin's seq (0 before the first row). */
  seq: number;
  /** The hash of that row; for an empty batch, the pin's hash (the chain start hash before the first row). */
  sha256: string;
  /** Rows the log holds up to this position, after retention; never more than `seq`. Attested by the sandbox, checked for shape only. */
  rowCount: number;
  /** When the sandbox signed, ISO 8601 in UTC. Attested by the sandbox, checked for shape only. */
  at: string;
}

export interface SignedPairingRecord {
  record: PairingRecord;
  signature: string;
}

export interface SignedAuditCheckpoint {
  checkpoint: AuditCheckpoint;
  signature: string;
}

/** One schedule the desktop assigns to the sandbox. */
export interface ScheduleAssignmentEntry {
  /** A bundled agent's id, such as find-inactive-devices. */
  agentId: string;
  /** SHA-256 hex of the agent's manifest.yaml; the sandbox refuses an entry whose bundled manifest differs. */
  templateSha256: string;
  intervalSeconds: number;
}

/**
 * The schedules a paired desktop assigns to its sandbox, signed with the
 * desktop's device key. Each new record replaces the previous one and
 * must carry a higher version, so an old record cannot be replayed.
 */
export interface ScheduleAssignment {
  pairingId: string;
  /** Whole number from 1; strictly higher than the version the sandbox holds. */
  version: number;
  organizationId: string;
  /** Lowercase tenant id. */
  tenantId: string;
  /** At most one entry per agent; an empty list removes every assigned schedule. */
  entries: ScheduleAssignmentEntry[];
  /** ISO 8601 in UTC. */
  issuedAt: string;
}

export interface SignedScheduleAssignment {
  assignment: ScheduleAssignment;
  signature: string;
}

/** Entries per assignment, at most. */
export const MAX_ASSIGNMENT_ENTRIES = 50;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; detail: string };

const PAIRING_RECORD_KEYS = [
  "pairingId",
  "sandboxId",
  "sandboxName",
  "organizationId",
  "tenantId",
  "sandboxPublicKey",
  "tlsSpkiSha256",
  "desktopPublicKey",
  "createdAt",
] as const;

const AUDIT_CHECKPOINT_KEYS = ["pairingId", "sandboxId", "seq", "sha256", "rowCount", "at"] as const;
const SIGNED_RECORD_KEYS = ["record", "signature"] as const;
const SIGNED_CHECKPOINT_KEYS = ["checkpoint", "signature"] as const;
const ASSIGNMENT_KEYS = ["pairingId", "version", "organizationId", "tenantId", "entries", "issuedAt"] as const;
const ASSIGNMENT_ENTRY_KEYS = ["agentId", "templateSha256", "intervalSeconds"] as const;
const SIGNED_ASSIGNMENT_KEYS = ["assignment", "signature"] as const;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** Checks every field and refuses unknown ones; returns a copy holding only the record's fields. */
export function parsePairingRecord(value: unknown): ParseResult<PairingRecord> {
  if (!isPlainObject(value)) return invalid("The pairing record is not an object.");
  const keys = keyProblems(value, PAIRING_RECORD_KEYS);
  if (keys) return invalid(`The pairing record has a ${keys}.`);
  for (const field of ["pairingId", "sandboxId", "sandboxName", "organizationId"] as const) {
    if (!isIdentifier(value[field])) return invalid(`The pairing record's ${field} is not 1 to 200 characters without control characters or surrounding spaces.`);
  }
  if (!isTenantId(value.tenantId)) return invalid("The pairing record's tenantId is not a lowercase tenant id.");
  if (!isDevicePublicKey(value.sandboxPublicKey)) return invalid("The pairing record's sandboxPublicKey is not an Ed25519 public key.");
  if (!isDevicePublicKey(value.desktopPublicKey)) return invalid("The pairing record's desktopPublicKey is not an Ed25519 public key.");
  if (value.sandboxPublicKey === value.desktopPublicKey) return invalid("The pairing record names the same key for the sandbox and the desktop.");
  if (!isTlsSpkiPin(value.tlsSpkiSha256)) return invalid("The pairing record's tlsSpkiSha256 is not 64 lowercase hex characters.");
  if (!isIsoTimestamp(value.createdAt)) return invalid("The pairing record's createdAt is not an ISO 8601 UTC time.");
  return { ok: true, value: pick(value, PAIRING_RECORD_KEYS) as unknown as PairingRecord };
}

export function parseAuditCheckpoint(value: unknown): ParseResult<AuditCheckpoint> {
  if (!isPlainObject(value)) return invalid("The audit checkpoint is not an object.");
  const keys = keyProblems(value, AUDIT_CHECKPOINT_KEYS);
  if (keys) return invalid(`The audit checkpoint has a ${keys}.`);
  if (!isIdentifier(value.pairingId)) return invalid("The audit checkpoint's pairingId is not a valid id.");
  if (!isIdentifier(value.sandboxId)) return invalid("The audit checkpoint's sandboxId is not a valid id.");
  if (!isCount(value.seq)) return invalid("The audit checkpoint's seq is not a non-negative whole number.");
  if (!isSha256Hex(value.sha256)) return invalid("The audit checkpoint's sha256 is not 64 lowercase hex characters.");
  if (!isCount(value.rowCount) || value.rowCount > value.seq) return invalid("The audit checkpoint's rowCount is not a whole number from 0 to its seq.");
  if (!isIsoTimestamp(value.at)) return invalid("The audit checkpoint's at is not an ISO 8601 UTC time.");
  return { ok: true, value: pick(value, AUDIT_CHECKPOINT_KEYS) as unknown as AuditCheckpoint };
}

/** Signs a record in the pairing record domain; throws `payload-invalid` for a record out of shape. */
export function signPairingRecord(record: PairingRecord, privateKey: KeyObject): SignedPairingRecord {
  const parsed = parsePairingRecord(record);
  if (!parsed.ok) throw new PairingError("payload-invalid", parsed.detail);
  return { record: parsed.value, signature: sign("openadminos.pairing.record.v1", parsed.value, privateKey) };
}

/**
 * Checks shape and signature of a signed record from storage or the
 * network. `publicKey` is the signer's key, taken from where the caller
 * trusts it, not from the record being checked.
 */
export function verifyPairingRecord(signed: unknown, publicKey: KeyObject | string): ParseResult<PairingRecord> {
  if (!isPlainObject(signed)) return invalid("The signed pairing record is not an object.");
  const keys = keyProblems(signed, SIGNED_RECORD_KEYS);
  if (keys) return invalid(`The signed pairing record has a ${keys}.`);
  const parsed = parsePairingRecord(signed.record);
  if (!parsed.ok) return parsed;
  if (!verify("openadminos.pairing.record.v1", parsed.value, signed.signature, publicKey)) {
    return invalid("The pairing record's signature does not verify with the expected key.");
  }
  return parsed;
}

export function signAuditCheckpoint(checkpoint: AuditCheckpoint, privateKey: KeyObject): SignedAuditCheckpoint {
  const parsed = parseAuditCheckpoint(checkpoint);
  if (!parsed.ok) throw new PairingError("payload-invalid", parsed.detail);
  return { checkpoint: parsed.value, signature: sign("openadminos.audit.checkpoint.v1", parsed.value, privateKey) };
}

export function verifyAuditCheckpoint(signed: unknown, publicKey: KeyObject | string): ParseResult<AuditCheckpoint> {
  if (!isPlainObject(signed)) return invalid("The signed audit checkpoint is not an object.");
  const keys = keyProblems(signed, SIGNED_CHECKPOINT_KEYS);
  if (keys) return invalid(`The signed audit checkpoint has a ${keys}.`);
  const parsed = parseAuditCheckpoint(signed.checkpoint);
  if (!parsed.ok) return parsed;
  if (!verify("openadminos.audit.checkpoint.v1", parsed.value, signed.signature, publicKey)) {
    return invalid("The audit checkpoint's signature does not verify with the sandbox key.");
  }
  return parsed;
}

export function parseScheduleAssignment(value: unknown): ParseResult<ScheduleAssignment> {
  if (!isPlainObject(value)) return invalid("The schedule assignment is not an object.");
  const keys = keyProblems(value, ASSIGNMENT_KEYS);
  if (keys) return invalid(`The schedule assignment has a ${keys}.`);
  if (!isIdentifier(value.pairingId)) return invalid("The schedule assignment's pairingId is not a valid id.");
  if (!isCount(value.version) || value.version < 1) return invalid("The schedule assignment's version is not a whole number from 1.");
  if (!isIdentifier(value.organizationId)) return invalid("The schedule assignment's organizationId is not a valid id.");
  if (!isTenantId(value.tenantId)) return invalid("The schedule assignment's tenantId is not a lowercase tenant id.");
  if (!isIsoTimestamp(value.issuedAt)) return invalid("The schedule assignment's issuedAt is not an ISO 8601 UTC time.");
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ASSIGNMENT_ENTRIES) {
    return invalid(`The schedule assignment's entries are not a list of at most ${MAX_ASSIGNMENT_ENTRIES}.`);
  }
  const seen = new Set<string>();
  const entries: ScheduleAssignmentEntry[] = [];
  for (const [index, entry] of value.entries.entries()) {
    if (!isPlainObject(entry)) return invalid(`Entry ${index} of the schedule assignment is not an object.`);
    const entryKeys = keyProblems(entry, ASSIGNMENT_ENTRY_KEYS);
    if (entryKeys) return invalid(`Entry ${index} of the schedule assignment has a ${entryKeys}.`);
    if (typeof entry.agentId !== "string" || !AGENT_ID.test(entry.agentId)) return invalid(`Entry ${index} of the schedule assignment has an agentId that is not a bundled agent id.`);
    if (seen.has(entry.agentId)) return invalid(`The schedule assignment lists ${entry.agentId} twice.`);
    seen.add(entry.agentId);
    if (!isSha256Hex(entry.templateSha256)) return invalid(`Entry ${index} of the schedule assignment has a templateSha256 that is not 64 lowercase hex characters.`);
    if (!isCount(entry.intervalSeconds) || entry.intervalSeconds < 1) return invalid(`Entry ${index} of the schedule assignment has an intervalSeconds that is not a whole number of seconds.`);
    entries.push({ agentId: entry.agentId, templateSha256: entry.templateSha256, intervalSeconds: entry.intervalSeconds });
  }
  return { ok: true, value: { ...(pick(value, ASSIGNMENT_KEYS) as unknown as ScheduleAssignment), entries } };
}

/** Signs an assignment with the desktop's device key; throws `payload-invalid` for one out of shape. */
export function signScheduleAssignment(assignment: ScheduleAssignment, privateKey: KeyObject): SignedScheduleAssignment {
  const parsed = parseScheduleAssignment(assignment);
  if (!parsed.ok) throw new PairingError("payload-invalid", parsed.detail);
  return { assignment: parsed.value, signature: sign("openadminos.schedule.assignment.v1", parsed.value, privateKey) };
}

/** Checks shape and signature; `publicKey` is the pinned desktop key from the pairing record. */
export function verifyScheduleAssignment(signed: unknown, publicKey: KeyObject | string): ParseResult<ScheduleAssignment> {
  if (!isPlainObject(signed)) return invalid("The signed schedule assignment is not an object.");
  const keys = keyProblems(signed, SIGNED_ASSIGNMENT_KEYS);
  if (keys) return invalid(`The signed schedule assignment has a ${keys}.`);
  const parsed = parseScheduleAssignment(signed.assignment);
  if (!parsed.ok) return parsed;
  if (!verify("openadminos.schedule.assignment.v1", parsed.value, signed.signature, publicKey)) {
    return invalid("The schedule assignment's signature does not verify with the paired desktop's key.");
  }
  return parsed;
}

function pick(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of keys) copy[key] = value[key];
  return copy;
}

function invalid<T>(detail: string): ParseResult<T> {
  return { ok: false, detail };
}
