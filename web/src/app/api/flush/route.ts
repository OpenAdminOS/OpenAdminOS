import { NextResponse } from "next/server";

import { commitStats, fetchStats } from "~/lib/stats/github";
import { SEVEN_DAYS_MS, getRedis, keys } from "~/lib/stats/redis";
import { getKnownSlugs } from "~/lib/stats/slugs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/flush
 *
 * Cron-only endpoint. Wired by `vercel.json` to fire hourly. Idempotent:
 * if Redis has no pending deltas, this is a no-op and no commit lands.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` exactly. Vercel
 * sets that header for cron-triggered invocations automatically.
 *
 * Concurrency: Vercel won't run two crons for the same path
 * concurrently, but we still write `stats/agents.json` with the GitHub
 * blob SHA we read at the top of the function — if main moved
 * underneath us, GitHub 409s and the call returns an error. Next cron
 * tick retries.
 */
export async function GET(req: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET not configured." }, { status: 500 });
  }
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const result = await runFlush();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[flush] failed:", message);
    return NextResponse.json({ error: "Flush failed.", detail: message }, { status: 500 });
  }
}

interface FlushResult {
  flushed: boolean;
  totals: Record<string, { installs: number; installs7d: number }>;
  pendingApplied: Record<string, number>;
}

async function runFlush(): Promise<FlushResult> {
  const redis = getRedis();
  const slugs = await getKnownSlugs();

  const slugList = [...slugs];
  const pendingDeltas: Record<string, number> = {};
  const sevenDayCounts: Record<string, number> = {};
  const cutoff = Date.now() - SEVEN_DAYS_MS;

  for (const slug of slugList) {
    const pendingStr = (await redis.get<string | number>(keys.pendingInstalls(slug))) ?? 0;
    const pending =
      typeof pendingStr === "number" ? pendingStr : parseInt(String(pendingStr), 10) || 0;
    pendingDeltas[slug] = pending;

    // Trim expired entries from the 7d ZSET, then read its cardinality.
    await redis.zremrangebyscore(keys.installs7d(slug), 0, cutoff);
    const live = await redis.zcard(keys.installs7d(slug));
    sevenDayCounts[slug] = live;
  }

  const { file, sha } = await fetchStats();

  for (const slug of slugList) {
    const previous = file.agents[slug] ?? { installs: 0, installs7d: 0 };
    file.agents[slug] = {
      ...previous,
      installs: previous.installs + (pendingDeltas[slug] ?? 0),
      installs7d: sevenDayCounts[slug] ?? 0,
    };
  }
  file.updatedAt = new Date().toISOString();

  const totalDelta = Object.values(pendingDeltas).reduce((sum, n) => sum + n, 0);
  const hasChange = totalDelta > 0 || hasSevenDayDrift(file, sevenDayCounts);
  if (!hasChange) {
    return {
      flushed: false,
      totals: snapshotTotals(file),
      pendingApplied: pendingDeltas,
    };
  }

  await commitStats({
    file,
    sha,
    commitMessage: buildCommitMessage(pendingDeltas),
  });

  for (const slug of slugList) {
    if ((pendingDeltas[slug] ?? 0) > 0) {
      await redis.del(keys.pendingInstalls(slug));
    }
  }

  return {
    flushed: true,
    totals: snapshotTotals(file),
    pendingApplied: pendingDeltas,
  };
}

function hasSevenDayDrift(
  file: { agents: Record<string, { installs7d: number }> },
  fresh: Record<string, number>,
): boolean {
  for (const [slug, count] of Object.entries(fresh)) {
    if ((file.agents[slug]?.installs7d ?? -1) !== count) return true;
  }
  return false;
}

function snapshotTotals(file: {
  agents: Record<string, { installs: number; installs7d: number }>;
}): Record<string, { installs: number; installs7d: number }> {
  const out: Record<string, { installs: number; installs7d: number }> = {};
  for (const [slug, entry] of Object.entries(file.agents)) {
    out[slug] = { installs: entry.installs, installs7d: entry.installs7d };
  }
  return out;
}

function buildCommitMessage(pending: Record<string, number>): string {
  const nonZero = Object.entries(pending).filter(([, count]) => count > 0);
  const total = nonZero.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) {
    return `stats: refresh 7d window`;
  }
  const lines = nonZero.map(([slug, count]) => `  ${slug}: +${count}`);
  return [`stats: +${total} install${total === 1 ? "" : "s"}`, "", ...lines].join("\n");
}
