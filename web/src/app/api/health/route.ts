import { NextResponse } from "next/server";

import { getRedis } from "~/lib/stats/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Public liveness probe. Confirms the function can reach Redis. Does
 * NOT exercise the GitHub path — that's slow and rate-limited, so we
 * keep it out of the hot path.
 */
export async function GET() {
  try {
    const redis = getRedis();
    const pong = await redis.ping();
    return NextResponse.json({ ok: pong === "PONG", redis: pong });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
