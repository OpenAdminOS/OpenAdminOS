import assert from "node:assert/strict";
import { createHmac, scryptSync } from "node:crypto";
import { describe, it } from "node:test";

import { createTlsCertificate } from "./certificate.js";
import {
  createPairingCode,
  DesktopPairingSession,
  formatPairingCode,
  PairingAttemptLimiter,
  pairingCodeFingerprint,
  pairingCodeMatchesSpki,
  pairingTranscript,
  parsePairingCode,
  SandboxPairingSession,
  type DesktopPairingOffer,
  type PairingCode,
  type PairingTranscriptFields,
  type SandboxPairingSessionOptions,
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

function offer(overrides: Partial<DesktopPairingOffer> = {}): DesktopPairingOffer {
  const { organizationId, tenantId, desktopPublicKey } = fields();
  return { organizationId, tenantId, desktopPublicKey, ...overrides };
}

function sandboxOptions(code: PairingCode, clock: { now: number }, overrides: Partial<SandboxPairingSessionOptions> = {}): SandboxPairingSessionOptions {
  const { organizationId, tenantId } = fields();
  return { code, pairingId: "pairing-1", sandboxPublicKey: SANDBOX_KEY, tlsSpkiSha256: PIN, organizationId, tenantId, issuedAt: 0, now: () => clock.now, ...overrides };
}

function sandboxSession(code: PairingCode, clock: { now: number } = { now: 0 }, overrides: Partial<SandboxPairingSessionOptions> = {}): Promise<SandboxPairingSession> {
  return SandboxPairingSession.create(sandboxOptions(code, clock, overrides));
}

async function assertRejects(promise: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof PairingError && error.reason === reason);
}

function parsed(input: string): PairingCode {
  const result = parsePairingCode(input);
  assert.ok(result.ok, JSON.stringify(result));
  return result.code;
}

function reasonOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof PairingError);
    return error.reason;
  }
  return "accepted";
}

