import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "@openadminos/runtime";

import { encodeBase32, normalizeBase32 } from "./base32.js";
import { isTlsSpkiPin } from "./certificate.js";
import { PairingError } from "./errors.js";
import { isDevicePublicKey } from "./identity.js";
import { isIdentifier, isTenantId } from "./validate.js";

/**
 * A pairing code is 20 Crockford base32 characters that the sandbox
 * shows and the admin types into the desktop:
 *
 * - characters 1 to 12: the first 60 bits of the sandbox's TLS SPKI
 *   SHA-256, so the desktop pins the right TLS key before it sends anything;
 * - characters 13 to 20: 40 random bits, the secret that keys the
 *   transcript proof. The secret is only ever sent as an HMAC, inside the
 *   pinned TLS connection.
 */
export const PAIRING_CODE_LENGTH = 20;
export const PAIRING_CODE_FINGERPRINT_LENGTH = 12;
export const PAIRING_CODE_SECRET_LENGTH = 8;
/** A code is valid this long after it is shown; the sandbox then shows a new one. */
export const PAIRING_CODE_LIFETIME_MS = 10 * 60_000;
/** Proof checks allowed per code, right or wrong. */
export const PAIRING_CODE_MAX_ATTEMPTS = 5;

const TRANSCRIPT_DOMAIN = "openadminos.pairing.transcript.v1";
/** Typed codes may be grouped with spaces or hyphens; longer input is refused before it is read. */
const MAX_TYPED_LENGTH = 64;

export interface PairingCode {
  /** The 20 canonical characters. */
  code: string;
  /** The first 12 characters. */
  fingerprint: string;
  /** The last 8 characters. */
  secret: string;
}

export function createPairingCode(tlsSpkiSha256: string): PairingCode {
  const fingerprint = pairingCodeFingerprint(tlsSpkiSha256);
  const secret = encodeBase32(randomBytes(5));
  return { code: `${fingerprint}${secret}`, fingerprint, secret };
}

/** The first 12 characters for a TLS SPKI pin (64 lowercase hex). */
export function pairingCodeFingerprint(tlsSpkiSha256: string): string {
  if (!isTlsSpkiPin(tlsSpkiSha256)) {
    throw new PairingError("key-invalid", "The TLS SPKI pin is not 64 lowercase hex characters.");
  }
  return encodeBase32(Buffer.from(tlsSpkiSha256, "hex")).slice(0, PAIRING_CODE_FINGERPRINT_LENGTH);
}

/** Four groups of five, for showing: `ABCDE-FGHJK-MNPQR-STVWX`. */
export function formatPairingCode(code: PairingCode): string {
  return code.code.match(/.{5}/g)?.join("-") ?? code.code;
}

export type PairingCodeParseResult =
  | { ok: true; code: PairingCode }
  | { ok: false; failure: "code-malformed"; detail: string };

/**
 * Reads a typed code. Spaces and hyphens are ignored, case does not
 * matter, and O, I and L are read as 0, 1 and 1.
 */
export function parsePairingCode(input: unknown): PairingCodeParseResult {
  if (typeof input !== "string" || input.length > MAX_TYPED_LENGTH) {
    return { ok: false, failure: "code-malformed", detail: `A pairing code is ${PAIRING_CODE_LENGTH} characters.` };
  }
  const normalized = normalizeBase32(input.replace(/[\s-]/g, ""));
  if (normalized === undefined) {
    return { ok: false, failure: "code-malformed", detail: "The pairing code holds a character that is not in it. Codes use digits and letters except I, L, O and U." };
  }
  if (normalized.length !== PAIRING_CODE_LENGTH) {
    return { ok: false, failure: "code-malformed", detail: `The pairing code has ${normalized.length} characters; it has ${PAIRING_CODE_LENGTH}.` };
  }
  return {
    ok: true,
    code: {
      code: normalized,
      fingerprint: normalized.slice(0, PAIRING_CODE_FINGERPRINT_LENGTH),
      secret: normalized.slice(PAIRING_CODE_FINGERPRINT_LENGTH),
    },
  };
}

/** Constant-time check that the TLS key the desktop reached is the one the code names. */
export function pairingCodeMatchesSpki(code: PairingCode, tlsSpkiSha256: string): boolean {
  if (!isTlsSpkiPin(tlsSpkiSha256) || typeof code.fingerprint !== "string" || code.fingerprint.length !== PAIRING_CODE_FINGERPRINT_LENGTH) {
    return false;
  }
  return timingSafeEqual(Buffer.from(code.fingerprint, "ascii"), Buffer.from(pairingCodeFingerprint(tlsSpkiSha256), "ascii"));
}

export interface PairingTranscriptFields {
  pairingId: string;
  organizationId: string;
  tenantId: string;
  /** Ed25519 public keys, raw base64url. */
  sandboxPublicKey: string;
  desktopPublicKey: string;
  tlsSpkiSha256: string;
}

/** Which side computed a proof; each side checks the other's, so a proof cannot be sent back to its maker. */
export type PairingProofRole = "desktop" | "sandbox";

/**
 * The bytes a proof covers: the domain, a line feed, then canonical JSON
 * of the fields and the role. Throws `payload-invalid` for a field out of shape.
 */
