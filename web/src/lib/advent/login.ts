import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";

import { getRedis, keys } from "../stats/redis";
import { createLoginToken, redeemLoginToken } from "./auth";
import { MARKETING_CONSENT_VERSION, REMINDERS_CONSENT_VERSION, RULES_VERSION } from "./config";
import { db, rpc } from "./db";
import { newReferralCode, parseReferral } from "./identity";

const EMAIL = z.email().max(254);

export function parseEmail(input: string) {
  const email = input.trim().toLowerCase();
  return EMAIL.safeParse(email).success ? email : null;
}

const RATE_WINDOW_MS = 60 * 60 * 1000;

// One Redis operation checks both rolling limits and sets the expiry on every accepted request.
const LOGIN_RATE_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now - window)
end
if redis.call('ZCARD', KEYS[1]) >= 5 or redis.call('ZCARD', KEYS[2]) >= 20 then return 0 end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[i], window)
end
return 1
`;

export async function allowLoginEmail(request: Request, email: string, secret: string) {
  const forwarded = process.env.VERCEL === "1"
    ? request.headers.get("x-vercel-forwarded-for")
    : request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
  const ip = forwarded?.split(",")[0]?.trim() || "unknown";
  const keyHash = (value: string) => createHmac("sha256", secret).update(value).digest("hex");
  return (await getRedis().eval<unknown[], number>(
    LOGIN_RATE_SCRIPT,
    [keys.adventEmailRate(keyHash(`email:${email}`)), keys.adventIpRate(keyHash(`ip:${ip}`))],
    [Date.now(), RATE_WINDOW_MS, randomUUID()],
  )) === 1;
}

export async function issueLoginLink(
  origin: string, email: string, secret: string,
  signup?: { handle: string; ref: string; marketing: boolean; reminders: boolean; acceptedAt: string },
) {
  const [account] = await db<{ id: string }[]>("advent_participants", {
    select: "id",
    email: `eq.${email}`,
  });
  if (!account && !signup) return true;

  const now = Date.now();
  const token = createLoginToken(now, secret);
  const pending = signup && !account ? {
    email,
    handle: signup.handle,
    ref: parseReferral(signup.ref),
    marketing: signup.marketing,
    marketing_version: signup.marketing ? MARKETING_CONSENT_VERSION : null,
    reminders: signup.reminders,
    reminders_version: signup.reminders ? REMINDERS_CONSENT_VERSION : null,
    accepted_at: signup.acceptedAt,
    rules_version: RULES_VERSION,
  } : null;
  await db("advent_login_tokens", { expires_at: `lte.${new Date(now).toISOString()}` }, { method: "DELETE" });
  await db("advent_login_tokens", {}, {
    method: "POST",
    body: {
      token_hash: token.hash,
      expires_at: token.expiresAt,
      participant_id: account?.id ?? null,
      pending_signup: pending,
    },
  });

  // The fragment keeps the token out of HTTP request URLs and referrer headers.
  const link = new URL(`/advent/verify#${token.linkToken}`, origin).toString();
  const sent = await deliverLoginLink(email, link);
  if (!sent) {
    await db("advent_login_tokens", { token_hash: `eq.${token.hash}` }, { method: "DELETE" });
  }
  return sent;
}

async function deliverLoginLink(email: string, link: string) {
  const apiKey = process.env.ADVENT_RESEND_API_KEY;
  if (!apiKey) {
    if (process.env.NODE_ENV !== "development") return false;
    console.info(`[advent] Development sign-in link: ${link}`);
    return true;
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: process.env.ADVENT_EMAIL_FROM,
        to: [email],
        subject: "Your Advent of Admin sign-in link",
        text: `Open this link to sign in to Advent of Admin. It expires in 15 minutes and can be used once.\n\n${link}\n\nIf you did not request this link, you can ignore this email.`,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

type Consumed = { status: "ok"; id: string }
  | { status: "invalid" | "signup_closed" | "handle_taken" | "ref_collision" };

export async function consumeLogin(linkToken: string, secret: string, campaignTime: number, allowSignup: boolean) {
  return redeemLoginToken(linkToken, Date.now(), secret, async (hash, now) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await rpc<Consumed>("advent_consume_token", {
        p_hash: hash,
        p_now: now,
        p_created_at: new Date(campaignTime).toISOString(),
        p_ref_code: newReferralCode(),
        p_allow_signup: allowSignup,
      });
      if (result.status !== "ref_collision") return result;
    }
    return { status: "ref_collision" } as const;
  });
}
