import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject } from "node:crypto";
import { domainBytes } from "./canonical.js";
import { InvalidKeyError } from "./errors.js";
import type { DeviceKeys, DevicePublicKeys, SerializedDeviceKeys } from "./types.js";
import { bytes, record } from "./validation.js";

type Algorithm = "x25519" | "ed25519";

export function publicKeyBytes(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" });
  if (!jwk.x) throw new InvalidKeyError("Public key has no curve coordinate.");
  return jwk.x;
}

export function readPublicKey(value: string, algorithm: Algorithm): KeyObject {
  bytes(value, 32, `${algorithm} public key`);
  try {
    return createPublicKey({ key: { kty: "OKP", crv: algorithm === "x25519" ? "X25519" : "Ed25519", x: value }, format: "jwk" });
  } catch (cause) {
    throw new InvalidKeyError(`Cannot import ${algorithm} public key.`, { cause });
  }
}

function readPrivateKey(value: string, algorithm: Algorithm): KeyObject {
  const der = bytes(value, undefined, `${algorithm} private key`);
  try {
    const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== algorithm || !key.export({ format: "der", type: "pkcs8" }).equals(der)) throw new InvalidKeyError(`Private key must be canonical ${algorithm} PKCS8 DER.`);
    return key;
  } catch (cause) {
    throw new InvalidKeyError(`Cannot import ${algorithm} private key.`, { cause });
  }
}

export function assertDeviceKeys(keys: DeviceKeys): void {
  if (!keys || keys.v !== 1) throw new InvalidKeyError("Device keys must use format version 1.");
  for (const [algorithm, privateKey, publicKey] of [
    ["x25519", keys.encryptionPrivateKey, keys.encryptionPublicKey],
    ["ed25519", keys.signingPrivateKey, keys.signingPublicKey],
  ] as const) {
    if (!(privateKey instanceof KeyObject) || privateKey.type !== "private" || privateKey.asymmetricKeyType !== algorithm) throw new InvalidKeyError(`Device requires an ${algorithm} private key.`);
    readPublicKey(publicKey, algorithm);
    if (publicKeyBytes(createPublicKey(privateKey)) !== publicKey) throw new InvalidKeyError(`Device ${algorithm} public and private keys do not match.`);
  }
}

export function generateDeviceKeys(): DeviceKeys {
  const encryption = generateKeyPairSync("x25519");
  const signing = generateKeyPairSync("ed25519");
  return {
    v: 1,
    encryptionPublicKey: publicKeyBytes(encryption.publicKey),
    signingPublicKey: publicKeyBytes(signing.publicKey),
    encryptionPrivateKey: encryption.privateKey,
    signingPrivateKey: signing.privateKey,
  };
}

export function exportDeviceKeys(keys: DeviceKeys): SerializedDeviceKeys {
  assertDeviceKeys(keys);
  return {
    v: 1,
    encryptionPublicKey: keys.encryptionPublicKey,
    signingPublicKey: keys.signingPublicKey,
    encryptionPrivateKey: keys.encryptionPrivateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    signingPrivateKey: keys.signingPrivateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

export function importDeviceKeys(value: SerializedDeviceKeys): DeviceKeys {
  record(value, ["v", "encryptionPublicKey", "signingPublicKey", "encryptionPrivateKey", "signingPrivateKey"], "Device keys");
  const keys: DeviceKeys = {
    v: 1,
    encryptionPublicKey: value.encryptionPublicKey,
    signingPublicKey: value.signingPublicKey,
    encryptionPrivateKey: readPrivateKey(value.encryptionPrivateKey, "x25519"),
    signingPrivateKey: readPrivateKey(value.signingPrivateKey, "ed25519"),
  };
  assertDeviceKeys(keys);
  return keys;
}

/** 128 bits, displayed as eight groups of four hexadecimal characters. */
export function deviceFingerprint(keys: DevicePublicKeys): string {
  if (keys.v !== 1) throw new InvalidKeyError("Device public keys must use format version 1.");
  readPublicKey(keys.encryptionPublicKey, "x25519");
  readPublicKey(keys.signingPublicKey, "ed25519");
  const digest = createHash("sha256").update(domainBytes("device-fingerprint", {
    v: 1, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
  })).digest("hex").slice(0, 32).toUpperCase();
  return digest.match(/.{4}/g)!.join("-");
}
