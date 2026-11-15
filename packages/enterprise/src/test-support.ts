// Test helpers only. The app never signs licences; the team service does.

import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import { LICENCE_SIGNING_CONTEXT } from "./licence.js";

export interface TestKeyPair {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
}

export function testKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

/** 2026-11-14T12:00:00Z, the fixed clock the tests use. */
export const FIXED_NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
export const DAY_SECONDS = 24 * 60 * 60;

export function licencePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowSeconds = Math.floor(FIXED_NOW / 1000);
  return {
    v: 1,
    licenseeId: "org-contoso",
    features: ["approvals", "audit-forwarding"],
    notBefore: nowSeconds - 30 * DAY_SECONDS,
    expiresAt: nowSeconds + 30 * DAY_SECONDS,
    graceSeconds: 14 * DAY_SECONDS,
    ...overrides,
  };
}

export function signLicence(payload: unknown, privateKey: KeyObject): string {
  const segment = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = sign(null, Buffer.from(LICENCE_SIGNING_CONTEXT + segment, "utf8"), privateKey);
  return `${segment}.${signature.toString("base64url")}`;
}
