import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

import { canonicalJson } from "@openadminos/runtime";

import { encodeBase32, normalizeBase32 } from "./base32.js";
import { isTlsSpkiPin } from "./certificate.js";
import { PairingError } from "./errors.js";
import { isDevicePublicKey } from "./identity.js";
import { isIdentifier, isTenantId } from "./validate.js";

/**
 * A pairing code is 28 Crockford base32 characters that the sandbox
 * shows and the admin types into the desktop:
 *
 * - characters 1 to 16: the first 80 bits of the sandbox's TLS SPKI
 *   SHA-256, so the desktop pins the right TLS key before it sends anything;
 * - characters 17 to 28: 60 random bits, the secret that keys the
 *   transcript proofs. The secret is never sent; only HMACs keyed by a
 *   key derived from it are, inside the pinned TLS connection.
 *
 * Why not a PAKE in v1: the fingerprint part pins the TLS key, so a
 * man in the middle would need an 80 bit second preimage of the SPKI
 * hash within the code's lifetime. Inside that channel only the real
 * sandbox sees a proof; it allows 5 proof checks per code and a code
 * lives 10 minutes. The scrypt key derivation makes each offline guess
 * at a leaked proof memory-hard on top of the 60 bit secret.
 * TODO(ugur): consider CPace (a balanced PAKE) in a later protocol version,
 * so a proof gives an attacker nothing to guess against offline.
 */
export const PAIRING_CODE_LENGTH = 28;
export const PAIRING_CODE_FINGERPRINT_LENGTH = 16;
export const PAIRING_CODE_SECRET_LENGTH = 12;
/** Shown as groups of this many characters, separated by hyphens. */
export const PAIRING_CODE_GROUP_LENGTH = 4;
/** A code is valid this long after it is shown; the sandbox then shows a new one. */
export const PAIRING_CODE_LIFETIME_MS = 10 * 60_000;
/** Desktop proofs checked per code, right or wrong. */
export const PAIRING_CODE_MAX_ATTEMPTS = 5;

const TRANSCRIPT_DOMAIN = "openadminos.pairing.transcript.v1";
const KEY_DOMAIN = "openadminos.pairing.key.v1";
/** scrypt cost: N = 2^15, r = 8, p = 1 needs 32 MiB, so the limit is set above it. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
/** Typed codes may be grouped with spaces or hyphens; longer input is refused before it is read. */
const MAX_TYPED_LENGTH = 64;

export interface PairingCode {
  /** The 28 canonical characters. */
  code: string;
  /** The first 16 characters. */
  fingerprint: string;
  /** The last 12 characters. */
  secret: string;
}

export function createPairingCode(tlsSpkiSha256: string): PairingCode {
  const fingerprint = pairingCodeFingerprint(tlsSpkiSha256);
  // 8 random bytes encode to 13 characters; the first 12 carry 60 uniform bits.
  const secret = encodeBase32(randomBytes(8)).slice(0, PAIRING_CODE_SECRET_LENGTH);
  return { code: `${fingerprint}${secret}`, fingerprint, secret };
}

/** The first 16 characters for a TLS SPKI pin (64 lowercase hex). */
export function pairingCodeFingerprint(tlsSpkiSha256: string): string {
  if (!isTlsSpkiPin(tlsSpkiSha256)) {
    throw new PairingError("key-invalid", "The TLS SPKI pin is not 64 lowercase hex characters.");
  }
  return encodeBase32(Buffer.from(tlsSpkiSha256, "hex")).slice(0, PAIRING_CODE_FINGERPRINT_LENGTH);
}

