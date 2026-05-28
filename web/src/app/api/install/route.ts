import { NextResponse } from "next/server";

import {
  DEDUP_TTL_SECONDS,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_SECONDS,
  getRedis,
  keys,
} from "~/lib/stats/redis";
import { getKnownSlugs } from "~/lib/stats/slugs";
import { HttpError, parseInstallPayload } from "~/lib/stats/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/install
 *
 * Logs a single install event to Redis. The cron handler aggregates
 * pending counters and commits the totals to `stats/agents.json` in
 * the GitHub repo.
 *
 * Defence in depth:
 *  - JSON shape + per-field regex validation (`lib/stats/validation.ts`)
 *  - Slug must be present in the live `agents/` directory listing on
 *    GitHub (`lib/stats/slugs.ts`, 1h cache)
 *  - Per-IP rate limit, 30/min sliding window via a fixed bucket key
 *  - Per-(installId, slug) dedup — same machine never counts twice for
 *    the same agent during the current annual digest window. TTL is 1y.
 *
 * Idempotent. Same client retrying with the same `installId` returns
 * 200 with `{ counted: false }`.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }

  try {
    const payload = parseInstallPayload(body);
    const ip = clientIp(req);

    const redis = getRedis();

    // 1) Per-IP rate limit. The bucket flips every RATE_LIMIT_WINDOW_SECONDS
    //    so we don't need a sliding-log structure — good enough for abuse
    //    deterrence at our traffic level.
    const bucket = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
    const rateKey = keys.rate(ip, bucket);
    const count = await redis.incr(rateKey);
    if (count === 1) {
      await redis.expire(rateKey, RATE_LIMIT_WINDOW_SECONDS);
    }
    if (count > RATE_LIMIT_MAX_PER_WINDOW) {
      return NextResponse.json(
        { error: "Rate limited. Slow down." },
        { status: 429, headers: { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) } },
      );
    }

    // 2) Slug allowlist. Rejects anything that doesn't correspond to a
    //    real agent directory.
    const known = await getKnownSlugs();
    if (!known.has(payload.slug)) {
      return jsonError(404, `Unknown agent: ${payload.slug}`);
    }

    // 3) Dedup. `SET NX` returns "OK" only when the key was created;
    //    `null` means it already existed (a re-install attempt).
    const dedupKey = keys.dedup(payload.installId, payload.slug);
    const setResult = await redis.set(dedupKey, "1", { nx: true, ex: DEDUP_TTL_SECONDS });
    if (setResult === null) {
      return NextResponse.json({ counted: false, reason: "duplicate" });
    }

    // 4) Increment pending counter + record this install in the 7d set
    //    so the cron can compute the trailing-7d count.
    const now = Date.now();
    await Promise.all([
      redis.incr(keys.pendingInstalls(payload.slug)),
      redis.zadd(keys.installs7d(payload.slug), {
        score: now,
        member: payload.installId,
      }),
    ]);

    return NextResponse.json({ counted: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonError(error.status, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[install] handler failed:", message);
    return jsonError(500, "Internal error.");
  }
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "unknown";
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}
