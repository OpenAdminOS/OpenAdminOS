import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { connect, createServer } from "node:tls";

import { createTlsCertificate, isTlsSpkiPin, matchesTlsSpkiPin, tlsSpkiSha256 } from "./certificate.js";
import { objectIdentifier, sequence, smallInteger, time, unsignedInteger } from "./der.js";
import { PairingError } from "./errors.js";

const NOW = new Date("2026-11-14T12:00:00.500Z");

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PairingError);
    return error.reason;
  }
  return "accepted";
}

describe("DER encoder", () => {
  it("encodes integers, object identifiers, times and long lengths", () => {
    assert.equal(smallInteger(2).toString("hex"), "020102");
    assert.equal(unsignedInteger(Buffer.from([0, 0, 0x80])).toString("hex"), "02020080");
    assert.equal(unsignedInteger(Buffer.from([0])).toString("hex"), "020100");
    assert.equal(objectIdentifier("1.2.840.10045.4.3.2").toString("hex"), "06082a8648ce3d040302");
    assert.equal(time(new Date("2026-11-14T12:00:00Z")).toString("ascii", 2), "261114120000Z");
    assert.equal(time(new Date("2050-01-01T00:00:00Z")).toString("hex").slice(0, 4), "180f");
    const long = sequence(Buffer.alloc(300));
    assert.equal(long.subarray(0, 4).toString("hex"), "3082012c");
  });
});

describe("createTlsCertificate", () => {
  it("parses with X509Certificate, verifies its own signature and matches its key", () => {
    const created = createTlsCertificate({ commonName: "openadminos-sandbox", dnsNames: ["Sandbox.Local"], ipAddresses: ["100.64.0.1", "fd7a:115c:a1e0::1", "::ffff:192.0.2.1"], now: NOW });
    const certificate = new X509Certificate(created.certificatePem);
    assert.equal(certificate.subject, "CN=openadminos-sandbox");
    assert.equal(certificate.issuer, "CN=openadminos-sandbox");
    assert.ok(certificate.verify(certificate.publicKey));
    assert.ok(certificate.checkPrivateKey(createPrivateKey(created.privateKeyPem)));
    assert.equal(certificate.ca, false);
    assert.equal(certificate.publicKey.asymmetricKeyType, "ec");
    assert.equal(certificate.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
    assert.equal(certificate.subjectAltName, "DNS:sandbox.local, IP Address:100.64.0.1, IP Address:FD7A:115C:A1E0:0:0:0:0:1, IP Address:0:0:0:0:0:FFFF:C000:201");
    assert.equal(certificate.validFromDate.toISOString(), "2026-11-14T11:55:00.000Z");
    assert.equal(certificate.validToDate.toISOString(), "2027-11-14T12:00:00.000Z");
    assert.equal(certificate.serialNumber.length, 32);
    assert.equal(created.spkiSha256, tlsSpkiSha256(certificate));
  });

  it("marks basicConstraints and keyUsage critical, with digitalSignature only", () => {
    const der = new X509Certificate(createTlsCertificate({ commonName: "a", now: NOW }).certificatePem).raw.toString("hex");
    assert.ok(der.includes("300c0603551d130101ff04023000"), "basicConstraints critical, CA false");
    assert.ok(der.includes("300e0603551d0f0101ff040403020780"), "keyUsage critical, digitalSignature");
    assert.ok(der.includes("301d0603551d250416301406082b0601050507030106082b06010505070302"), "extendedKeyUsage serverAuth and clientAuth");
    assert.ok(!der.includes("0603551d11"), "no subjectAltName without names");
  });

  it("detects a tampered certificate", () => {
    const certificate = new X509Certificate(createTlsCertificate({ commonName: "openadminos-sandbox", now: NOW }).certificatePem);
    const raw = Buffer.from(certificate.raw);
    // Flip one byte of the common name inside the signed part.
    const index = raw.indexOf(Buffer.from("openadminos-sandbox"));
    raw[index] = (raw[index] as number) ^ 0x01;
    const tampered = new X509Certificate(raw);
    assert.equal(tampered.verify(tampered.publicKey), false);
    const other = createTlsCertificate({ commonName: "openadminos-sandbox", now: NOW });
    assert.equal(certificate.checkPrivateKey(createPrivateKey(other.privateKeyPem)), false);
  });

  it("is accepted by node:tls on both sides with the pins as the only trust", async () => {
    const created = createTlsCertificate({ commonName: "openadminos-sandbox", ipAddresses: ["127.0.0.1"], now: new Date() });
    const client = createTlsCertificate({ commonName: "openadminos-desktop", now: new Date() });
    let clientPin = "";
    const server = createServer(
      { cert: created.certificatePem, key: created.privateKeyPem, minVersion: "TLSv1.3", requestCert: true, rejectUnauthorized: false },
      (socket) => {
        const peer = socket.getPeerX509Certificate();
        clientPin = peer ? tlsSpkiSha256(peer) : "";
        socket.end("ok");
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const received = await new Promise<string>((resolve, reject) => {
        const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.3", cert: client.certificatePem, key: client.privateKeyPem }, () => {
          if (!matchesTlsSpkiPin(socket.getPeerX509Certificate() as X509Certificate, created.spkiSha256)) {
            socket.destroy();
            reject(new Error("pin mismatch"));
          }
        });
        let data = "";
        socket.on("data", (chunk) => { data += chunk.toString(); });
        socket.on("end", () => resolve(data));
        socket.on("error", reject);
      });
      assert.equal(received, "ok");
      assert.equal(clientPin, client.spkiSha256, "the client certificate works for clientAuth");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keeps the SPKI pin when reissued with the same private key", () => {
    const first = createTlsCertificate({ commonName: "openadminos-sandbox", now: NOW });
    const reissued = createTlsCertificate({ commonName: "openadminos-sandbox", privateKey: first.privateKeyPem, now: new Date("2027-11-01T00:00:00Z") });
    assert.equal(reissued.spkiSha256, first.spkiSha256);
    assert.notEqual(reissued.certificatePem, first.certificatePem);
    const certificate = new X509Certificate(reissued.certificatePem);
    assert.ok(certificate.verify(certificate.publicKey));
    assert.ok(certificate.checkPrivateKey(createPrivateKey(first.privateKeyPem)));
    const fromKeyObject = createTlsCertificate({ commonName: "a", privateKey: createPrivateKey(first.privateKeyPem), now: NOW });
    assert.equal(fromKeyObject.spkiSha256, first.spkiSha256);
  });

  it("refuses an existing key that is not a P-256 private key", () => {
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", privateKey: "not a key" })), "key-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", privateKey: generateKeyPairSync("ed25519").privateKey })), "key-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", privateKey: generateKeyPairSync("ec", { namedCurve: "secp384r1" }).privateKey })), "key-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", privateKey: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey })), "key-invalid");
  });

  it("refuses options out of range", () => {
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "" })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "x".repeat(65) })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a\nb" })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", validityDays: 0 })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", validityDays: 1.5 })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", now: new Date(Number.NaN) })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", dnsNames: ["*.example.com"] })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", dnsNames: ["bad_name"] })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", ipAddresses: ["300.1.1.1"] })), "certificate-options-invalid");
    assert.equal(reasonOf(() => createTlsCertificate({ commonName: "a", ipAddresses: ["fe80::1%en0"] })), "certificate-options-invalid");
  });
});

