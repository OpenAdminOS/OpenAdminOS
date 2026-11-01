import { createCipheriv, createDecipheriv, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { domainBytes } from "./canonical.js";
import { validateCertificate } from "./certificates.js";
import { CertificateChainError, DecryptionError, FormatError, InvalidKeyError, NotRecipientError } from "./errors.js";
import { assertDeviceKeys, publicKeyBytes, readPublicKey } from "./keys.js";
import { signed, verifySigned } from "./signatures.js";
import type { DeviceCertificate, DeviceKeys, PayloadEnvelope, PayloadHeader, WrappedContentKey } from "./types.js";
import { bytes, record, sortedIds, text, timestamp } from "./validation.js";

function validateHeader(header: PayloadHeader): void {
  record(header, ["v", "payloadId", "teamId", "kind", "senderDeviceId", "createdAt"], "Payload header");
  for (const field of ["payloadId", "teamId", "kind", "senderDeviceId"] as const) text(header[field], field);
  timestamp(header.createdAt, "Payload createdAt");
}

function validateEnvelope(envelope: PayloadEnvelope): void {
  record(envelope, ["v", "header", "recipientDeviceIds", "ephemeralPublicKey", "wrappedKeys", "nonce", "ciphertext", "tag", "signature"], "Payload envelope");
  validateHeader(envelope.header);
  sortedIds(envelope.recipientDeviceIds, "Recipient device identifiers", false);
  readPublicKey(envelope.ephemeralPublicKey, "x25519");
  bytes(envelope.nonce, 12, "Payload nonce");
  bytes(envelope.tag, 16, "Payload authentication tag");
  bytes(envelope.ciphertext, undefined, "Payload ciphertext");
  bytes(envelope.signature, 64, "Envelope signature");
  if (!Array.isArray(envelope.wrappedKeys) || envelope.wrappedKeys.length !== envelope.recipientDeviceIds.length) throw new FormatError("Envelope must wrap a key for every recipient.");
  for (const [i, wrap] of envelope.wrappedKeys.entries()) {
    record(wrap, ["v", "deviceId", "nonce", "ciphertext", "tag"], "Wrapped content key");
    if (wrap.deviceId !== envelope.recipientDeviceIds[i]) throw new FormatError("Wrapped keys must match the sorted recipient identifiers.");
    bytes(wrap.nonce, 12, "Wrapped key nonce");
    bytes(wrap.ciphertext, 32, "Wrapped content key ciphertext");
    bytes(wrap.tag, 16, "Wrapped key authentication tag");
  }
}

function encrypt(plaintext: Uint8Array, key: Buffer, aad: Buffer): { nonce: string; ciphertext: string; tag: string } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  return {
    nonce: nonce.toString("base64url"),
    ciphertext: Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}

function decrypt(value: { nonce: string; ciphertext: string; tag: string }, key: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, bytes(value.nonce, 12, "AES nonce"), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes(value.tag, 16, "AES authentication tag"));
  // Do not expose unauthenticated output if final() rejects the tag.
  const pending = decipher.update(bytes(value.ciphertext, undefined, "AES ciphertext"));
  try {
    return Buffer.concat([pending, decipher.final()]);
  } finally {
    pending.fill(0);
  }
}

function kek(privateKey: KeyObject, peerPublicKey: string, ephemeralPublicKey: string, recipientPublicKey: string): Buffer {
  const shared = diffieHellman({ privateKey, publicKey: readPublicKey(peerPublicKey, "x25519") });
  try {
    return Buffer.from(hkdfSync("sha256", shared,
      Buffer.concat([bytes(ephemeralPublicKey, 32, "Ephemeral public key"), bytes(recipientPublicKey, 32, "Recipient public key")]),
      Buffer.from("openadminos-team/v1/content-key-wrap", "utf8"), 32));
  } finally {
    shared.fill(0);
  }
}

function payloadAAD(header: PayloadHeader, recipientDeviceIds: string[]): Buffer {
  return domainBytes("payload-aad", { v: 1, header, recipientDeviceIds });
}

