import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import { PairingError } from "./errors.js";
import { exportDevicePublicKey, generateDeviceIdentity } from "./identity.js";
import { isSignatureDomain, sign, SIGNATURE_DOMAINS, signedMessage, verify, type SignatureDomain } from "./signatures.js";

const identity = generateDeviceIdentity();
const payload = { b: [1, "two", { d: null, c: true }], a: "x" };

describe("domain-separated signatures", () => {
  it("signs canonical JSON after the domain", () => {
    assert.equal(signedMessage("openadminos.audit.checkpoint.v1", payload).toString("utf8"), 'openadminos.audit.checkpoint.v1\n{"a":"x","b":[1,"two",{"c":true,"d":null}]}');
    const signature = sign("openadminos.pairing.record.v1", payload, identity.privateKey);
    assert.equal(signature.length, 86);
    assert.ok(verify("openadminos.pairing.record.v1", payload, signature, identity.publicKey));
    assert.ok(verify("openadminos.pairing.record.v1", payload, signature, exportDevicePublicKey(identity.publicKey)));
  });

  it("ignores key order, because the payload is canonical", () => {
    const signature = sign("openadminos.schedule.assignment.v1", payload, identity.privateKey);
    const reordered = { a: "x", b: [1, "two", { c: true, d: null }] };
    assert.ok(verify("openadminos.schedule.assignment.v1", reordered, signature, identity.publicKey));
  });

  it("does not verify in another domain", () => {
    for (const domain of SIGNATURE_DOMAINS) {
      const signature = sign(domain, payload, identity.privateKey);
      for (const other of SIGNATURE_DOMAINS) {
        assert.equal(verify(other, payload, signature, identity.publicKey), other === domain, `${domain} as ${other}`);
      }
    }
  });

  it("does not verify a changed payload, another key or a changed signature", () => {
    const signature = sign("openadminos.audit.checkpoint.v1", payload, identity.privateKey);
    assert.equal(verify("openadminos.audit.checkpoint.v1", { ...payload, a: "y" }, signature, identity.publicKey), false);
    assert.equal(verify("openadminos.audit.checkpoint.v1", { ...payload, extra: 1 }, signature, identity.publicKey), false);
    assert.equal(verify("openadminos.audit.checkpoint.v1", payload, signature, generateDeviceIdentity().publicKey), false);
    const bytes = Buffer.from(signature, "base64url");
    bytes[10] = (bytes[10] as number) ^ 0x01;
    assert.equal(verify("openadminos.audit.checkpoint.v1", payload, bytes.toString("base64url"), identity.publicKey), false);
  });

  it("returns false for malformed input instead of throwing", () => {
    const signature = sign("openadminos.audit.checkpoint.v1", payload, identity.privateKey);
    assert.equal(verify("openadminos.audit.checkpoint.v2" as SignatureDomain, payload, signature, identity.publicKey), false);
    for (const bad of ["", signature.slice(1), `${signature}=`, `${signature.slice(0, 85)}+`, 12, null]) {
      assert.equal(verify("openadminos.audit.checkpoint.v1", payload, bad, identity.publicKey), false);
    }
    assert.equal(verify("openadminos.audit.checkpoint.v1", payload, signature, "not a key"), false);
    assert.equal(verify("openadminos.audit.checkpoint.v1", payload, signature, identity.privateKey), false);
    assert.equal(verify("openadminos.audit.checkpoint.v1", payload, signature, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey), false);
    assert.equal(verify("openadminos.audit.checkpoint.v1", { a: Number.NaN }, signature, identity.publicKey), false);
  });

  it("refuses to sign anything but plain JSON with an Ed25519 key in a known domain", () => {
    const reasonOf = (action: () => unknown): string => {
      try {
        action();
      } catch (error) {
        assert.ok(error instanceof PairingError);
        return error.reason;
      }
      return "accepted";
    };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [{ a: undefined }, { a: Number.POSITIVE_INFINITY }, { a: new Date(0) }, { a: 1n }, cyclic, () => 1]) {
      assert.equal(reasonOf(() => sign("openadminos.pairing.record.v1", bad, identity.privateKey)), "payload-invalid");
    }
    assert.equal(reasonOf(() => sign("openadminos.other.v1" as SignatureDomain, payload, identity.privateKey)), "payload-invalid");
    assert.equal(reasonOf(() => sign("openadminos.pairing.record.v1", payload, identity.publicKey)), "key-invalid");
    assert.equal(reasonOf(() => sign("openadminos.pairing.record.v1", payload, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey)), "key-invalid");
    // A shared sub-object is not a cycle.
    const shared = { x: 1 };
    assert.equal(reasonOf(() => sign("openadminos.pairing.record.v1", { a: shared, b: shared }, identity.privateKey)), "accepted");
  });

  it("knows exactly the three domains", () => {
    assert.deepEqual([...SIGNATURE_DOMAINS], ["openadminos.pairing.record.v1", "openadminos.audit.checkpoint.v1", "openadminos.schedule.assignment.v1"]);
    assert.equal(isSignatureDomain("openadminos.pairing.transcript.v1"), false);
  });
});