describe("SPKI pin", () => {
  it("is the same from the PEM, the certificate and the public key", () => {
    const created = createTlsCertificate({ commonName: "a", now: NOW });
    const certificate = new X509Certificate(created.certificatePem);
    assert.ok(isTlsSpkiPin(created.spkiSha256));
    assert.equal(tlsSpkiSha256(created.certificatePem), created.spkiSha256);
    assert.equal(tlsSpkiSha256(certificate.publicKey), created.spkiSha256);
    assert.ok(matchesTlsSpkiPin(created.certificatePem, created.spkiSha256));
  });

  it("does not match another key or a malformed pin", () => {
    const created = createTlsCertificate({ commonName: "a", now: NOW });
    const other = createTlsCertificate({ commonName: "a", now: NOW });
    assert.equal(matchesTlsSpkiPin(created.certificatePem, other.spkiSha256), false);
    assert.equal(matchesTlsSpkiPin(created.certificatePem, created.spkiSha256.toUpperCase()), false);
    assert.equal(matchesTlsSpkiPin(created.certificatePem, created.spkiSha256.slice(1)), false);
    assert.equal(matchesTlsSpkiPin("not a certificate", created.spkiSha256), false);
    assert.equal(isTlsSpkiPin("zz"), false);
    assert.equal(reasonOf(() => tlsSpkiSha256("not a certificate")), "key-invalid");
    assert.equal(reasonOf(() => tlsSpkiSha256(generateKeyPairSync("ed25519").privateKey)), "key-invalid");
  });
});
