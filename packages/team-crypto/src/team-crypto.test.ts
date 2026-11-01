import assert from "node:assert/strict";
import { createHash, createPublicKey, sign, verify } from "node:crypto";
import { describe, it } from "node:test";
import {
  canonicalJson, CertificateChainError, createTeam, DecryptionError, deviceFingerprint, exportDeviceKeys,
  FormatError, generateDeviceKeys, generateRecoveryKit, importDeviceKeys, importRecoveryKit, InvalidKeyError,
  issueDeviceCertificate, issueRecoveryDeviceCertificate, NotRecipientError, openPayload, RecoveryKitError,
  RevokedDeviceError, sealPayload, SignatureVerificationError, signRevocationList, StaleRevocationListError,
  TeamCryptoError, verifyDeviceChain, verifyRevocationList,
  type DeviceCertificate, type DeviceCertificateClaims, type DeviceKeys, type DeviceChainTrust,
  type PayloadEnvelope, type PayloadHeader,
} from "./index.js";

const issuedAt = "2026-11-01T10:00:00.000Z";
const later = "2026-11-01T11:00:00.000Z";

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function flip(encoded: string): string {
  const buffer = Buffer.from(encoded, "base64url");
  buffer[0] = buffer[0]! ^ 1;
  return buffer.toString("base64url");
}

function claims(keys: DeviceKeys, deviceId: string, issuerDeviceId = "root", role: "admin" | "member" = "member"): DeviceCertificateClaims {
  return {
    v: 1, teamId: "team", deviceId, memberId: `member-${deviceId}`, role, issuedAt,
    issuerDeviceId, issuerType: "device", encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey,
  };
}

function fixture() {
  const rootKeys = generateDeviceKeys();
  const team = createTeam({ teamId: "team", deviceId: "root", memberId: "owner", issuedAt }, rootKeys);
  const adminKeys = generateDeviceKeys();
  const admin = issueDeviceCertificate(claims(adminKeys, "admin", "root", "admin"), rootKeys);
  const memberKeys = generateDeviceKeys();
  const member = issueDeviceCertificate(claims(memberKeys, "member", "admin"), adminKeys);
  const trust: DeviceChainTrust = {
    root: team.root, pinnedRootSigningPublicKey: rootKeys.signingPublicKey,
    certificates: [team.rootCertificate, admin, member], revocationList: team.revocationList, lastAcceptedRevocationVersion: 0,
  };
  const header: PayloadHeader = { v: 1, payloadId: "payload-1", teamId: "team", kind: "approval", senderDeviceId: "root", createdAt: issuedAt };
  return { rootKeys, team, adminKeys, admin, memberKeys, member, trust, header };
}

function resignEnvelope(value: PayloadEnvelope, keys: DeviceKeys): PayloadEnvelope {
  const { signature: _, ...body } = value;
  return { ...body, signature: sign(null, Buffer.from(`openadminos-team/v1/payload-envelope\0${canonicalJson(body)}`), keys.signingPrivateKey).toString("base64url") };
}

