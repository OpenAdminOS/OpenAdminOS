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
 * Redis key layout — all keys live under the `oa:` prefix so the same
 * Upstash database can host other projects without collision.
 *
 *   oa:pending:installs:<slug>             integer     pending install delta
 *   oa:dedup:<installId>:<slug>            string      "1" + 1y TTL
 *   oa:rate:install:<ip>:<bucket>          integer     rate-limit counter (60s TTL)
 *   oa:installs7d:<slug>                   zset        installId → unix-ms score
 *   oa:slugs                               string      JSON-encoded array, 1h TTL
 */
export const keys = {
  pendingInstalls: (slug: string) => `oa:pending:installs:${slug}`,
  dedup: (installId: string, slug: string) => `oa:dedup:${installId}:${slug}`,
  rate: (ip: string, bucket: number) => `oa:rate:install:${ip}:${bucket}`,
  installs7d: (slug: string) => `oa:installs7d:${slug}`,
  knownSlugs: () => `oa:slugs`,
} as const;

/** Lifetime of a dedup entry. One year is effectively permanent for an install. */
export const DEDUP_TTL_SECONDS = 365 * 24 * 60 * 60;

/** Rate-limit window for `/api/install` per IP. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_MAX_PER_WINDOW = 30;

/** 7d window for `installs7d` snapshots. */
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
