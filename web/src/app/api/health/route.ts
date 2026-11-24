import { NextResponse } from "next/server";

import { statsUnavailable } from "~/lib/stats/responses";
import { getStatsStore } from "~/lib/stats/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const store = getStatsStore();
  if (!store) return statsUnavailable(false);

  try {
    return await store.health() ? NextResponse.json({ ok: true }) : statsUnavailable(true);
  } catch (error) {
    console.error("[health] stats check failed:", error);
    return statsUnavailable(true);
  }
}