function wrapAAD(header: PayloadHeader, recipientDeviceIds: string[], ephemeralPublicKey: string, recipientDeviceId: string): Buffer {
  return domainBytes("wrap-aad", { v: 1, header, recipientDeviceIds, ephemeralPublicKey, recipientDeviceId });
}

/** Recipients must already pass verifyDeviceChain with a fresh revocation list. */
export function sealPayload(plaintext: Uint8Array, header: PayloadHeader, senderKeys: DeviceKeys, recipients: readonly DeviceCertificate[]): PayloadEnvelope {
  if (!(plaintext instanceof Uint8Array)) throw new FormatError("Payload plaintext must be bytes.");
  validateHeader(header);
  assertDeviceKeys(senderKeys);
  if (!Array.isArray(recipients) || !recipients.length) throw new FormatError("Payload requires at least one recipient.");
  for (const certificate of recipients) validateCertificate(certificate);
  const sorted = [...recipients].sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
  const recipientDeviceIds = sorted.map((certificate) => {
    validateCertificate(certificate);
    if (certificate.teamId !== header.teamId) throw new CertificateChainError("Payload recipient belongs to a different team.");
    return certificate.deviceId;
  });
  sortedIds(recipientDeviceIds, "Recipient device identifiers", false);
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralPublicKey = publicKeyBytes(ephemeral.publicKey);
  const contentKey = randomBytes(32);
  try {
    const encrypted = encrypt(plaintext, contentKey, payloadAAD(header, recipientDeviceIds));
    const wrappedKeys: WrappedContentKey[] = sorted.map((certificate) => {
      let wrappingKey: Buffer;
      try {
        wrappingKey = kek(ephemeral.privateKey, certificate.encryptionPublicKey, ephemeralPublicKey, certificate.encryptionPublicKey);
      } catch (cause) {
        throw new InvalidKeyError(`Cannot agree an encryption key with device ${certificate.deviceId}.`, { cause });
      }
      try {
        return { v: 1, deviceId: certificate.deviceId, ...encrypt(contentKey, wrappingKey, wrapAAD(header, recipientDeviceIds, ephemeralPublicKey, certificate.deviceId)) };
      } finally {
        wrappingKey.fill(0);
      }
    });
    return signed("payload-envelope", {
      v: 1 as const, header: { ...header }, recipientDeviceIds, ephemeralPublicKey, wrappedKeys, ...encrypted,
    }, senderKeys.signingPrivateKey);
  } finally {
    contentKey.fill(0);
  }
}

/** Sender certificate must already pass verifyDeviceChain. Signature precedes key agreement. */
export function openPayload(envelope: PayloadEnvelope, senderCertificate: DeviceCertificate, openingDeviceId: string, openingKeys: DeviceKeys): Buffer {
  validateEnvelope(envelope);
  validateCertificate(senderCertificate);
  if (senderCertificate.teamId !== envelope.header.teamId || senderCertificate.deviceId !== envelope.header.senderDeviceId) throw new CertificateChainError("Envelope sender does not match the sender certificate.");
  verifySigned("payload-envelope", envelope, senderCertificate.signingPublicKey);
  text(openingDeviceId, "Opening device identifier");
  const wrap = envelope.wrappedKeys.find((candidate) => candidate.deviceId === openingDeviceId);
  if (!wrap) throw new NotRecipientError(`Device ${openingDeviceId} is not a recipient of this payload.`);
  assertDeviceKeys(openingKeys);
  let wrappingKey: Buffer | undefined;
  let contentKey: Buffer | undefined;
  try {
    wrappingKey = kek(openingKeys.encryptionPrivateKey, envelope.ephemeralPublicKey, envelope.ephemeralPublicKey, openingKeys.encryptionPublicKey);
    contentKey = decrypt(wrap, wrappingKey, wrapAAD(envelope.header, envelope.recipientDeviceIds, envelope.ephemeralPublicKey, openingDeviceId));
    return decrypt(envelope, contentKey, payloadAAD(envelope.header, envelope.recipientDeviceIds));
  } catch (cause) {
    throw new DecryptionError("Cannot decrypt payload with this device's keys. Check the enrolled device and payload integrity.", { cause });
  } finally {
    wrappingKey?.fill(0);
    contentKey?.fill(0);
  }
}
