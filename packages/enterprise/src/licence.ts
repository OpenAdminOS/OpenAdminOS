// Offline licence check. A licence is a token signed with Ed25519 by the
// team service and verified here against a public key built into the app.
// Checking it needs no network call.
//
// Token format: `<payload>.<signature>`, both base64url without padding.
// `payload` is UTF-8 JSON; `signature` is the Ed25519 signature over the
// bytes of `LICENCE_SIGNING_CONTEXT` followed by the payload segment as
// it appears in the token.
//
// Payload fields (times are whole seconds since the Unix epoch):
//   v             1
//   licenseeId    who the licence was issued to
//   features      team feature ids, for example ["approvals"]
//   notBefore     the licence is not valid before this time
//   expiresAt     the licence expires at this time
//   graceSeconds  how long after expiresAt it is still honoured
// Unknown fields are ignored.

import { createPublicKey, verify, type KeyObject } from "node:crypto";

import type { EnterpriseEntitlement, EnterpriseLicenceState } from "./interface.js";

// TODO(ugur): replace with the team service's licence signing public key
// at release. This placeholder was generated for the stub and its private
// key was discarded, so no token verifies against it.
export const LICENCE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA5k71gwgf+dXFXWD1QpylhAbtVvVCTcSpEzSswSeZXWg=
-----END PUBLIC KEY-----
`;

export const LICENCE_SIGNING_CONTEXT = "openadminos-licence-v1.";

export const LICENCE_LIMITS = Object.freeze({
  maxTokenLength: 4096,
  maxFeatures: 64,
  maxGraceSeconds: 365 * 24 * 60 * 60,
});

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const LICENSEE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FEATURE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const ED25519_SIGNATURE_BYTES = 64;

export type LicenceFailureReason =
  | "missing"
  | "malformed"
  | "signature"
  | "not-yet-valid"
  | "expired";

export type LicenceCheck =
  | { readonly ok: true; readonly entitlement: EnterpriseEntitlement }
  | { readonly ok: false; readonly reason: LicenceFailureReason; readonly message: string };

export interface VerifyLicenceOptions {
  /** SPKI PEM or a KeyObject. Defaults to the key built into the app. */
  readonly publicKey?: string | KeyObject;
  /** Milliseconds since the Unix epoch. */
  readonly now: number;
}

interface LicencePayload {
  readonly licenseeId: string;
  readonly features: readonly string[];
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly graceSeconds: number;
}

export function verifyLicence(token: string | undefined, options: VerifyLicenceOptions): LicenceCheck {
  if (token === undefined || token.trim() === "") {
    return fail("missing", "No licence is installed.");
  }
  const trimmed = token.trim();
  if (trimmed.length > LICENCE_LIMITS.maxTokenLength) {
    return fail("malformed", "The licence is longer than a licence can be.");
  }
  const parts = trimmed.split(".");
  const payloadSegment = parts[0];
  const signatureSegment = parts[1];
  if (
    parts.length !== 2 ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    !SEGMENT.test(payloadSegment) ||
    !SEGMENT.test(signatureSegment)
  ) {
    return fail("malformed", "The licence is not in the expected format.");
  }
  const signature = Buffer.from(signatureSegment, "base64url");
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    return fail("malformed", "The licence signature has the wrong length.");
  }

  let key: KeyObject;
  try {
    key = typeof options.publicKey === "object"
      ? options.publicKey
      : createPublicKey(options.publicKey ?? LICENCE_PUBLIC_KEY_PEM);
  } catch {
    return fail("signature", "The licence public key built into the app could not be read.");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    return fail("signature", "The licence public key built into the app is not an Ed25519 key.");
  }

  let signed: boolean;
  try {
    signed = verify(null, Buffer.from(LICENCE_SIGNING_CONTEXT + payloadSegment, "utf8"), key, signature);
  } catch {
    signed = false;
  }
  if (!signed) {
    return fail("signature", "The licence signature does not match. It was changed or issued for another app.");
  }

  const payload = parsePayload(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  if (!payload) {
    return fail("malformed", "The licence contents are not valid.");
  }

  const notBefore = payload.notBefore * 1000;
  const expiresAt = payload.expiresAt * 1000;
  const graceEndsAt = expiresAt + payload.graceSeconds * 1000;
  const state = licenceState(options.now, notBefore, expiresAt, graceEndsAt);
  if (state === "not-yet-valid") {
    return fail("not-yet-valid", `The licence is not valid before ${new Date(notBefore).toISOString()}.`);
  }
  if (state === "expired") {
    return fail("expired", `The licence expired and its grace period ended ${new Date(graceEndsAt).toISOString()}.`);
  }
  return {
    ok: true,
    entitlement: Object.freeze({
      state,
      licenseeId: payload.licenseeId,
      features: Object.freeze([...payload.features]),
      notBefore,
      expiresAt,
      graceEndsAt,
    }),
  };
}

/** The state of an already verified licence at `now`. */
export function entitlementAt(entitlement: EnterpriseEntitlement, now: number): EnterpriseEntitlement {
  const state = licenceState(now, entitlement.notBefore, entitlement.expiresAt, entitlement.graceEndsAt);
  const next: EnterpriseLicenceState = state === "not-yet-valid" ? "expired" : state;
  return next === entitlement.state ? entitlement : Object.freeze({ ...entitlement, state: next });
}

function licenceState(
  now: number,
  notBefore: number,
  expiresAt: number,
  graceEndsAt: number,
): EnterpriseLicenceState | "not-yet-valid" {
  if (now < notBefore) return "not-yet-valid";
  if (now < expiresAt) return "active";
  if (now < graceEndsAt) return "grace";
  return "expired";
}

function parsePayload(text: string): LicencePayload | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { v, licenseeId, features, notBefore, expiresAt, graceSeconds } = record;
  if (v !== 1) return undefined;
  if (typeof licenseeId !== "string" || !LICENSEE_ID.test(licenseeId)) return undefined;
  if (!Array.isArray(features) || features.length > LICENCE_LIMITS.maxFeatures) return undefined;
  if (!features.every((feature): feature is string => typeof feature === "string" && FEATURE_ID.test(feature))) {
    return undefined;
  }
  if (new Set(features).size !== features.length) return undefined;
  if (!isEpochSeconds(notBefore) || !isEpochSeconds(expiresAt) || expiresAt <= notBefore) return undefined;
  if (
    typeof graceSeconds !== "number" ||
    !Number.isSafeInteger(graceSeconds) ||
    graceSeconds < 0 ||
    graceSeconds > LICENCE_LIMITS.maxGraceSeconds
  ) {
    return undefined;
  }
  return { licenseeId, features, notBefore, expiresAt, graceSeconds };
}

function isEpochSeconds(value: unknown): value is number {
  // Up to the year 9999, so the millisecond value stays a valid Date.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 253_402_300_799;
}

function fail(reason: LicenceFailureReason, message: string): LicenceCheck {
  return { ok: false, reason, message };
}
