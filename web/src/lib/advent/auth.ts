import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "__Host-openadminos-advent";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export const TOKEN_MS = 15 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const DIGEST = /^[A-Za-z0-9_-]{43}$/;

function signature(purpose: string, value: string, secret: string) {
  return createHmac("sha256", secret).update(`${purpose}:${value}`).digest("base64url");
}

function matchesSignature(value: string, expected: string) {
  return DIGEST.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

export function signSession(participantId: string, now: number, secret: string) {
  const payload = `${participantId}.${Math.floor(now / 1000) + SESSION_SECONDS}`;
  return `${payload}.${signature("advent-session", payload, secret)}`;
}

export function verifySession(value: string, now: number, secret: string) {
  const [participantId, expires, mac, extra] = value.split(".");
  if (!participantId || !UUID.test(participantId) || !expires || !/^\d{1,12}$/.test(expires)
    || !mac || extra !== undefined || Number(expires) * 1000 <= now) return null;
  return matchesSignature(mac, signature("advent-session", `${participantId}.${expires}`, secret))
    ? participantId
    : null;
}

function tokenHash(token: string) {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

export function createLoginToken(now: number, secret: string) {
  const token = randomBytes(32).toString("base64url");
  return {
    linkToken: `${token}.${signature("advent-login", token, secret)}`,
    hash: tokenHash(token),
    expiresAt: new Date(now + TOKEN_MS).toISOString(),
  };
}

export async function redeemLoginToken<T>(
  linkToken: string, now: number, secret: string,
  consume: (hash: string, timestamp: string) => Promise<T>,
) {
  const [token, mac, extra] = linkToken.split(".");
  if (!token || !DIGEST.test(token) || !mac || extra !== undefined
    || !matchesSignature(mac, signature("advent-login", token, secret))) return null;
  return consume(tokenHash(token), new Date(now).toISOString());
}