describe("device keys", () => {
  it("uses independent X25519 and Ed25519 pairs and round trips PKCS8", () => {
    const keys = generateDeviceKeys();
    const serialized = exportDeviceKeys(keys);
    assert.equal(keys.encryptionPrivateKey.asymmetricKeyType, "x25519");
    assert.equal(keys.signingPrivateKey.asymmetricKeyType, "ed25519");
    assert.equal(Buffer.from(serialized.encryptionPublicKey, "base64url").length, 32);
    assert.equal(Buffer.from(serialized.signingPublicKey, "base64url").length, 32);
    assert.notEqual(serialized.encryptionPublicKey, serialized.signingPublicKey);
    assert.deepEqual(exportDeviceKeys(importDeviceKeys(roundTrip(serialized))), serialized);
    const message = Buffer.from("round trip");
    assert.ok(verify(null, message, createPublicKey(keys.signingPrivateKey), sign(null, message, importDeviceKeys(serialized).signingPrivateKey)));
  });

  it("rejects mismatched, malformed, wrong-algorithm, trailing and unversioned keys", () => {
    const keys = exportDeviceKeys(generateDeviceKeys());
    const other = exportDeviceKeys(generateDeviceKeys());
    assert.throws(() => importDeviceKeys({ ...keys, signingPublicKey: other.signingPublicKey }), InvalidKeyError);
    assert.throws(() => importDeviceKeys({ ...keys, encryptionPrivateKey: keys.signingPrivateKey }), InvalidKeyError);
    assert.throws(() => importDeviceKeys({ ...keys, signingPrivateKey: "bad" }), TeamCryptoError);
    const trailing = Buffer.concat([Buffer.from(keys.signingPrivateKey, "base64url"), Buffer.from([0])]).toString("base64url");
    assert.throws(() => importDeviceKeys({ ...keys, signingPrivateKey: trailing }), InvalidKeyError);
    assert.throws(() => importDeviceKeys({ ...keys, v: 2 } as never), FormatError);
    assert.throws(() => importDeviceKeys({ ...keys, signingPublicKey: `${keys.signingPublicKey}=` }), FormatError);
  });

  it("fingerprints both public keys with stable, readable groups", () => {
    const keys = generateDeviceKeys();
    const other = generateDeviceKeys();
    const fingerprint = deviceFingerprint(keys);
    assert.match(fingerprint, /^(?:[A-F0-9]{4}-){7}[A-F0-9]{4}$/);
    assert.equal(deviceFingerprint(importDeviceKeys(exportDeviceKeys(keys))), fingerprint);
    assert.notEqual(deviceFingerprint({ ...keys, encryptionPublicKey: other.encryptionPublicKey }), fingerprint);
    assert.notEqual(deviceFingerprint({ ...keys, signingPublicKey: other.signingPublicKey }), fingerprint);
    const body = { v: 1, encryptionPublicKey: keys.encryptionPublicKey, signingPublicKey: keys.signingPublicKey };
    assert.equal(fingerprint.replaceAll("-", "").toLowerCase(), createHash("sha256").update(`openadminos-team/v1/device-fingerprint\0${canonicalJson(body)}`).digest("hex").slice(0, 32));
  });
});

