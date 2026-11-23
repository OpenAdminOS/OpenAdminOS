import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";

import { hashAnswer, normalizeAnswer } from "./answers.ts";
import { createLoginToken, redeemLoginToken, SESSION_SECONDS, signSession, TOKEN_MS, verifySession } from "./auth.ts";
import { drawWinners, earnsBadge, eligibleList, grandEntries, hashEligibleList } from "./eligibility.ts";
import { clientIp } from "./client-ip.ts";
import { launchReadiness, requiresAnswer } from "./readiness.ts";
import { newReferralCode, parseReferral, validHandle } from "./identity.ts";
import { CAMPAIGN_CLOSE, campaignNow, doorState, doorUnlock, doorWindowEnd, isOnTime, parseDay } from "./time.ts";

const timestamp = (value: string) => Date.parse(value);

test("all 24 calendar doors use the Berlin UTC offset in December", () => {
  for (let day = 1; day <= 24; day++) {
    const unlock = timestamp(`2026-12-${String(day).padStart(2, "0")}T05:00:00Z`);
    assert.equal(doorUnlock(day), unlock);
    assert.equal(doorState(day, unlock - 1), "locked");
    assert.equal(doorState(day, unlock), "open");
    assert.equal(isOnTime(day, unlock - 1), false);
    assert.equal(isOnTime(day, unlock), true);
    assert.equal(isOnTime(day, doorWindowEnd(day) - 1), true);
    assert.equal(isOnTime(day, doorWindowEnd(day)), false);
    assert.equal(doorState(day, doorWindowEnd(day)), "open");
  }
  assert.equal(doorWindowEnd(24), timestamp("2026-12-25T05:00:00Z"));
});

test("all doors become read-only at midnight in Berlin on January 1", () => {
  assert.equal(CAMPAIGN_CLOSE, timestamp("2026-12-31T23:00:00.000Z"));
  assert.equal(doorState(1, timestamp("2026-12-31T23:59:59+01:00")), "open");
  assert.equal(doorState(24, CAMPAIGN_CLOSE - 1), "open");
  assert.equal(doorState(1, CAMPAIGN_CLOSE), "closed");
  assert.equal(doorState(24, CAMPAIGN_CLOSE), "closed");
});

test("only zoned development overrides replace the clock", () => {
  const override = "2026-12-01T06:00:00+01:00";
  assert.equal(campaignNow(override, "development"), timestamp("2026-12-01T05:00:00Z"));
  const before = Date.now();
  assert.ok(campaignNow(override, "production") >= before);
  assert.ok(campaignNow("2026-12-01T06:00:00", "development") >= before);
});

test("day numbers are canonical, in-range integers", () => {
  assert.equal(parseDay("1"), 1);
  assert.equal(parseDay("24"), 24);
  for (const value of ["0", "25", "01", "1.0", "1e1", "-1", " 7"]) assert.equal(parseDay(value), null);
});

test("normalization handles compatibility characters, whitespace, quotes and one final period", () => {
  assert.equal(normalizeAnswer("  “ＦＩＲＳＴ\u00a0   WORD.”\n "), "first word");
  assert.equal(normalizeAnswer("  \"Example\".  "), "example");
  assert.equal(normalizeAnswer("‘“Example.”’"), "example");
  assert.equal(normalizeAnswer("Example..."), "example..");
  assert.equal(normalizeAnswer("o’neill"), "o’neill");
  assert.equal(normalizeAnswer(" “ ” "), "");
});

