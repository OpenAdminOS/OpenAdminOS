import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createTlsCertificate } from "./certificate.js";
import {
  createPairingCode,
  createPairingProof,
  formatPairingCode,
  PairingAttemptLimiter,
  pairingCodeFingerprint,
  pairingCodeMatchesSpki,
  pairingTranscript,
  parsePairingCode,
  verifyPairingProof,
  type PairingCode,
  type PairingTranscriptFields,
} from "./code.js";
import { PairingError } from "./errors.js";
import { exportDevicePublicKey, generateDeviceIdentity } from "./identity.js";

const PIN = createTlsCertificate({ commonName: "openadminos-sandbox" }).spkiSha256;
const OTHER_PIN = createTlsCertificate({ commonName: "openadminos-sandbox" }).spkiSha256;
const SANDBOX_KEY = exportDevicePublicKey(generateDeviceIdentity().publicKey);
const DESKTOP_KEY = exportDevicePublicKey(generateDeviceIdentity().publicKey);

function fields(overrides: Partial<PairingTranscriptFields> = {}): PairingTranscriptFields {
  return {
    pairingId: "pairing-1",
    organizationId: "org-1",
    tenantId: "11111111-2222-3333-4444-555555555555",
    sandboxPublicKey: SANDBOX_KEY,
    desktopPublicKey: DESKTOP_KEY,
    tlsSpkiSha256: PIN,
    ...overrides,
  };
}