describe("certificates and revocations", () => {
  it("round trips team creation and verifies a multilevel chain in any input order", () => {
    const f = fixture();
    const team = roundTrip(f.team);
    assert.equal(team.v, 1);
    assert.deepEqual(importRecoveryKit(team.recoveryKit.code), team.recoveryKit);
    const trust = roundTrip({ ...f.trust, certificates: [f.member, f.admin, team.rootCertificate] });
    assert.deepEqual(verifyDeviceChain(roundTrip(f.member), trust).map((c) => c.deviceId), ["member", "admin", "root"]);
    assert.deepEqual(verifyDeviceChain(team.rootCertificate, trust), [team.rootCertificate]);
    assert.deepEqual(verifyRevocationList(team.revocationList, trust), team.revocationList);
  });

  for (const revokedId of ["member", "admin", "root"]) {
    it(`rejects a chain containing revoked ${revokedId}`, () => {
      const f = fixture();
      const revocationList = signRevocationList({ v: 1, teamId: "team", version: 1, revokedDeviceIds: [revokedId], issuedAt: later, issuerDeviceId: "admin" }, f.adminKeys);
      assert.throws(() => verifyDeviceChain(f.member, { ...f.trust, revocationList }), RevokedDeviceError);
    });
  }

  it("rejects a certificate issued by a member", () => {
    const f = fixture();
    const injected = issueDeviceCertificate(claims(generateDeviceKeys(), "injected", "member"), f.memberKeys);
    assert.throws(() => verifyDeviceChain(injected, f.trust), /not an admin/);
  });

  it("rejects an unknown issuer and an injected signing key impersonating a known issuer", () => {
    const f = fixture();
    const attacker = generateDeviceKeys();
    const unknown = issueDeviceCertificate(claims(attacker, "injected", "unknown", "admin"), attacker);
    assert.throws(() => verifyDeviceChain(unknown, f.trust), CertificateChainError);
    const forged = issueDeviceCertificate(claims(attacker, "injected", "root", "admin"), attacker);
    assert.throws(() => verifyDeviceChain(forged, f.trust), SignatureVerificationError);
    const substituted = issueDeviceCertificate(claims(attacker, "admin", "root", "admin"), attacker);
    const leaf = issueDeviceCertificate(claims(generateDeviceKeys(), "leaf", "admin"), attacker);
    assert.throws(() => verifyDeviceChain(leaf, { ...f.trust, certificates: [f.team.rootCertificate, substituted] }), SignatureVerificationError);
    const selfSigned = issueDeviceCertificate(claims(attacker, "injected", "injected", "admin"), attacker);
    assert.throws(() => verifyDeviceChain(selfSigned, f.trust), /cycle/);
  });

  it("rejects a forged root pin, substituted recovery key and tampered root signature", () => {
    const f = fixture();
    assert.throws(() => verifyDeviceChain(f.member, { ...f.trust, pinnedRootSigningPublicKey: generateDeviceKeys().signingPublicKey }), CertificateChainError);
    assert.throws(() => verifyDeviceChain(f.member, { ...f.trust, root: { ...f.team.root, recoverySigningPublicKey: generateRecoveryKit().signingPublicKey } }), SignatureVerificationError);
    assert.throws(() => verifyDeviceChain(f.member, { ...f.trust, root: { ...f.team.root, signature: flip(f.team.root.signature) } }), SignatureVerificationError);
  });

  it("requires an admin root with the pinned key and a self-issued root certificate", () => {
    const f = fixture();
    for (const change of [{ role: "member" as const }, { issuerDeviceId: "admin" }, { signingPublicKey: f.adminKeys.signingPublicKey }]) {
      const root = { ...f.team.rootCertificate, ...change };
      assert.throws(() => verifyDeviceChain(root, { ...f.trust, certificates: [root, f.admin] }), CertificateChainError);
    }
  });

  for (const field of ["memberId", "role", "encryptionPublicKey", "signingPublicKey", "issuedAt", "signature"] as const) {
    it(`detects certificate ${field} tampering`, () => {
      const f = fixture();
      const tampered = { ...f.member };
      if (field === "role") tampered.role = "admin";
      else if (field === "issuedAt") tampered.issuedAt = later;
      else if (field === "memberId") tampered.memberId = "different-member";
      else tampered[field] = flip(tampered[field]);
      assert.throws(() => verifyDeviceChain(tampered, { ...f.trust, certificates: [f.team.rootCertificate, f.admin] }), SignatureVerificationError);
    });
  }

  it("rejects cross-team, duplicate, conflicting and cyclic certificates", () => {
    const f = fixture();
    assert.throws(() => verifyDeviceChain({ ...f.member, teamId: "another-team" }, f.trust), CertificateChainError);
    assert.throws(() => verifyDeviceChain(f.member, { ...f.trust, certificates: [f.admin, f.admin] }), CertificateChainError);
    assert.throws(() => verifyDeviceChain({ ...f.member, memberId: "other" }, f.trust), /conflicts/);
    const aKeys = generateDeviceKeys();
    const bKeys = generateDeviceKeys();
    const a = issueDeviceCertificate(claims(aKeys, "a", "b", "admin"), bKeys);
    const b = issueDeviceCertificate(claims(bKeys, "b", "a", "admin"), aKeys);
    assert.throws(() => verifyDeviceChain(a, { ...f.trust, certificates: [...f.trust.certificates, a, b] }), /cycle/);
  });

  it("rejects stale lists and accepts identical versions for idempotent verification", () => {
    const f = fixture();
    const revocationList = signRevocationList({ v: 1, teamId: "team", version: 2, revokedDeviceIds: [], issuedAt: later, issuerDeviceId: "admin" }, f.adminKeys);
    assert.deepEqual(verifyRevocationList(roundTrip(revocationList), { ...f.trust, lastAcceptedRevocationVersion: 2 }), revocationList);
    assert.throws(() => verifyRevocationList(revocationList, { ...f.trust, lastAcceptedRevocationVersion: 3 }), StaleRevocationListError);
    assert.throws(() => verifyDeviceChain(f.member, { ...f.trust, lastAcceptedRevocationVersion: 1 }), StaleRevocationListError);
  });

  it("sorts revocations without mutating input and rejects duplicate or invalid versions", () => {
    const f = fixture();
    const body = { v: 1 as const, teamId: "team", version: 1, revokedDeviceIds: ["z", "a"], issuedAt: later, issuerDeviceId: "root" };
    const list = signRevocationList(body, f.rootKeys);
    assert.deepEqual(list.revokedDeviceIds, ["a", "z"]);
    assert.deepEqual(body.revokedDeviceIds, ["z", "a"]);
    for (const version of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => signRevocationList({ ...body, version }, f.rootKeys), FormatError);
    assert.throws(() => signRevocationList({ ...body, revokedDeviceIds: ["a", "a"] }, f.rootKeys), FormatError);
  });

  it("rejects tampered, wrong-team, unknown and member-signed revocation lists", () => {
    const f = fixture();
    for (const change of [{ version: 5 }, { revokedDeviceIds: ["admin"] }, { issuedAt: later }, { signature: flip(f.team.revocationList.signature) }]) {
      assert.throws(() => verifyRevocationList({ ...f.team.revocationList, ...change }, f.trust), TeamCryptoError);
    }
    assert.throws(() => verifyRevocationList({ ...f.team.revocationList, teamId: "other" }, f.trust), CertificateChainError);
    const memberList = signRevocationList({ v: 1, teamId: "team", version: 1, revokedDeviceIds: [], issuedAt: later, issuerDeviceId: "member" }, f.memberKeys);
    assert.throws(() => verifyRevocationList(memberList, f.trust), CertificateChainError);
    assert.throws(() => verifyRevocationList({ ...memberList, issuerDeviceId: "unknown" }, f.trust), CertificateChainError);
    const { signature: _, ...body } = memberList;
    const forged = signRevocationList({ ...body, issuerDeviceId: "root" }, f.memberKeys);
    assert.throws(() => verifyRevocationList(forged, f.trust), SignatureVerificationError);
  });

  it("rejects unsupported versions, unknown fields, malformed encodings and timestamps", () => {
    const f = fixture();
    for (const certificate of [
      { ...f.member, v: 2 }, { ...f.member, extra: "unsigned" }, { ...f.member, encryptionPublicKey: "AA" },
      { ...f.member, issuedAt: "2026-11-01" }, { ...f.member, role: "owner" }, { ...f.member, issuerType: "server" },
    ]) assert.throws(() => verifyDeviceChain(certificate as DeviceCertificate, f.trust), FormatError);
  });
});

