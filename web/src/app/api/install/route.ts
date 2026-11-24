import { NextResponse } from "next/server";

import { statsUnavailable } from "~/lib/stats/responses";
import { getStatsStore, StatsStorageError } from "~/lib/stats/store";
import { getKnownSlugs } from "~/lib/stats/slugs";
import { HttpError, parseInstallPayload } from "~/lib/stats/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_PER_WINDOW = 30;

export async function POST(req: Request) {
  const store = getStatsStore();
  if (!store) return statsUnavailable(false);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Body must be valid JSON.");
  }

  try {
    // Version and platform are validated for client compatibility and are never stored.
    const payload = parseInstallPayload(body);
    const day = new Date().toISOString().slice(0, 10);
    const allowed = await store.rateLimitHit("install", req, RATE_LIMIT_WINDOW_SECONDS, RATE_LIMIT_MAX_PER_WINDOW);
    if (!allowed) {
      return NextResponse.json(
        { error: "Rate limited. Slow down." },
        { status: 429, headers: { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) } },
      );
    }

    const known = await getKnownSlugs();
    if (!known.has(payload.slug)) {
      return jsonError(404, `Unknown agent: ${payload.slug}`);
    }

    await store.recordInstall(payload.slug, day);

    return NextResponse.json({ counted: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return jsonError(error.status, error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error("[install] handler failed:", message);
    if (error instanceof StatsStorageError) return statsUnavailable(true);
    return jsonError(503, "Could not check the public agent list. Try again later.");
  }
}

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}
