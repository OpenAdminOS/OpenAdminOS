import { NextResponse } from "next/server";

import { commitStats, fetchStats } from "~/lib/stats/github";
import { cronAuthError, statsUnavailable } from "~/lib/stats/responses";
import { getKnownSlugs } from "~/lib/stats/slugs";
import { getStatsStore, StatsStorageError } from "~/lib/stats/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request) {
  const store = getStatsStore();
  if (!store) return statsUnavailable(false);

  const authError = cronAuthError(req);
  if (authError) return authError;

  try {
    const { file, sha, lastFlush } = await fetchStats();
    // Recover a previous commit if the request stopped before it acknowledged the counts.
    if (lastFlush.length) await store.markInstallsFlushed(lastFlush);

    const [slugs, pending, recent] = await Promise.all([
      getKnownSlugs(), store.pendingInstallSnapshot(), store.installs7d(),
    ]);
    const pendingBySlug = new Map(pending.map(({ slug, delta }) => [slug, delta]));
    const recentBySlug = new Map(recent.map(({ slug, installs }) => [slug, installs]));
    const allSlugs = new Set([...slugs, ...Object.keys(file.agents), ...pendingBySlug.keys(), ...recentBySlug.keys()]);
    const drift = [...allSlugs].some((slug) => file.agents[slug]?.installs7d !== (recentBySlug.get(slug) ?? 0));
    const flushed = pending.length > 0 || drift;

    if (flushed) {
      for (const slug of allSlugs) {
        const previous = Object.hasOwn(file.agents, slug) ? file.agents[slug] : undefined;
        file.agents[slug] = {
          ...previous,
          installs: (previous?.installs ?? 0) + (pendingBySlug.get(slug) ?? 0),
          installs7d: recentBySlug.get(slug) ?? 0,
        };
      }
      file.updatedAt = new Date().toISOString();

      const snapshot = pending.map(({ slug, days }) => ({ slug, days }));
      await commitStats({ file, sha, commitMessage: buildCommitMessage(pendingBySlug), snapshot });
      if (snapshot.length) await store.markInstallsFlushed(snapshot);
    }
    await store.purgeExpired();

    return NextResponse.json({
      flushed,
      totals: Object.fromEntries(Object.entries(file.agents).map(([slug, { installs, installs7d }]) =>
        [slug, { installs, installs7d }])),
      pendingApplied: Object.fromEntries([...allSlugs].map((slug) => [slug, pendingBySlug.get(slug) ?? 0])),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[flush] failed:", message);
    if (error instanceof StatsStorageError) return statsUnavailable(true);
    return NextResponse.json({ error: "Could not publish install counts. Try again later." }, { status: 500 });
  }
}

function buildCommitMessage(pending: Map<string, number>): string {
  const total = [...pending.values()].reduce((sum, delta) => sum + delta, 0);
  if (total === 0) return "stats: refresh 7d window";

  const lines = [...pending].map(([slug, delta]) => `  ${slug}: +${delta}`);
  return [`stats: +${total} install${total === 1 ? "" : "s"}`, "", ...lines].join("\n");
}