describe("recovery", () => {
  it("produces a grouped code with 256 bits of entropy and imports it deterministically", () => {
    const kit = generateRecoveryKit();
    assert.match(kit.code, /^(?:[A-Z2-7]{4}-){14}[A-Z2-7]{2}$/);
    assert.deepEqual(importRecoveryKit(kit.code), kit);
    assert.deepEqual(importRecoveryKit(kit.code.toLowerCase().replaceAll("-", " \n")), kit);
    assert.notEqual(generateRecoveryKit().code, kit.code);
  });

  it("detects every single-character substitution, truncation and padding-bit typo", () => {
    const kit = generateRecoveryKit();
    const raw = kit.code.replaceAll("-", "");
    for (let i = 0; i < raw.length; i++) {
      const replacement = raw[i] === "A" ? "B" : "A";
      assert.throws(() => importRecoveryKit(raw.slice(0, i) + replacement + raw.slice(i + 1)), RecoveryKitError);
    }
    assert.throws(() => importRecoveryKit(raw.slice(1)), RecoveryKitError);
    assert.throws(() => importRecoveryKit(`0${raw.slice(1)}`), RecoveryKitError);
  });

  it("enrolls a new admin and verifies descendants after all former admin devices are revoked", () => {
    const f = fixture();
    const newKeys = generateDeviceKeys();
    const { issuerDeviceId: _, issuerType: __, ...body } = claims(newKeys, "recovered", "root", "admin");
    const recovered = issueRecoveryDeviceCertificate(body, roundTrip(f.team.recoveryKit), f.team.root);
    const revocationList = signRevocationList({ v: 1, teamId: "team", version: 3, revokedDeviceIds: ["admin", "root"], issuedAt: later, issuerDeviceId: "recovered" }, newKeys);
    const trust = { ...f.trust, certificates: [roundTrip(recovered)], revocationList };
    assert.deepEqual(verifyDeviceChain(roundTrip(recovered), trust), [recovered]);
    assert.throws(() => verifyDeviceChain({ ...recovered, role: "member" }, { ...trust, certificates: [f.team.rootCertificate], revocationList: f.team.revocationList }), CertificateChainError);
    const leaf = issueDeviceCertificate(claims(generateDeviceKeys(), "leaf", "recovered"), newKeys);
    assert.deepEqual(verifyDeviceChain(leaf, trust).map((c) => c.deviceId), ["leaf", "recovered"]);
    const revoked = signRevocationList({ v: 1, teamId: "team", version: 4, revokedDeviceIds: ["recovered"], issuedAt: later, issuerDeviceId: "root" }, f.rootKeys);
    assert.throws(() => verifyDeviceChain(recovered, { ...f.trust, certificates: [...f.trust.certificates, recovered], revocationList: revoked }), RevokedDeviceError);
  });

  it("rejects a different kit, mismatched kit public key and recovery-enrolled members", () => {
    const f = fixture();
    const { issuerDeviceId: _, issuerType: __, ...body } = claims(generateDeviceKeys(), "recovered", "root", "admin");
    assert.throws(() => issueRecoveryDeviceCertificate(body, generateRecoveryKit(), f.team.root), RecoveryKitError);
    assert.throws(() => issueRecoveryDeviceCertificate(body, { ...f.team.recoveryKit, code: generateRecoveryKit().code }, f.team.root), RecoveryKitError);
    assert.throws(() => issueRecoveryDeviceCertificate({ ...body, role: "member" }, f.team.recoveryKit, f.team.root), CertificateChainError);
    assert.throws(() => issueRecoveryDeviceCertificate({ ...body, teamId: "other" }, f.team.recoveryKit, f.team.root), CertificateChainError);
    assert.throws(() => issueRecoveryDeviceCertificate({ ...body, deviceId: "root" }, f.team.recoveryKit, f.team.root), CertificateChainError);
  });
});

