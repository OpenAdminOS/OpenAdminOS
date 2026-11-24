import { Redis } from "@upstash/redis";

let cached: Redis | null = null;

export function getRedis(): Redis {
  if (cached) return cached;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set. Configure them in the Vercel project (or `.env.local` for `vercel dev`).",
    );
  }
  cached = new Redis({ url, token });
  return cached;
}

/**
 * Redis key layout. All keys live under the `oa:` prefix so the same
 * Upstash database can host other projects without collision.
 *
 *   oa:pending:installs:<slug>             integer     pending install delta
 *   oa:rate:install:<ip>:<bucket>          integer     rate-limit counter (60s TTL)
 *   oa:rate:agent-submit:<ip>:<bucket>     integer     rate-limit counter (1h TTL)
 *   oa:rate:support-issue:<ip>:<bucket>    integer     rate-limit counter (1h TTL)
 *   oa:dedup:support-issue:<hash>          string      "1" + 24h TTL
 *   oa:installs:day:<date>:<slug>          integer     UTC day count (8-day TTL)
 *   oa:slugs                               string      JSON-encoded array, 1h TTL
 */
export const keys = {
  pendingInstalls: (slug: string) => `oa:pending:installs:${slug}`,
  rate: (ip: string, bucket: number) => `oa:rate:install:${ip}:${bucket}`,
  agentSubmissionRate: (ip: string, bucket: number) => `oa:rate:agent-submit:${ip}:${bucket}`,
  supportIssueRate: (ip: string, bucket: number) => `oa:rate:support-issue:${ip}:${bucket}`,
  supportIssueDedup: (hash: string) => `oa:dedup:support-issue:${hash}`,
  dailyInstalls: (slug: string, day: string) => `oa:installs:day:${day}:${slug}`,
  knownSlugs: () => `oa:slugs`,
} as const;

/** Rate-limit window for `/api/install` per IP. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX_PER_WINDOW = 30;

export const INSTALL_DAY_TTL_SECONDS = 8 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Seven UTC calendar days ending today. */
export function recentInstallDays(now: Date): string[] {
  return Array.from({ length: 7 }, (_, offset) =>
    new Date(now.getTime() - offset * DAY_MS).toISOString().slice(0, 10),
  );
}
