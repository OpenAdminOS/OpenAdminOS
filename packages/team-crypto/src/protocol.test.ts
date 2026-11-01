import assert from "node:assert/strict";
import { createDecipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, verify } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalJson, createTeam, generateDeviceKeys, importRecoveryKit, issueDeviceCertificate, sealPayload } from "./index.js";

describe("wire interoperability", () => {
  it("opens an envelope using only independent node:crypto operations", () => {
    const sender = generateDeviceKeys();
    const recipient = generateDeviceKeys();
    const createdAt = "2026-11-01T10:00:00.000Z";
    const team = createTeam({ teamId: "t", deviceId: "s", memberId: "m", issuedAt: createdAt }, sender);
    const certificate = issueDeviceCertificate({
      v: 1, teamId: "t", deviceId: "r", memberId: "other", role: "member", issuedAt: createdAt,
      issuerDeviceId: "s", issuerType: "device", encryptionPublicKey: recipient.encryptionPublicKey, signingPublicKey: recipient.signingPublicKey,
    }, sender);
    const header = { v: 1 as const, payloadId: "p", teamId: "t", kind: "audit", senderDeviceId: "s", createdAt };
    const plaintext = Buffer.from("independent protocol check");
    const envelope = sealPayload(plaintext, header, sender, [certificate]);
    const { signature, ...body } = envelope;
    assert.ok(verify(null, Buffer.from(`openadminos-team/v1/payload-envelope\0${canonicalJson(body)}`), createPublicKey(sender.signingPrivateKey), Buffer.from(signature, "base64url")));
    const ephemeral = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: envelope.ephemeralPublicKey }, format: "jwk" });
    const shared = diffieHellman({ privateKey: recipient.encryptionPrivateKey, publicKey: ephemeral });
    const wrappingKey = Buffer.from(hkdfSync("sha256", shared,
      Buffer.concat([Buffer.from(envelope.ephemeralPublicKey, "base64url"), Buffer.from(recipient.encryptionPublicKey, "base64url")]),
      Buffer.from("openadminos-team/v1/content-key-wrap"), 32));
    const wrap = envelope.wrappedKeys[0]!;
    const unwrap = createDecipheriv("aes-256-gcm", wrappingKey, Buffer.from(wrap.nonce, "base64url"), { authTagLength: 16 });
    unwrap.setAuthTag(Buffer.from(wrap.tag, "base64url"));
    unwrap.setAAD(Buffer.from(`openadminos-team/v1/wrap-aad\0${canonicalJson({ v: 1, header, recipientDeviceIds: ["r"], ephemeralPublicKey: envelope.ephemeralPublicKey, recipientDeviceId: "r" })}`));
    const contentKey = Buffer.concat([unwrap.update(Buffer.from(wrap.ciphertext, "base64url")), unwrap.final()]);
    assert.equal(contentKey.length, 32);
    const decrypt = createDecipheriv("aes-256-gcm", contentKey, Buffer.from(envelope.nonce, "base64url"), { authTagLength: 16 });
    decrypt.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    decrypt.setAAD(Buffer.from(`openadminos-team/v1/payload-aad\0${canonicalJson({ v: 1, header, recipientDeviceIds: ["r"] })}`));
    assert.deepEqual(Buffer.concat([decrypt.update(Buffer.from(envelope.ciphertext, "base64url")), decrypt.final()]), plaintext);
    assert.equal(team.root.signingPublicKey, sender.signingPublicKey);
  });

  it("derives the recovery signing public key from the documented seed and PKCS8 format", () => {
    const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    const checksum = createHash("sha256").update("openadminos-team/v1/recovery/checksum\0").update(secret).digest().subarray(0, 4);
    // Independent bit-string encoder, separate from the package's accumulator implementation.
    const bits = [...Buffer.concat([secret, checksum])].map((byte) => byte.toString(2).padStart(8, "0")).join("");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let code = "";
    for (let i = 0; i < bits.length; i += 5) code += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
    const seed = Buffer.from(hkdfSync("sha256", secret, Buffer.from("openadminos-team/v1/recovery/salt"), Buffer.from("openadminos-team/v1/recovery/ed25519"), 32));
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
    assert.equal(importRecoveryKit(code).signingPublicKey, createPublicKey(key).export({ format: "jwk" }).x);
  });
});