describe("pairing code", () => {
  it("is 16 characters of the SPKI pin and 12 random ones", () => {
    const code = createPairingCode(PIN);
    assert.match(code.code, /^[0-9A-HJKMNP-TV-Z]{28}$/);
    assert.equal(code.fingerprint.length, 16);
    assert.equal(code.secret.length, 12);
    assert.equal(code.fingerprint, pairingCodeFingerprint(PIN));
    assert.equal(code.code, `${code.fingerprint}${code.secret}`);
    assert.notEqual(createPairingCode(PIN).secret, code.secret);
    assert.ok(pairingCodeMatchesSpki(code, PIN));
    assert.equal(pairingCodeMatchesSpki(code, OTHER_PIN), false);
    assert.throws(() => pairingCodeFingerprint(PIN.toUpperCase()), PairingError);
  });

  it("formats in groups of four and parses typed input back", () => {
    const code = createPairingCode(PIN);
    const shown = formatPairingCode(code);
    assert.match(shown, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){6}$/);
    assert.deepEqual(parsed(shown), code);
    assert.deepEqual(parsed(code.code.toLowerCase()), code);
    assert.deepEqual(parsed(` ${shown.toLowerCase().replace(/-/g, " ")} `), code);
    const aliased = code.code.replace(/0/g, "O").replace(/1/g, "l");
    assert.deepEqual(parsed(aliased), code);
  });

  it("refuses malformed codes with a named failure", () => {
    const code = createPairingCode(PIN).code;
    for (const input of ["", "ABCDE", code.slice(1), `${code}A`, "U".repeat(28), code.replace(/^(.{4})/, "$1_"), "x".repeat(65), 42, null]) {
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

describe("pairing transcript", () => {
  it("is separated by domain and names the role", () => {
    const transcript = pairingTranscript("desktop", fields()).toString("utf8");
    assert.ok(transcript.startsWith("openadminos.pairing.transcript.v1\n{"));
    assert.ok(transcript.includes('"role":"desktop"'));
    assert.notDeepEqual(pairingTranscript("sandbox", fields()), pairingTranscript("desktop", fields()));
  });

  it("refuses fields out of shape", () => {
    const of = (change: Partial<PairingTranscriptFields>): string => reasonOf(() => pairingTranscript("desktop", fields(change)));
    assert.equal(of({ pairingId: "" }), "payload-invalid");
    assert.equal(of({ organizationId: " org" }), "payload-invalid");
    assert.equal(of({ tenantId: "not-a-tenant" }), "payload-invalid");
    assert.equal(of({ sandboxPublicKey: "abc" }), "payload-invalid");
    assert.equal(of({ desktopPublicKey: SANDBOX_KEY }), "payload-invalid");
    assert.equal(of({ tlsSpkiSha256: "00" }), "payload-invalid");
    assert.equal(reasonOf(() => pairingTranscript("admin" as "desktop", fields())), "payload-invalid");
  });
});

describe("pairing proofs", () => {
  it("run desktop first, then sandbox, and both verify", async () => {
    const code = createPairingCode(PIN);
    // The admin types the code on the desktop.
    const desktop = await DesktopPairingSession.create(parsed(formatPairingCode(code).toLowerCase()), fields());
    const sandbox = await sandboxSession(code);
    const desktopProof = desktop.desktopProof();
    assert.equal(desktopProof.length, 43);
    const result = sandbox.verifyDesktopProof(offer(), desktopProof);
    assert.ok(result.ok, JSON.stringify(result));
    assert.deepEqual(result.fields, fields());
    assert.ok(desktop.verifySandboxProof(sandbox.sandboxProof()));
    // The proofs differ by role, so one cannot be sent back as the other.
    assert.notEqual(sandbox.sandboxProof(), desktopProof);
    assert.equal(desktop.verifySandboxProof(desktopProof), false);
  });

  it("keys the HMAC with scrypt of the secret, salted with the domain, the pin and the pairing id", async () => {
    const code = createPairingCode(PIN);
    const salt = `openadminos.pairing.key.v1\n${PIN}\npairing-1`;
    const key = scryptSync(code.secret, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const expected = createHmac("sha256", key).update(pairingTranscript("desktop", fields())).digest("base64url");
    assert.equal((await DesktopPairingSession.create(code, fields())).desktopProof(), expected);
  });

  it("gives no sandbox proof before a desktop proof verified", async () => {
    const code = createPairingCode(PIN);
    const sandbox = await sandboxSession(code);
    assert.equal(reasonOf(() => sandbox.sandboxProof()), "proof-order");
    const failed = sandbox.verifyDesktopProof(offer(), (await DesktopPairingSession.create(createPairingCode(PIN), fields())).desktopProof());
    assert.equal(failed.ok ? "accepted" : failed.failure, "proof-invalid");
    assert.equal(reasonOf(() => sandbox.sandboxProof()), "proof-order");
  });

  it("lets the desktop check the sandbox only after it sent its own proof", async () => {
    const desktop = await DesktopPairingSession.create(createPairingCode(PIN), fields());
    assert.equal(reasonOf(() => desktop.verifySandboxProof("x".repeat(43))), "proof-order");
    desktop.desktopProof();
    assert.equal(desktop.verifySandboxProof("x".repeat(43)), false);
  });

  it("refuses sessions for a TLS key the code does not name or options out of shape", async () => {
    await assertRejects(DesktopPairingSession.create(createPairingCode(PIN), fields({ tlsSpkiSha256: OTHER_PIN })), "fingerprint-mismatch");
    await assertRejects(DesktopPairingSession.create(createPairingCode(PIN), fields({ tenantId: "x" })), "payload-invalid");
    await assertRejects(DesktopPairingSession.create({ ...createPairingCode(PIN), secret: "short" }, fields()), "payload-invalid");
    await assertRejects(sandboxSession(createPairingCode(OTHER_PIN)), "fingerprint-mismatch");
    await assertRejects(sandboxSession(createPairingCode(PIN), { now: 0 }, { tenantId: "TENANT" }), "payload-invalid");
    await assertRejects(sandboxSession(createPairingCode(PIN), { now: 0 }, { organizationId: "" }), "payload-invalid");
  });

  it("refuses a desktop for another organization or tenant before any sandbox proof, as an attempt", async () => {
    const code = createPairingCode(PIN);
    const sandbox = await sandboxSession(code);
    const changes: Partial<DesktopPairingOffer>[] = [{ organizationId: "org-2" }, { tenantId: "11111111-2222-3333-4444-555555555556" }];
    for (const change of changes) {
      // The desktop computed a correct proof for its own organization and tenant.
      const desktopProof = (await DesktopPairingSession.create(code, fields(change))).desktopProof();
      const result = sandbox.verifyDesktopProof(offer(change), desktopProof);
      assert.equal(result.ok ? "accepted" : result.failure, "binding-mismatch", JSON.stringify(change));
    }
    assert.equal(sandbox.remaining, 3);
    assert.equal(reasonOf(() => sandbox.sandboxProof()), "proof-order");
  });

  it("fails the desktop proof for another secret or a changed transcript", async () => {
    const code = createPairingCode(PIN);
    const desktopProof = (await DesktopPairingSession.create(code, fields())).desktopProof();
    const otherKey = await sandboxSession(code);
    const swapped = otherKey.verifyDesktopProof(offer({ desktopPublicKey: exportDevicePublicKey(generateDeviceIdentity().publicKey) }), desktopProof);
    assert.equal(swapped.ok ? "accepted" : swapped.failure, "proof-invalid");
    // The sandbox's own fields are part of the transcript and the key: another pairing id fails.
    const otherPairing = (await DesktopPairingSession.create(code, fields({ pairingId: "pairing-2" }))).desktopProof();
    const result = (await sandboxSession(code)).verifyDesktopProof(offer(), otherPairing);
    assert.equal(result.ok ? "accepted" : result.failure, "proof-invalid");
    const wrongCode = (await DesktopPairingSession.create(createPairingCode(PIN), fields())).desktopProof();
    const wrong = (await sandboxSession(code)).verifyDesktopProof(offer(), wrongCode);
    assert.equal(wrong.ok ? "accepted" : wrong.failure, "proof-invalid");
  });

  it("fails closed on a tampered or malformed proof and counts each try", async () => {
    const code = createPairingCode(PIN);
    const desktopProof = (await DesktopPairingSession.create(code, fields())).desktopProof();
    const flipped = `${desktopProof[0] === "A" ? "B" : "A"}${desktopProof.slice(1)}`;
    const sandbox = await sandboxSession(code);
    const remaining: number[] = [];
    for (const bad of [flipped, desktopProof.slice(1), 7, undefined]) {
      const result = sandbox.verifyDesktopProof(offer(), bad);
      assert.equal(result.ok ? "accepted" : result.failure, "proof-invalid");
      if (!result.ok) remaining.push(result.remaining);
    }
    assert.deepEqual(remaining, [4, 3, 2, 1]);
    const malformed = sandbox.verifyDesktopProof(offer({ tenantId: "TENANT" }), desktopProof);
    assert.equal(malformed.ok ? "accepted" : malformed.failure, "transcript-invalid");
    // Five tries used: even the right proof is refused now, and no sandbox proof is given.
    const exhausted = sandbox.verifyDesktopProof(offer(), desktopProof);
    assert.equal(exhausted.ok ? "accepted" : exhausted.failure, "code-attempts-exhausted");
    assert.equal(reasonOf(() => sandbox.sandboxProof()), "proof-order");
  });

  it("refuses an expired code and a code that already paired", async () => {
    const code = createPairingCode(PIN);
    const desktopProof = (await DesktopPairingSession.create(code, fields())).desktopProof();
    const clock = { now: 10 * 60_000 };
    const expired = (await sandboxSession(code, clock)).verifyDesktopProof(offer(), desktopProof);
    assert.equal(expired.ok ? "accepted" : expired.failure, "code-expired");
    clock.now = 1;
    const sandbox = await sandboxSession(code, clock);
    assert.ok(sandbox.verifyDesktopProof(offer(), desktopProof).ok);
    const again = sandbox.verifyDesktopProof(offer(), desktopProof);
    assert.equal(again.ok ? "accepted" : again.failure, "code-used");
    assert.equal(sandbox.remaining, 0);
  });

  it("cannot loosen the protocol limits", async () => {
    const code = createPairingCode(PIN);
    const clock = { now: 0 };
    const sandbox = await SandboxPairingSession.create({ ...sandboxOptions(code, clock), maxAttempts: 50, lifetimeMs: 24 * 60 * 60_000 });
    assert.equal(sandbox.remaining, 5);
    clock.now = 10 * 60_000;
    const late = sandbox.verifyDesktopProof(offer(), "x".repeat(43));
    assert.equal(late.ok ? "accepted" : late.failure, "code-expired");
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

  it("clamps overrides to the protocol limits but allows tighter ones", () => {
    let now = 0;
    const loose = new PairingAttemptLimiter({ issuedAt: 0, now: () => now, maxAttempts: 99, lifetimeMs: 60 * 60_000 });
    assert.equal(loose.remaining, 5);
    assert.equal(loose.expiresAt, 10 * 60_000);
    const tight = new PairingAttemptLimiter({ issuedAt: 0, now: () => now, maxAttempts: 2, lifetimeMs: 1_000 });
    assert.equal(tight.remaining, 2);
    now = 1_000;
    const result = tight.attempt();
    assert.equal(result.ok ? "accepted" : result.failure, "code-expired");
  });

  it("refuses options out of range", () => {
    assert.throws(() => new PairingAttemptLimiter({ issuedAt: Number.NaN }), PairingError);
    assert.throws(() => new PairingAttemptLimiter({ issuedAt: 0, maxAttempts: 0 }), PairingError);
    assert.throws(() => new PairingAttemptLimiter({ issuedAt: 0, lifetimeMs: 0 }), PairingError);
    for (const now of [0, "now", null, {}]) {
      assert.throws(
        () => new PairingAttemptLimiter({ issuedAt: 0, now: now as unknown as () => number }),
        (error) => error instanceof PairingError && error.reason === "payload-invalid",
        String(now),
      );
    }
  });
});
