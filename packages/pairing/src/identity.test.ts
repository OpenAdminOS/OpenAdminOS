import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { PairingError } from "./errors.js";
import {
  deviceFingerprint,
  exportDevicePrivateKey,
  exportDevicePublicKey,
  exportDevicePublicKeySpki,
  generateDeviceIdentity,
  importDevicePrivateKey,
  importDevicePublicKey,
  isDevicePublicKey,
} from "./identity.js";

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PairingError);
    return error.reason;
  }
  return "accepted";
}

describe("device identity", () => {
  it("round-trips the private key through PKCS #8 PEM", () => {
    const identity = generateDeviceIdentity();
    const pem = exportDevicePrivateKey(identity);
    assert.match(pem, /^-----BEGIN PRIVATE KEY-----/);
    const restored = importDevicePrivateKey(pem);
    assert.equal(exportDevicePublicKey(restored.publicKey), exportDevicePublicKey(identity.publicKey));
  });

  it("round-trips the public key through the raw base64url form", () => {
    const identity = generateDeviceIdentity();
    const encoded = exportDevicePublicKey(identity.publicKey);
    assert.equal(encoded.length, 43);
    assert.ok(isDevicePublicKey(encoded));
    assert.ok(importDevicePublicKey(encoded).equals(identity.publicKey));
    assert.equal(exportDevicePublicKeySpki(identity.publicKey).length, 44);
  });

  it("fingerprints the SPKI DER in hex and base32", () => {
    const identity = generateDeviceIdentity();
    const expected = createHash("sha256").update(identity.publicKey.export({ type: "spki", format: "der" })).digest("hex");
    assert.equal(deviceFingerprint(identity.publicKey), expected);
    assert.match(deviceFingerprint(identity.publicKey, "base32"), /^[0-9A-HJKMNP-TV-Z]{52}$/);
    assert.notEqual(deviceFingerprint(generateDeviceIdentity().publicKey), expected);
  });

  it("refuses keys that are not Ed25519", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    assert.equal(reasonOf(() => importDevicePrivateKey(privateKey.export({ type: "pkcs8", format: "pem" }).toString())), "key-invalid");
    assert.equal(reasonOf(() => exportDevicePublicKey(publicKey)), "key-invalid");
    assert.equal(reasonOf(() => deviceFingerprint(generateDeviceIdentity().privateKey)), "key-invalid");
    assert.equal(reasonOf(() => importDevicePrivateKey("not a key")), "key-invalid");
  });

  it("refuses malformed public key encodings", () => {
    const encoded = exportDevicePublicKey(generateDeviceIdentity().publicKey);
    for (const bad of ["", encoded.slice(1), `${encoded}=`, `${encoded.slice(0, 42)}+`, Buffer.alloc(33).toString("base64url")]) {
      assert.equal(isDevicePublicKey(bad), false, bad);
      assert.equal(reasonOf(() => importDevicePublicKey(bad)), "key-invalid");
    }
    // The last character must not carry stray bits: "A" and "B" decode to the same bytes.
    const zero = Buffer.alloc(32).toString("base64url");
    assert.equal(isDevicePublicKey(`${zero.slice(0, 42)}B`), false);
    assert.equal(isDevicePublicKey(42), false);
  });
});