test("accepted answers are keyed, normalized, and scoped to their door", () => {
  const pepper = "only-for-testing-a-peppered-answer";
  const expected = createHmac("sha256", pepper).update("7:sample answer").digest("hex");
  assert.equal(hashAnswer(7, "‘Sample answer.’", pepper), expected);
  assert.equal(hashAnswer(7, "SAMPLE   ANSWER", pepper), expected);
  assert.notEqual(hashAnswer(8, "sample answer", pepper), expected);
  assert.notEqual(hashAnswer(7, "sample answer", "a different pepper"), expected);
  assert.notEqual(createHash("sha256").update("7:sample answer").digest("hex"), expected);
  assert.equal(hashAnswer(7, "Sample answer...", pepper), createHmac("sha256", pepper).update("7:sample answer..").digest("hex"));
});

test("launch readiness counts only written doors with a question and accepted answers, plus the two special doors", () => {
  const allDoors = Array.from({ length: 24 }, (_, index) => {
    const day = index + 1;
    return { day, draft: false, question: requiresAnswer(day) ? "A question" : undefined };
  });
  const answers = allDoors.filter(({ day }) => requiresAnswer(day)).map(({ day }) => ({ day, answer_count: 1 }));
  const environment = {
    ADVENT_SUPABASE_URL: "https://example.test", ADVENT_SUPABASE_SERVICE_KEY: "fixture",
    ADVENT_SESSION_SECRET: "test-secret".repeat(4), ADVENT_ANSWER_PEPPER: "test-pepper".repeat(4),
    ADVENT_RESEND_API_KEY: "fixture", ADVENT_EMAIL_FROM: "sender@example.test", ADVENT_ADMIN_EMAILS: "admin@example.test",
    UPSTASH_REDIS_REST_URL: "https://redis.example.test", UPSTASH_REDIS_REST_TOKEN: "fixture", CRON_SECRET: "fixture",
    ADVENT_RULES_APPROVED: "true",
  };
  const ready = launchReadiness(allDoors, answers, environment);
  assert.equal(ready.completable, 24);
  assert.equal(ready.ready, true);
  const blocked = launchReadiness(
    allDoors.map((door) => door.day === 8 ? { ...door, question: "  ", draft: true } : door),
    answers.filter(({ day }) => day !== 9),
    { ...environment, ADVENT_RULES_APPROVED: "false", ADVENT_ANSWER_PEPPER: "short" },
  );
  assert.deepEqual(blocked, {
    completable: 22, missingQuestions: [8], missingAnswers: [9], draftDoors: [8],
    rulesUnapproved: true, missingEnv: ["ADVENT_ANSWER_PEPPER"], ready: false,
  });
});

test("rate-limit clients ignore caller-supplied IP headers outside Vercel", () => {
  const request = new Request("https://example.test", { headers: {
    "x-forwarded-for": "192.0.2.1", "x-real-ip": "192.0.2.2", "x-vercel-forwarded-for": "192.0.2.3, 192.0.2.4",
  } });
  assert.equal(clientIp(request, "0"), "unknown");
  assert.equal(clientIp(request, "1"), "192.0.2.3");
  assert.equal(clientIp(new Request("https://example.test", { headers: { "x-forwarded-for": "192.0.2.1" } }), "1"), "unknown");
});

test("badge and grand draw thresholds differ and referrals add at most five entries", () => {
  assert.equal(earnsBadge(11), false);
  assert.equal(earnsBadge(12), true);
  assert.equal(grandEntries(17, 10), 0);
  assert.equal(grandEntries(18, 0), 1);
  assert.equal(grandEntries(18, 4), 5);
  assert.equal(grandEntries(24, 20), 6);
  const rows = [{ id: "a", completed: 1, referrals: 10 }, { id: "b", completed: 0, referrals: 0 }, { id: "c", completed: 18, referrals: 1 }];
  assert.deepEqual(eligibleList(rows, "daily"), [{ id: "a", entries: 1 }, { id: "c", entries: 1 }]);
  assert.deepEqual(eligibleList(rows, "grand"), [{ id: "c", entries: 2 }]);
});