describe("payload envelopes", () => {
  it("round trips binary and empty plaintext to all recipients, with sorted IDs", () => {
    const f = fixture();
    for (const plaintext of [Buffer.alloc(0), Buffer.from([0, 255, 128, 1]), Buffer.from("Approval for 雪"), Buffer.alloc(128 * 1024, 42)]) {
      const header = roundTrip(f.header);
      const envelope = sealPayload(plaintext, header, f.rootKeys, [f.member, f.admin, f.team.rootCertificate]);
      assert.deepEqual(envelope.recipientDeviceIds, ["admin", "member", "root"]);
      assert.deepEqual(openPayload(roundTrip(envelope), f.team.rootCertificate, "admin", importDeviceKeys(roundTrip(exportDeviceKeys(f.adminKeys)))), plaintext);
      assert.deepEqual(openPayload(envelope, f.team.rootCertificate, "member", f.memberKeys), plaintext);
      assert.deepEqual(openPayload(envelope, f.team.rootCertificate, "root", f.rootKeys), plaintext);
      header.kind = "mutated-after-seal";
      assert.equal(envelope.header.kind, "approval");
    }
  });

  it("uses fresh content keys, ephemeral keys, nonces and signatures for identical inputs", () => {
    const f = fixture();
    const a = sealPayload(Buffer.from("same"), f.header, f.rootKeys, [f.member]);
    const b = sealPayload(Buffer.from("same"), f.header, f.rootKeys, [f.member]);
    for (const field of ["nonce", "ciphertext", "ephemeralPublicKey", "signature"] as const) assert.notEqual(a[field], b[field]);
    assert.notEqual(a.wrappedKeys[0]!.ciphertext, b.wrappedKeys[0]!.ciphertext);
    assert.notEqual(a.wrappedKeys[0]!.nonce, b.wrappedKeys[0]!.nonce);
  });

  const attacks: [string, (e: PayloadEnvelope) => void][] = [
    ["header payload ID", (e) => { e.header.payloadId = "different"; }],
    ["header kind", (e) => { e.header.kind = "audit"; }],
    ["header timestamp", (e) => { e.header.createdAt = later; }],
    ["recipient list", (e) => { e.recipientDeviceIds[0] = "another"; e.wrappedKeys[0]!.deviceId = "another"; }],
    ["recipient omission", (e) => { e.recipientDeviceIds.pop(); e.wrappedKeys.pop(); }],
    ["ciphertext", (e) => { e.ciphertext = flip(e.ciphertext); }],
    ["nonce", (e) => { e.nonce = flip(e.nonce); }],
    ["authentication tag", (e) => { e.tag = flip(e.tag); }],
    ["wrapped key", (e) => { e.wrappedKeys[0]!.ciphertext = flip(e.wrappedKeys[0]!.ciphertext); }],
    ["wrapped key nonce", (e) => { e.wrappedKeys[0]!.nonce = flip(e.wrappedKeys[0]!.nonce); }],
    ["wrapped key tag", (e) => { e.wrappedKeys[0]!.tag = flip(e.wrappedKeys[0]!.tag); }],
    ["ephemeral key", (e) => { e.ephemeralPublicKey = flip(e.ephemeralPublicKey); }],
    ["signature", (e) => { e.signature = flip(e.signature); }],
  ];
  for (const [label, attack] of attacks) {
    it(`rejects ${label} tampering before trying recipient keys`, () => {
      const f = fixture();
      const envelope = roundTrip(sealPayload(Buffer.from("secret"), f.header, f.rootKeys, [f.admin, f.member]));
      attack(envelope);
      assert.throws(() => openPayload(envelope, f.team.rootCertificate, "outsider", generateDeviceKeys()), SignatureVerificationError);
    });
  }

  it("rejects non-recipients, wrong keys and sender identity substitution with typed errors", () => {
    const f = fixture();
    const envelope = sealPayload(Buffer.from("secret"), f.header, f.rootKeys, [f.member]);
    assert.throws(() => openPayload(envelope, f.team.rootCertificate, "admin", f.adminKeys), NotRecipientError);
    assert.throws(() => openPayload(envelope, f.team.rootCertificate, "member", f.adminKeys), DecryptionError);
    assert.throws(() => openPayload(envelope, f.admin, "member", f.memberKeys), CertificateChainError);
    assert.throws(() => openPayload(envelope, { ...f.team.rootCertificate, signingPublicKey: f.adminKeys.signingPublicKey }, "member", f.memberKeys), SignatureVerificationError);
    assert.throws(() => openPayload({ ...envelope, header: { ...envelope.header, teamId: "other" } }, f.team.rootCertificate, "member", f.memberKeys), CertificateChainError);
    assert.throws(() => openPayload({ ...envelope, header: { ...envelope.header, senderDeviceId: "admin" } }, f.team.rootCertificate, "member", f.memberKeys), CertificateChainError);
  });

  it("authenticates payload and key-wrap AAD even when a malicious sender re-signs changes", () => {
    const f = fixture();
    for (const attack of [
      (e: PayloadEnvelope) => { e.header.payloadId = "replayed-id"; },
      (e: PayloadEnvelope) => { e.recipientDeviceIds.pop(); e.wrappedKeys.pop(); },
      (e: PayloadEnvelope) => { e.ciphertext = flip(e.ciphertext); },
      (e: PayloadEnvelope) => { e.tag = flip(e.tag); },
      (e: PayloadEnvelope) => { e.wrappedKeys[0]!.ciphertext = flip(e.wrappedKeys[0]!.ciphertext); },
      (e: PayloadEnvelope) => { e.ephemeralPublicKey = Buffer.alloc(32).toString("base64url"); },
    ]) {
      const envelope = sealPayload(Buffer.from("secret"), f.header, f.rootKeys, [f.admin, f.member]);
      attack(envelope);
      assert.throws(() => openPayload(resignEnvelope(envelope, f.rootKeys), f.team.rootCertificate, "admin", f.adminKeys), DecryptionError);
    }
  });

  it("rejects empty, duplicate, wrong-team and invalid encryption recipients", () => {
    const f = fixture();
    const seal = (recipients: DeviceCertificate[]) => sealPayload(Buffer.from("secret"), f.header, f.rootKeys, recipients);
    assert.throws(() => seal([]), FormatError);
    assert.throws(() => seal([f.member, f.member]), FormatError);
    assert.throws(() => seal([{ ...f.member, teamId: "other" }]), CertificateChainError);
    assert.throws(() => seal([{ ...f.member, encryptionPublicKey: Buffer.alloc(32).toString("base64url") }]), InvalidKeyError);
  });

  it("rejects unsupported versions, malformed schemas, recipient order and base64url", () => {
    const f = fixture();
    const envelope = sealPayload(Buffer.from("secret"), f.header, f.rootKeys, [f.admin, f.member]);
    for (const change of [
      { v: 2 }, { extra: true }, { nonce: "AA" }, { tag: "AA" }, { signature: "AA" },
      { ciphertext: `${envelope.ciphertext}=` }, { wrappedKeys: [] }, { recipientDeviceIds: ["member", "admin"] },
      { header: { ...envelope.header, v: 2 } }, { wrappedKeys: envelope.wrappedKeys.map((w) => ({ ...w, v: 2 })) },
    ]) assert.throws(() => openPayload({ ...envelope, ...change } as PayloadEnvelope, f.team.rootCertificate, "member", f.memberKeys), FormatError);
  });

  it("uses distinct signature domains for certificates, roots, revocations and envelopes", () => {
    const f = fixture();
    const envelope = sealPayload(Buffer.from("secret"), f.header, f.rootKeys, [f.member]);
    const { signature: _, ...body } = envelope;
    const wrongDomain = sign(null, Buffer.from(`openadminos-team/v1/device-cert\0${canonicalJson(body)}`), f.rootKeys.signingPrivateKey).toString("base64url");
    assert.throws(() => openPayload({ ...envelope, signature: wrongDomain }, f.team.rootCertificate, "member", f.memberKeys), SignatureVerificationError);
    for (const [type, value] of [["device-cert", f.team.rootCertificate], ["team-root", f.team.root], ["revocation-list", f.team.revocationList], ["payload-envelope", envelope]] as const) {
      const { signature, ...unsigned } = value;
      const publicKey = createPublicKey(f.rootKeys.signingPrivateKey);
      assert.ok(verify(null, Buffer.from(`openadminos-team/v1/${type}\0${canonicalJson(unsigned)}`), publicKey, Buffer.from(signature, "base64url")));
      assert.equal(verify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(signature, "base64url")), false);
    }
  });
});
