import { NextResponse } from "next/server";

import { commitStats, fetchStats } from "~/lib/stats/github";
import { getRedis, keys, recentInstallDays } from "~/lib/stats/redis";
import { getKnownSlugs } from "~/lib/stats/slugs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/flush
 *
 * The hourly cron commits only when pending deltas or rolling totals change.
 *
 * Auth: requires `Authorization: Bearer <CRON_SECRET>` exactly. Vercel
 * sets that header for cron-triggered invocations automatically.
 *
 * Concurrency: Vercel won't run two crons for the same path
 * concurrently, but we still write `stats/agents.json` with the GitHub
 * blob SHA we read before updating the file. If main moved
 * underneath us, GitHub returns a conflict. The next cron
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
  const now = new Date();
  const days = recentInstallDays(now);

  for (const slug of slugList) {
    const counters = await redis.mget<(string | number | null)[]>(
      keys.pendingInstalls(slug),
      ...days.map((day) => keys.dailyInstalls(slug, day)),
    );
    const [pending, ...daily] = counters.map((counter) => Number(counter) || 0);
    pendingDeltas[slug] = pending ?? 0;
    sevenDayCounts[slug] = daily.reduce((total, count) => total + count, 0);
  }

  const { file, sha } = await fetchStats();
  const totalDelta = Object.values(pendingDeltas).reduce((sum, n) => sum + n, 0);
  if (totalDelta === 0 && !hasSevenDayDrift(file, sevenDayCounts)) {
    return {
      flushed: false,
      totals: snapshotTotals(file),
      pendingApplied: pendingDeltas,
    };
  }

  for (const slug of slugList) {
    const previous = file.agents[slug] ?? { installs: 0, installs7d: 0 };
    file.agents[slug] = {
      ...previous,
      installs: previous.installs + (pendingDeltas[slug] ?? 0),
      installs7d: sevenDayCounts[slug] ?? 0,
    };
  }
  file.updatedAt = now.toISOString();

  await commitStats({
    file,
    sha,
    commitMessage: buildCommitMessage(pendingDeltas),
  });

  // Subtract only what was committed. Installs received during the flush
  // remain pending for the next run.
  const applied = Object.entries(pendingDeltas).filter(([, count]) => count > 0);
  if (applied.length > 0) {
    const transaction = redis.multi();
    for (const [slug, count] of applied) {
      transaction.decrby(keys.pendingInstalls(slug), count);
    }
    await transaction.exec();
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