test("given the same eligible records and seed, the draw replays in prize order", () => {
  const candidates = [{ id: "c", entries: 1 }, { id: "a", entries: 3 }, { id: "b", entries: 6 }];
  const seed = Buffer.alloc(32, 29);
  const expected = ["c", "b", "a"];
  assert.deepEqual(drawWinners(candidates, seed, 3), expected);
  assert.deepEqual(drawWinners([...candidates].reverse(), seed, 3), expected);
  assert.deepEqual(drawWinners(candidates, seed, 1), expected.slice(0, 1));
  assert.deepEqual(drawWinners([{ id: "only", entries: 5 }], seed, 3), ["only"]);
  assert.deepEqual(drawWinners([], seed, 3), []);
  assert.equal(hashEligibleList(candidates), createHash("sha256").update("a,3\nb,6\nc,1\n").digest("hex"));
});

test("handles are lowercase, bounded, avoid edge hyphens and exclude reserved names", () => {
  for (const handle of ["abc", "0-0", "sample-admin", "a".repeat(24)]) assert.equal(validHandle(handle), true);
  for (const handle of ["ab", "a".repeat(25), "-abc", "abc-", "ab_c", "ABC", "abc\n", "admin", "support", "openadminos", "microsoft", "moderator"]) {
    assert.equal(validHandle(handle), false, handle);
  }
  const code = newReferralCode();
  assert.equal(code.length, 8);
  assert.equal(parseReferral(code.toLowerCase()), code);
  assert.equal(parseReferral("0O1I2345"), "");
});

const secret = "dedicated-test-secret-for-campaign-only";
const account = "01234567-abcd-4321-abcd-0123456789ab";
const issued = timestamp("2026-12-01T05:00:00Z");

test("sessions reject tampering, incorrect keys and exact expiry", () => {
  const session = signSession(account, 3, issued, secret);
  assert.deepEqual(verifySession(session, issued, secret), { id: account, version: 3 });
  assert.deepEqual(verifySession(session, issued + SESSION_SECONDS * 1000 - 1, secret), { id: account, version: 3 });
  assert.equal(verifySession(session, issued + SESSION_SECONDS * 1000, secret), null);
  assert.equal(verifySession(session, issued, "a different secret"), null);
  assert.equal(verifySession(session.replace(/^0/, "1"), issued, secret), null);
  assert.equal(verifySession(`${session}.extra`, issued, secret), null);
  assert.equal(verifySession(session.replace(/\.[a-z0-9_-]+$/i, ".bad"), issued, secret), null);
});

test("login links pass only the hashed nonce to atomic consumption, once and before expiry", async () => {
  const token = createLoginToken(issued, secret);
  const expired = createLoginToken(issued, secret);
  const records = new Map([token, expired].map(({ hash, expiresAt }) => [hash, { expiresAt, usedAt: "" }]));
  let calls = 0;
  const consume = async (hash: string, now: string) => {
    calls++;
    const row = records.get(hash);
    if (!row || row.usedAt || row.expiresAt <= now) return null;
    row.usedAt = now;
    return account;
  };
  const [nonce] = token.linkToken.split(".");
  assert.equal(Buffer.from(nonce!, "base64url").length, 32);
  assert.equal(token.hash, createHash("sha256").update(Buffer.from(nonce!, "base64url")).digest("hex"));
  assert.equal(token.expiresAt, new Date(issued + TOKEN_MS).toISOString());
  assert.equal(await redeemLoginToken(token.linkToken, issued, "a different secret", consume), null);
  assert.equal(await redeemLoginToken(`${token.linkToken}x`, issued, secret, consume), null);
  assert.equal(calls, 0);
  assert.deepEqual(await Promise.all([
    redeemLoginToken(token.linkToken, issued + TOKEN_MS - 1, secret, consume),
    redeemLoginToken(token.linkToken, issued + TOKEN_MS - 1, secret, consume),
  ]), [account, null]);
  assert.equal(await redeemLoginToken(expired.linkToken, issued + TOKEN_MS, secret, consume), null);
});
