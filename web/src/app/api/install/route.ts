import { NextResponse } from "next/server";

import {
  INSTALL_DAY_TTL_SECONDS,
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
 *  - Per-IP rate limit of 30 requests per minute
 *  - Desktop deduplication before sending the event
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }

  try {
    // Version and platform are validated for client compatibility and are never stored.
    const payload = parseInstallPayload(body);
    const ip = clientIp(req);

    const redis = getRedis();
    const now = new Date();

    // 1) Per-IP rate limit. The bucket flips every RATE_LIMIT_WINDOW_SECONDS
    //    to bound traffic without a separate entry for every request.
    const bucket = Math.floor(now.getTime() / 1000 / RATE_LIMIT_WINDOW_SECONDS);
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

    const dailyKey = keys.dailyInstalls(payload.slug, now.toISOString().slice(0, 10));
    await redis.multi()
      .incr(keys.pendingInstalls(payload.slug))
      .incr(dailyKey)
      .expire(dailyKey, INSTALL_DAY_TTL_SECONDS)
      .exec();

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
