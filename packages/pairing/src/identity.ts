import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

import { encodeBase32 } from "./base32.js";
import { PairingError } from "./errors.js";

/**
 * The Ed25519 key a sandbox or a desktop signs with. The private key
 * stays on its device; the public key goes into the pairing record.
 */
export interface DeviceIdentity {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): the 32 raw key bytes follow. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_RAW_LENGTH = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export function generateDeviceIdentity(): DeviceIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey };
}

/** PKCS #8 PEM, for a file of mode 0600 or the OS keychain. */
export function exportDevicePrivateKey(identity: DeviceIdentity): string {
  return identity.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/** Reads a PKCS #8 PEM written by `exportDevicePrivateKey`; refuses any key that is not Ed25519. */
export function importDevicePrivateKey(pem: string): DeviceIdentity {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: pem, format: "pem" });
  } catch (error) {
    throw new PairingError("key-invalid", "The device private key is not a readable PEM key.", { cause: error });
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new PairingError("key-invalid", `The device private key is ${privateKey.asymmetricKeyType ?? "not asymmetric"}, not Ed25519.`);
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

/** The 32 raw public key bytes as base64url without padding (43 characters): the form in records. */
export function exportDevicePublicKey(publicKey: KeyObject): string {
  return rawPublicKey(publicKey).toString("base64url");
}

/** The SubjectPublicKeyInfo DER of the public key (44 bytes). */
export function exportDevicePublicKeySpki(publicKey: KeyObject): Buffer {
  assertEd25519Public(publicKey);
  return publicKey.export({ type: "spki", format: "der" });
}

/** Reads the base64url raw form; throws `key-invalid` for anything else. */
export function importDevicePublicKey(encoded: string): KeyObject {
  const raw = decodeRawPublicKey(encoded);
  if (!raw) {
    throw new PairingError("key-invalid", "The device public key is not 32 bytes of base64url without padding.");
  }
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** Whether `encoded` is the canonical base64url form of a 32 byte key. */
export function isDevicePublicKey(encoded: unknown): encoded is string {
  return typeof encoded === "string" && decodeRawPublicKey(encoded) !== undefined;
}

export type FingerprintFormat = "hex" | "base32";

/**
 * SHA-256 of the public key's SubjectPublicKeyInfo DER. `hex` is 64
 * lowercase characters; `base32` is Crockford base32, 52 characters, for
 * showing to a person.
 */
export function deviceFingerprint(publicKey: KeyObject, format: FingerprintFormat = "hex"): string {
  const digest = createHash("sha256").update(exportDevicePublicKeySpki(publicKey)).digest();
  return format === "hex" ? digest.toString("hex") : encodeBase32(digest);
}

function rawPublicKey(publicKey: KeyObject): Buffer {
  return exportDevicePublicKeySpki(publicKey).subarray(ED25519_SPKI_PREFIX.length);
}

function assertEd25519Public(publicKey: KeyObject): void {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new PairingError("key-invalid", "The device public key is not an Ed25519 public key.");
  }
}

function decodeRawPublicKey(encoded: string): Buffer | undefined {
  if (typeof encoded !== "string" || encoded.length !== 43 || !BASE64URL.test(encoded)) return undefined;
  const raw = Buffer.from(encoded, "base64url");
  // Only the canonical encoding: the last character must not carry stray bits.
  if (raw.length !== ED25519_RAW_LENGTH || raw.toString("base64url") !== encoded) return undefined;
  return raw;
}
