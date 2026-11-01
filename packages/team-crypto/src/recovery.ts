import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { RecoveryKitError } from "./errors.js";
import { publicKeyBytes } from "./keys.js";
import type { RecoveryKit } from "./types.js";
import { record } from "./validation.js";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const recoveryDomain = "openadminos-team/v1/recovery";

function checksum(secret: Buffer): Buffer {
  return createHash("sha256").update(`${recoveryDomain}/checksum\0`).update(secret).digest().subarray(0, 4);
}

function base32(bytes: Buffer): string {
  let bits = 0;
  let accumulator = 0;
  let result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}

function decode(code: string): Buffer {
  if (typeof code !== "string" || !/^[A-Za-z2-7\s-]+$/.test(code)) throw new RecoveryKitError("Recovery code contains unsupported characters.");
  const normalized = code.replace(/[\s-]/g, "").toUpperCase();
  if (normalized.length !== 58) throw new RecoveryKitError("Recovery code must contain 58 base32 characters.");
  let bits = 0;
  let accumulator = 0;
  const result: number[] = [];
  for (const character of normalized) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      result.push((accumulator >>> bits) & 255);
    }
  }
  const decoded = Buffer.from(result);
  if (base32(decoded) !== normalized) throw new RecoveryKitError("Recovery code has invalid padding bits.");
  const secret = Buffer.from(decoded.subarray(0, 32));
  const valid = timingSafeEqual(checksum(secret), decoded.subarray(32));
  decoded.fill(0);
  if (!valid) {
    secret.fill(0);
    throw new RecoveryKitError("Recovery code checksum does not match. Check the printed code.");
  }
  return secret;
}

function derive(secret: Buffer): KeyObject {
  const seed = Buffer.from(hkdfSync("sha256", secret, Buffer.from(`${recoveryDomain}/salt`), Buffer.from(`${recoveryDomain}/ed25519`), 32));
  // RFC 8410 PKCS8 prefix for an Ed25519 32-byte seed.
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  try {
    return createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } finally {
    seed.fill(0);
    der.fill(0);
  }
}

/** Import accepts case, whitespace and hyphens, then returns the canonical printed code. */
export function importRecoveryKit(code: string): RecoveryKit {
  const secret = decode(code);
  try {
    const key = derive(secret);
    return {
      v: 1,
      code: base32(Buffer.concat([secret, checksum(secret)])).match(/.{1,4}/g)!.join("-"),
      signingPublicKey: publicKeyBytes(createPublicKey(key)),
    };
  } finally {
    secret.fill(0);
  }
}

export function generateRecoveryKit(): RecoveryKit {
  const secret = randomBytes(32);
  try {
    return importRecoveryKit(base32(Buffer.concat([secret, checksum(secret)])));
  } finally {
    secret.fill(0);
  }
}

export function recoveryPrivateKey(kit: RecoveryKit): KeyObject {
  record(kit, ["v", "code", "signingPublicKey"], "Recovery kit");
  const secret = decode(kit.code);
  try {
    const key = derive(secret);
    if (publicKeyBytes(createPublicKey(key)) !== kit.signingPublicKey) throw new RecoveryKitError("Recovery public key does not match the printed code.");
    return key;
  } finally {
    secret.fill(0);
  }
}
