import { strict as assert } from "node:assert";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import { LICENCE_PUBLIC_KEY_PEM, LICENCE_SIGNING_CONTEXT, entitlementAt, verifyLicence, type LicenceCheck } from "./licence.js";
import { DAY_SECONDS, FIXED_NOW, licencePayload, signLicence, testKeyPair } from "./test-support.js";

const keys = testKeyPair();
const nowSeconds = Math.floor(FIXED_NOW / 1000);

function check(token: string | undefined, now = FIXED_NOW, publicKey: string = keys.publicKeyPem): LicenceCheck {
  return verifyLicence(token, { publicKey, now });
}

function reasonOf(result: LicenceCheck): string {
  return result.ok ? "ok" : result.reason;
}

describe("verifyLicence", () => {
  it("accepts a valid licence and returns a frozen entitlement", () => {
    const result = check(signLicence(licencePayload(), keys.privateKey));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.entitlement, {
      state: "active",
      licenseeId: "org-contoso",
      features: ["approvals", "audit-forwarding"],
      notBefore: (nowSeconds - 30 * DAY_SECONDS) * 1000,
      expiresAt: (nowSeconds + 30 * DAY_SECONDS) * 1000,
      graceEndsAt: (nowSeconds + 44 * DAY_SECONDS) * 1000,
    });
    assert.ok(Object.isFrozen(result.entitlement));
    assert.ok(Object.isFrozen(result.entitlement.features));
  });

  it("accepts a KeyObject as the public key", () => {
    const result = verifyLicence(signLicence(licencePayload(), keys.privateKey), { publicKey: keys.publicKey, now: FIXED_NOW });
    assert.equal(reasonOf(result), "ok");
  });

  it("refuses a licence that is not valid yet", () => {
    const token = signLicence(licencePayload({ notBefore: nowSeconds + 60, expiresAt: nowSeconds + 30 * DAY_SECONDS }), keys.privateKey);
    const result = check(token);
    assert.equal(reasonOf(result), "not-yet-valid");
    assert.equal(reasonOf(check(token, (nowSeconds + 60) * 1000)), "ok");
  });

  it("honours the grace period after expiry", () => {
    const token = signLicence(licencePayload({ expiresAt: nowSeconds - 3 * DAY_SECONDS, graceSeconds: 7 * DAY_SECONDS }), keys.privateKey);
    const result = check(token);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.entitlement.state, "grace");
  });

  it("treats the expiry instant as the start of the grace period", () => {
    const token = signLicence(licencePayload({ expiresAt: nowSeconds, graceSeconds: DAY_SECONDS }), keys.privateKey);
    const result = check(token);
    assert.ok(result.ok && result.entitlement.state === "grace");
    assert.equal(reasonOf(check(token, FIXED_NOW - 1)), "ok");
    const before = check(token, FIXED_NOW - 1);
    assert.ok(before.ok && before.entitlement.state === "active");
  });

  it("refuses a licence whose grace period ended", () => {
    const token = signLicence(licencePayload({ expiresAt: nowSeconds - 10 * DAY_SECONDS, graceSeconds: 7 * DAY_SECONDS }), keys.privateKey);
    assert.equal(reasonOf(check(token)), "expired");
    const atEnd = signLicence(licencePayload({ expiresAt: nowSeconds - DAY_SECONDS, graceSeconds: DAY_SECONDS }), keys.privateKey);
    assert.equal(reasonOf(check(atEnd)), "expired");
  });

  it("refuses an expired licence without a grace period", () => {
    const token = signLicence(licencePayload({ expiresAt: nowSeconds - 1, graceSeconds: 0 }), keys.privateKey);
    assert.equal(reasonOf(check(token)), "expired");
  });

  it("refuses a tampered payload", () => {
    const token = signLicence(licencePayload(), keys.privateKey);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify(licencePayload({ expiresAt: nowSeconds + 3650 * DAY_SECONDS })), "utf8").toString("base64url");
    assert.equal(reasonOf(check(`${forged}.${signature}`)), "signature");
  });

  it("refuses a tampered signature", () => {
    const token = signLicence(licencePayload(), keys.privateKey);
    const [payload, signature = ""] = token.split(".");
    const bytes = Buffer.from(signature, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    assert.equal(reasonOf(check(`${payload}.${bytes.toString("base64url")}`)), "signature");
  });

  it("refuses a licence signed with another key", () => {
    const other = testKeyPair();
    assert.equal(reasonOf(check(signLicence(licencePayload(), other.privateKey))), "signature");
  });

  it("refuses every test licence with the placeholder key built into the app", () => {
    const result = verifyLicence(signLicence(licencePayload(), keys.privateKey), { now: FIXED_NOW });
    assert.equal(reasonOf(result), "signature");
    assert.match(LICENCE_PUBLIC_KEY_PEM, /^-----BEGIN PUBLIC KEY-----/);
  });

  it("refuses a public key that is not Ed25519", () => {
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    assert.equal(reasonOf(check(signLicence(licencePayload(), keys.privateKey), FIXED_NOW, rsa)), "signature");
    assert.equal(reasonOf(check(signLicence(licencePayload(), keys.privateKey), FIXED_NOW, "not a key")), "signature");
  });

  it("reports a missing licence", () => {
    assert.equal(reasonOf(check(undefined)), "missing");
    assert.equal(reasonOf(check("")), "missing");
    assert.equal(reasonOf(check("  \n")), "missing");
  });

  it("refuses malformed tokens", () => {
    const valid = signLicence(licencePayload(), keys.privateKey);
    const [payload = "", signature = ""] = valid.split(".");
    const cases = [
      "no-dot-here",
      `${payload}.${signature}.extra`,
      `${payload}.`,
      `.${signature}`,
      `${payload}.${signature.slice(0, 20)}`,
      `${payload}.${signature}=`,
      `${payload}+.${signature}`,
      "a".repeat(5000),
    ];
    for (const token of cases) {
      assert.equal(reasonOf(check(token)), "malformed", token.slice(0, 40));
    }
  });

  it("refuses signed payloads with invalid contents", () => {
    const payloads: unknown[] = [
      "not an object",
      [],
      null,
      licencePayload({ v: 2 }),
      licencePayload({ licenseeId: "" }),
      licencePayload({ licenseeId: "has spaces" }),
      licencePayload({ licenseeId: 7 }),
      licencePayload({ features: "approvals" }),
      licencePayload({ features: ["Approvals"] }),
      licencePayload({ features: ["approvals", "approvals"] }),
      licencePayload({ features: Array.from({ length: 65 }, (_, i) => `f${i}`) }),
      licencePayload({ notBefore: "yesterday" }),
      licencePayload({ notBefore: 1.5 }),
      licencePayload({ expiresAt: nowSeconds - 40 * DAY_SECONDS }),
      licencePayload({ expiresAt: 1e20 }),
      licencePayload({ graceSeconds: -1 }),
      licencePayload({ graceSeconds: 400 * DAY_SECONDS }),
      licencePayload({ graceSeconds: undefined }),
    ];
    for (const payload of payloads) {
      assert.equal(reasonOf(check(signLicence(payload, keys.privateKey))), "malformed", JSON.stringify(payload)?.slice(0, 80));
    }
    const notJson = Buffer.from("{not json", "utf8").toString("base64url");
    const signature = sign(null, Buffer.from(`${LICENCE_SIGNING_CONTEXT}${notJson}`, "utf8"), keys.privateKey).toString("base64url");
    assert.equal(reasonOf(check(`${notJson}.${signature}`)), "malformed");
  });

  it("ignores unknown payload fields", () => {
    assert.equal(reasonOf(check(signLicence(licencePayload({ seats: 10 }), keys.privateKey))), "ok");
  });

  it("works with no network access at all", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network used");
    }) as typeof fetch;
    try {
      assert.equal(reasonOf(check(signLicence(licencePayload(), keys.privateKey))), "ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("entitlementAt", () => {
  it("moves from active to grace to expired as the clock advances", () => {
    const token = signLicence(licencePayload({ expiresAt: nowSeconds + DAY_SECONDS, graceSeconds: DAY_SECONDS }), keys.privateKey);
    const result = check(token);
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(entitlementAt(result.entitlement, FIXED_NOW).state, "active");
    assert.equal(entitlementAt(result.entitlement, FIXED_NOW + DAY_SECONDS * 1000).state, "grace");
    assert.equal(entitlementAt(result.entitlement, FIXED_NOW + 2 * DAY_SECONDS * 1000).state, "expired");
    assert.ok(Object.isFrozen(entitlementAt(result.entitlement, FIXED_NOW + DAY_SECONDS * 1000)));
  });
});