/** Seven groups of four, for showing: `ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345`. */
export function formatPairingCode(code: PairingCode): string {
  return code.code.match(new RegExp(`.{1,${PAIRING_CODE_GROUP_LENGTH}}`, "g"))?.join("-") ?? code.code;
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

/**
 * The desktop's side. It reached the sandbox over TLS, checked the
 * peer's SPKI against the code, and got the sandbox's pairing id and
 * public key. It sends `desktopProof()` first and checks the sandbox's
 * proof only after that.
 */
export class DesktopPairingSession {
  readonly fields: PairingTranscriptFields;
  private readonly key: Buffer;
  private sent = false;

  private constructor(fields: PairingTranscriptFields, key: Buffer) {
    this.fields = fields;
    this.key = key;
  }

  /** Rejects with `fingerprint-mismatch` when the TLS key is not the one the code names, `payload-invalid` for fields out of shape. */
  static async create(code: PairingCode, fields: PairingTranscriptFields): Promise<DesktopPairingSession> {
    pairingTranscript("desktop", fields);
    if (!pairingCodeMatchesSpki(code, fields.tlsSpkiSha256)) {
      throw new PairingError("fingerprint-mismatch", "The sandbox's TLS key is not the one the pairing code names. Check the code on the sandbox, and that the address is the sandbox's.");
    }
    const copy = { ...fields };
    return new DesktopPairingSession(copy, await derivePairingKey(code, copy));
  }

  desktopProof(): string {
    this.sent = true;
    return proofFor(this.key, "desktop", this.fields);
  }

  /** Constant-time; throws `proof-order` before `desktopProof()` was produced. */
  verifySandboxProof(proof: unknown): boolean {
    if (!this.sent) {
      throw new PairingError("proof-order", "The desktop sends its proof before it checks the sandbox's.");
    }
    return proofMatches(this.key, "sandbox", this.fields, proof);
  }
}

export interface SandboxPairingSessionOptions extends Omit<PairingAttemptLimiterOptions, "issuedAt"> {
  code: PairingCode;
  pairingId: string;
  sandboxPublicKey: string;
  tlsSpkiSha256: string;
  /** The sandbox's own organization and tenant, from its config: a desktop for another one cannot pair. */
  organizationId: string;
  tenantId: string;
  /** When the code was shown, in the clock's milliseconds. */
  issuedAt: number;
}

/** What the desktop offers with its proof; the rest of the transcript is the sandbox's own. */
export interface DesktopPairingOffer {
  organizationId: string;
  tenantId: string;
  desktopPublicKey: string;
}

export type DesktopProofFailure =
  | PairingAttemptFailure
  /** The offer is out of shape; it still counts as an attempt. */
  | "transcript-invalid"
  /** The desktop offers another organization or tenant than the sandbox's config; it still counts as an attempt. */
  | "binding-mismatch"
  /** The proof does not match: a wrong code or a changed transcript. */
  | "proof-invalid";

export type DesktopProofResult =
  | { ok: true; fields: PairingTranscriptFields }
  | { ok: false; failure: DesktopProofFailure; detail: string; remaining: number };

/**
 * The sandbox's side for one shown code. Create one session when a code
 * is shown and share it across every connection that tries that code,
 * so the attempt limit and the lifetime hold for the code, not per
 * connection; a new code gets a new session.
 *
 * Every desktop proof counts against the code's attempts, right or
 * wrong. Only after a desktop proof verifies does `sandboxProof()`
 * produce the sandbox's proof, and the code cannot pair again: when the
 * connection drops after that, pairing needs a new code.
 */
export class SandboxPairingSession {
  private readonly limiter: PairingAttemptLimiter;
  private readonly key: Buffer;
  private readonly own: Omit<PairingTranscriptFields, "desktopPublicKey">;
  private verified: PairingTranscriptFields | undefined;

  private constructor(limiter: PairingAttemptLimiter, own: Omit<PairingTranscriptFields, "desktopPublicKey">, key: Buffer) {
    this.limiter = limiter;
    this.own = own;
    this.key = key;
  }

  /** Rejects with `payload-invalid` for options out of shape, `fingerprint-mismatch` for a code made for another TLS key. */
  static async create(options: SandboxPairingSessionOptions): Promise<SandboxPairingSession> {
    const { code, pairingId, sandboxPublicKey, tlsSpkiSha256, organizationId, tenantId, ...limiterOptions } = options;
    if (!isIdentifier(pairingId) || !isDevicePublicKey(sandboxPublicKey) || !isTlsSpkiPin(tlsSpkiSha256) || !isIdentifier(organizationId) || !isTenantId(tenantId)) {
      throw new PairingError("payload-invalid", "The sandbox session needs a pairing id, the sandbox public key, its TLS SPKI pin, and the organization and lowercase tenant id from its config.");
    }
    if (!pairingCodeMatchesSpki(code, tlsSpkiSha256)) {
      throw new PairingError("fingerprint-mismatch", "The pairing code was not made for this sandbox's TLS key.");
    }
    const limiter = new PairingAttemptLimiter(limiterOptions);
    const own = { pairingId, sandboxPublicKey, tlsSpkiSha256, organizationId, tenantId };
    return new SandboxPairingSession(limiter, own, await derivePairingKey(code, own));
  }

  get remaining(): number {
    return this.limiter.remaining;
  }

  verifyDesktopProof(offer: DesktopPairingOffer, proof: unknown): DesktopProofResult {
    const attempt = this.limiter.attempt();
    if (!attempt.ok) return { ...attempt, remaining: 0 };
    const fields: PairingTranscriptFields = {
      ...this.own,
      organizationId: offer?.organizationId,
      tenantId: offer?.tenantId,
      desktopPublicKey: offer?.desktopPublicKey,
    };
    if (transcriptProblem("desktop", fields)) {
      return { ok: false, failure: "transcript-invalid", detail: "The desktop's pairing request is out of shape.", remaining: attempt.remaining };
    }
    if (fields.organizationId !== this.own.organizationId || fields.tenantId !== this.own.tenantId) {
      return {
        ok: false,
        failure: "binding-mismatch",
        detail: "The desktop's active organization or tenant is not the one this sandbox is configured for. Switch the desktop to the sandbox's organization, then pair again.",
        remaining: attempt.remaining,
      };
    }
    if (!proofMatches(this.key, "desktop", fields, proof)) {
      return { ok: false, failure: "proof-invalid", detail: "The desktop's proof does not match this pairing code. Check the code typed on the desktop.", remaining: attempt.remaining };
    }
    this.limiter.succeed();
    this.verified = fields;
    return { ok: true, fields: { ...fields } };
  }

  /** Throws `proof-order` until a desktop proof verified. */
  sandboxProof(): string {
    if (!this.verified) {
      throw new PairingError("proof-order", "The sandbox sends its proof only after the desktop's proof verified.");
    }
    return proofFor(this.key, "sandbox", this.verified);
  }
}

/**
 * scrypt of the code's secret, salted with the key domain, the TLS SPKI
 * pin and the pairing id, so a derived key is bound to one sandbox key
 * and one pairing. Asynchronous, so the 32 MiB derivation does not hold
 * the event loop.
 */
async function derivePairingKey(code: PairingCode, fields: Pick<PairingTranscriptFields, "pairingId" | "tlsSpkiSha256">): Promise<Buffer> {
  const secret = typeof code?.secret === "string" ? normalizeBase32(code.secret) : undefined;
  if (secret === undefined || secret.length !== PAIRING_CODE_SECRET_LENGTH) {
    throw new PairingError("payload-invalid", `The pairing code secret is not ${PAIRING_CODE_SECRET_LENGTH} base32 characters.`);
  }
  const salt = Buffer.from(`${KEY_DOMAIN}\n${fields.tlsSpkiSha256}\n${fields.pairingId}`, "utf8");
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(secret, "ascii"), salt, 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** HMAC-SHA256 of the transcript as base64url (43 characters). */
function proofFor(key: Buffer, role: PairingProofRole, fields: PairingTranscriptFields): string {
  return createHmac("sha256", key).update(pairingTranscript(role, fields)).digest("base64url");
}

function proofMatches(key: Buffer, role: PairingProofRole, fields: PairingTranscriptFields, proof: unknown): boolean {
  if (typeof proof !== "string" || !PROOF.test(proof)) return false;
  const given = Buffer.from(proof, "base64url");
  const expected = Buffer.from(proofFor(key, role, fields), "base64url");
  // A non-canonical last character decodes to the same bytes; refuse it.
  return given.length === expected.length && given.toString("base64url") === proof && timingSafeEqual(given, expected);
}

function transcriptProblem(role: PairingProofRole, fields: PairingTranscriptFields): string | undefined {
  if (role !== "desktop" && role !== "sandbox") return "role is not desktop or sandbox";
  if (fields === null || typeof fields !== "object") return "fields";
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
  /** Fewer attempts than the protocol's 5; a larger value is clamped to 5. */
  maxAttempts?: number;
  /** A shorter lifetime than the protocol's 10 minutes; a longer one is clamped. */
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
    // Overrides can only tighten the protocol limits, never loosen them.
    const maxAttempts = Math.min(options.maxAttempts ?? PAIRING_CODE_MAX_ATTEMPTS, PAIRING_CODE_MAX_ATTEMPTS);
    const lifetimeMs = Math.min(options.lifetimeMs ?? PAIRING_CODE_LIFETIME_MS, PAIRING_CODE_LIFETIME_MS);
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