function parsed(input: string): PairingCode {
  const result = parsePairingCode(input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.code;
}

describe("pairing code", () => {
  it("is 12 characters of the SPKI pin and 8 random ones", () => {
    const code = createPairingCode(PIN);
    assert.match(code.code, /^[0-9A-HJKMNP-TV-Z]{20}$/);
    assert.equal(code.fingerprint, pairingCodeFingerprint(PIN));
    assert.equal(code.code, `${code.fingerprint}${code.secret}`);
    assert.notEqual(createPairingCode(PIN).secret, code.secret);
    assert.ok(pairingCodeMatchesSpki(code, PIN));
    assert.equal(pairingCodeMatchesSpki(code, OTHER_PIN), false);
    assert.throws(() => pairingCodeFingerprint(PIN.toUpperCase()), PairingError);
  });

  it("formats in groups and parses typed input back", () => {
    const code = createPairingCode(PIN);
    const shown = formatPairingCode(code);
    assert.match(shown, /^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
    assert.deepEqual(parsed(shown), code);
    assert.deepEqual(parsed(` ${shown.toLowerCase().replace(/-/g, " ")} `), code);
    const aliased = code.code.replace(/0/g, "O").replace(/1/g, "l");
    assert.deepEqual(parsed(aliased), code);
  });

  it("refuses malformed codes with a named failure", () => {
    for (const input of ["", "ABCDE", "A".repeat(21), "UUUUU-UUUUU-UUUUU-UUUUU", "ABCDE_FGHJK_MNPQR_STVWX", "x".repeat(65), 42, null]) {
      const result = parsePairingCode(input);
      assert.equal(result.ok, false, String(input));
      if (!result.ok) assert.equal(result.failure, "code-malformed");
    }
  });

  it("does not match a pin that is malformed", () => {
    const code = createPairingCode(PIN);
    assert.equal(pairingCodeMatchesSpki(code, "nope"), false);
    assert.equal(pairingCodeMatchesSpki({ ...code, fingerprint: code.fingerprint.slice(1) }, PIN), false);
  });
});

describe("pairing proof", () => {
  it("verifies for the same code, role and transcript", () => {
    const code = createPairingCode(PIN);
    const proof = createPairingProof(code, "desktop", fields());
    assert.equal(proof.length, 43);
    assert.ok(verifyPairingProof(code, "desktop", fields(), proof));
    // The typed code, read back, verifies the same proof.
    assert.ok(verifyPairingProof(parsed(formatPairingCode(code).toLowerCase()), "desktop", fields(), proof));
  });

  it("fails for another secret, the other role or any changed field", () => {
    const code = createPairingCode(PIN);
    const proof = createPairingProof(code, "desktop", fields());
    assert.equal(verifyPairingProof(createPairingCode(PIN), "desktop", fields(), proof), false);
    assert.equal(verifyPairingProof(code, "sandbox", fields(), proof), false);
    const changes: Partial<PairingTranscriptFields>[] = [
      { pairingId: "pairing-2" },
      { organizationId: "org-2" },
      { tenantId: "11111111-2222-3333-4444-555555555556" },
      { sandboxPublicKey: exportDevicePublicKey(generateDeviceIdentity().publicKey) },
      { desktopPublicKey: exportDevicePublicKey(generateDeviceIdentity().publicKey) },
      { tlsSpkiSha256: OTHER_PIN },
      { sandboxPublicKey: DESKTOP_KEY, desktopPublicKey: SANDBOX_KEY },
    ];
    for (const change of changes) {
      assert.equal(verifyPairingProof(code, "desktop", fields(change), proof), false, JSON.stringify(change));
    }
  });

  it("fails closed on a tampered or malformed proof", () => {
    const code = createPairingCode(PIN);
    const proof = createPairingProof(code, "sandbox", fields());
    const flipped = `${proof[0] === "A" ? "B" : "A"}${proof.slice(1)}`;
    assert.equal(verifyPairingProof(code, "sandbox", fields(), flipped), false);
    for (const bad of ["", proof.slice(1), `${proof}=`, 7, undefined]) {
      assert.equal(verifyPairingProof(code, "sandbox", fields(), bad), false);
    }
    assert.equal(verifyPairingProof({ ...code, secret: "short" }, "sandbox", fields(), proof), false);
    assert.equal(verifyPairingProof(code, "sandbox", fields({ tenantId: "11111111-2222-3333-4444-55555555555A" }), proof), false);
  });

  it("separates the transcript by domain and refuses fields out of shape", () => {
    const transcript = pairingTranscript("desktop", fields()).toString("utf8");
    assert.ok(transcript.startsWith("openadminos.pairing.transcript.v1\n{"));
    assert.ok(transcript.includes('"role":"desktop"'));
    const reasonOf = (change: Partial<PairingTranscriptFields>): string => {
      try {
        pairingTranscript("desktop", fields(change));
      } catch (error) {
        assert.ok(error instanceof PairingError);
        return error.reason;
      }
      return "accepted";
    };
    assert.equal(reasonOf({ pairingId: "" }), "payload-invalid");
    assert.equal(reasonOf({ organizationId: " org" }), "payload-invalid");
    assert.equal(reasonOf({ tenantId: "not-a-tenant" }), "payload-invalid");
    assert.equal(reasonOf({ sandboxPublicKey: "abc" }), "payload-invalid");
    assert.equal(reasonOf({ desktopPublicKey: SANDBOX_KEY }), "payload-invalid");
    assert.equal(reasonOf({ tlsSpkiSha256: "00" }), "payload-invalid");
    assert.throws(() => pairingTranscript("admin" as "desktop", fields()), PairingError);
  });
});

describe("PairingAttemptLimiter", () => {
  it("allows five attempts per code", () => {
    let now = 1_000;
    const limiter = new PairingAttemptLimiter({ issuedAt: now, now: () => now });
    for (let index = 4; index >= 0; index -= 1) {
      assert.deepEqual(limiter.attempt(), { ok: true, remaining: index });
      now += 1_000;
    }
    const sixth = limiter.attempt();
    assert.equal(sixth.ok, false);
    if (!sixth.ok) assert.equal(sixth.failure, "code-attempts-exhausted");
    assert.equal(limiter.remaining, 0);
  });

  it("expires 10 minutes after the code is shown", () => {
    let now = 5_000;
    const limiter = new PairingAttemptLimiter({ issuedAt: 5_000, now: () => now });
    now = 5_000 + 10 * 60_000 - 1;
    assert.equal(limiter.attempt().ok, true);
    now = 5_000 + 10 * 60_000;
    const expired = limiter.attempt();
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.failure, "code-expired");
    assert.equal(limiter.expiresAt, 605_000);
  });

  it("treats a clock that moved back as expired", () => {
    const limiter = new PairingAttemptLimiter({ issuedAt: 10_000, now: () => 9_999 });
    const result = limiter.attempt();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failure, "code-expired");
  });

  it("refuses every attempt after a success", () => {
    const limiter = new PairingAttemptLimiter({ issuedAt: 0, now: () => 1 });
    assert.equal(limiter.attempt().ok, true);
    limiter.succeed();
    const again = limiter.attempt();
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.failure, "code-used");
    assert.equal(limiter.remaining, 0);
  });

  it("refuses options out of range", () => {
    assert.throws(() => new PairingAttemptLimiter({ issuedAt: Number.NaN }), PairingError);
    assert.throws(() => new PairingAttemptLimiter({ issuedAt: 0, maxAttempts: 0 }), PairingError);
    assert.throws(() => new PairingAttemptLimiter({ issuedAt: 0, lifetimeMs: 0 }), PairingError);
  });
});
