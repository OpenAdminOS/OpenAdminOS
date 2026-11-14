import { sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";

import { canonicalJson } from "@openadminos/runtime";

import { PairingError } from "./errors.js";
import { importDevicePublicKey } from "./identity.js";
import { isJsonValue } from "./validate.js";

/**
 * Every purpose a device key signs for. A signature made for one domain
 * never verifies for another, so a signed pairing record cannot be
 * replayed as a checkpoint or an assignment. New purposes get a new
 * domain once their record exists; a changed payload shape gets a new
 * version.
 */
export const SIGNATURE_DOMAINS = [
  "openadminos.pairing.record.v1",
  "openadminos.audit.checkpoint.v1",
  "openadminos.schedule.assignment.v1",
] as const;

export type SignatureDomain = (typeof SIGNATURE_DOMAINS)[number];

const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export function isSignatureDomain(value: unknown): value is SignatureDomain {
  return typeof value === "string" && (SIGNATURE_DOMAINS as readonly string[]).includes(value);
}

/** The signed bytes: the domain, a line feed, then canonical JSON of the payload, in UTF-8. */
export function signedMessage(domain: SignatureDomain, payload: unknown): Buffer {
  if (!isSignatureDomain(domain)) {
    throw new PairingError("payload-invalid", `${JSON.stringify(domain)} is not a signature domain.`);
  }
  if (!isJsonValue(payload)) {
    throw new PairingError("payload-invalid", "The payload is not plain JSON: it holds a value canonical JSON cannot keep, such as undefined, a non-finite number or a class instance.");
  }
  return Buffer.from(`${domain}\n${canonicalJson(payload)}`, "utf8");
}

/** An Ed25519 signature over `signedMessage`, as base64url (86 characters). */
export function sign(domain: SignatureDomain, payload: unknown, privateKey: KeyObject): string {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new PairingError("key-invalid", "Signing needs an Ed25519 private key.");
  }
  return signBytes(null, signedMessage(domain, payload), privateKey).toString("base64url");
}

/**
 * Whether `signature` is the signer's signature over `payload` in
 * `domain`. The public key is a KeyObject or the raw base64url form.
 * False, never a throw, for any malformed input.
 */
export function verify(domain: SignatureDomain, payload: unknown, signature: unknown, publicKey: KeyObject | string): boolean {
  if (typeof signature !== "string" || !SIGNATURE.test(signature)) return false;
  let key: KeyObject;
  let message: Buffer;
  try {
    key = typeof publicKey === "string" ? importDevicePublicKey(publicKey) : publicKey;
    message = signedMessage(domain, payload);
  } catch {
    return false;
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") return false;
  const bytes = Buffer.from(signature, "base64url");
  // Only the canonical encoding of the 64 bytes.
  if (bytes.length !== 64 || bytes.toString("base64url") !== signature) return false;
  try {
    return verifyBytes(null, message, key, bytes);
  } catch {
    return false;
  }
}
