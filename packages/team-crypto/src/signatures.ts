import { sign, verify, type KeyObject } from "node:crypto";
import { domainBytes } from "./canonical.js";
import { SignatureVerificationError } from "./errors.js";
import { readPublicKey } from "./keys.js";
import { bytes } from "./validation.js";

export function signed<T extends object>(type: string, value: T, key: KeyObject): T & { signature: string } {
  return { ...value, signature: sign(null, domainBytes(type, value), key).toString("base64url") };
}

export function verifySigned(type: string, value: { signature: string }, publicKey: string): void {
  const { signature, ...body } = value;
  const signatureBytes = bytes(signature, 64, "Ed25519 signature");
  if (!verify(null, domainBytes(type, body), readPublicKey(publicKey, "ed25519"), signatureBytes)) throw new SignatureVerificationError(`Invalid ${type} signature.`);
}