export function pairingTranscript(role: PairingProofRole, fields: PairingTranscriptFields): Buffer {
  const problem = transcriptProblem(role, fields);
  if (problem) throw new PairingError("payload-invalid", `The pairing transcript is invalid: ${problem}.`);
  const body = {
    role,
    pairingId: fields.pairingId,
    organizationId: fields.organizationId,
    tenantId: fields.tenantId,
    sandboxPublicKey: fields.sandboxPublicKey,
    desktopPublicKey: fields.desktopPublicKey,
    tlsSpkiSha256: fields.tlsSpkiSha256,
  };
  return Buffer.from(`${TRANSCRIPT_DOMAIN}\n${canonicalJson(body)}`, "utf8");
}

/** HMAC-SHA256 of the transcript, keyed by the code's secret, as base64url (43 characters). */
export function createPairingProof(code: PairingCode, role: PairingProofRole, fields: PairingTranscriptFields): string {
  return createHmac("sha256", secretKey(code)).update(pairingTranscript(role, fields)).digest("base64url");
}

/** Constant-time check of a proof; false for any malformed input. */
export function verifyPairingProof(code: PairingCode, role: PairingProofRole, fields: PairingTranscriptFields, proof: unknown): boolean {
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  let expected: Buffer;
  try {
    expected = Buffer.from(createPairingProof(code, role, fields), "base64url");
  } catch {
    return false;
  }
  const given = Buffer.from(proof, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function secretKey(code: PairingCode): Buffer {
  const secret = typeof code.secret === "string" ? normalizeBase32(code.secret) : undefined;
  if (secret === undefined || secret.length !== PAIRING_CODE_SECRET_LENGTH) {
    throw new PairingError("payload-invalid", "The pairing code secret is not 8 base32 characters.");
  }
  return Buffer.from(secret, "ascii");
}

function transcriptProblem(role: PairingProofRole, fields: PairingTranscriptFields): string | undefined {
  if (role !== "desktop" && role !== "sandbox") return "role is not desktop or sandbox";
  if (!isIdentifier(fields.pairingId)) return "pairingId";
  if (!isIdentifier(fields.organizationId)) return "organizationId";
  if (!isTenantId(fields.tenantId)) return "tenantId is not a lowercase tenant id";
  if (!isDevicePublicKey(fields.sandboxPublicKey)) return "sandboxPublicKey";
  if (!isDevicePublicKey(fields.desktopPublicKey)) return "desktopPublicKey";
  if (fields.sandboxPublicKey === fields.desktopPublicKey) return "the sandbox and desktop keys are the same";
  if (!isTlsSpkiPin(fields.tlsSpkiSha256)) return "tlsSpkiSha256";
  return undefined;
}

export type PairingAttemptFailure =
  /** The code is older than its lifetime, or the clock moved back past its start. */
  | "code-expired"
  /** Five proofs were checked against this code. */
  | "code-attempts-exhausted"
  /** The code already paired a desktop. */
  | "code-used";

export type PairingAttemptResult =
  | { ok: true; remaining: number }
  | { ok: false; failure: PairingAttemptFailure; detail: string };

export interface PairingAttemptLimiterOptions {
  /** When the code was shown, in the clock's milliseconds. */
  issuedAt: number;
  /** Milliseconds; a monotonic clock is best. `Date.now` when left out. */
  now?: () => number;
  maxAttempts?: number;
  lifetimeMs?: number;
}

/**
 * Counts proof checks for one code. Call `attempt()` before checking a
 * proof and check only on ok; call `succeed()` after a valid proof so
 * the code cannot pair again. A new code gets a new limiter.
 */
export class PairingAttemptLimiter {
  readonly expiresAt: number;
  private readonly now: () => number;
  private readonly issuedAt: number;
  private readonly maxAttempts: number;
  private attempts = 0;
  private used = false;

  constructor(options: PairingAttemptLimiterOptions) {
    const maxAttempts = options.maxAttempts ?? PAIRING_CODE_MAX_ATTEMPTS;
    const lifetimeMs = options.lifetimeMs ?? PAIRING_CODE_LIFETIME_MS;
    if (!Number.isFinite(options.issuedAt) || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
      throw new PairingError("payload-invalid", "The attempt limiter needs a finite issuedAt, at least one attempt and a positive lifetime.");
    }
    this.now = options.now ?? Date.now;
    this.issuedAt = options.issuedAt;
    this.maxAttempts = maxAttempts;
    this.expiresAt = options.issuedAt + lifetimeMs;
  }

  get remaining(): number {
    return this.used ? 0 : Math.max(0, this.maxAttempts - this.attempts);
  }

  attempt(): PairingAttemptResult {
    if (this.used) {
      return { ok: false, failure: "code-used", detail: "This pairing code already paired a desktop. Show a new code on the sandbox." };
    }
    const now = this.now();
    if (!(now >= this.issuedAt && now < this.expiresAt)) {
      return { ok: false, failure: "code-expired", detail: "This pairing code expired. Use the new code the sandbox shows." };
    }
    if (this.attempts >= this.maxAttempts) {
      return { ok: false, failure: "code-attempts-exhausted", detail: `This pairing code was tried ${this.maxAttempts} times. Use the new code the sandbox shows.` };
    }
    this.attempts += 1;
    return { ok: true, remaining: this.maxAttempts - this.attempts };
  }

  succeed(): void {
    this.used = true;
  }
}
