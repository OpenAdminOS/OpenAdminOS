import { createClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";

export interface InstallSnapshot {
  slug: string;
  days: Record<string, number>;
}

export interface PendingInstall extends InstallSnapshot {
  delta: number;
}

type StatsRpc = {
  rpc(
    name: string,
    args?: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { code: string } | null }>;
};

export class StatsStorageError extends Error {
  override name = "StatsStorageError";
}

let loggedClientInitError = false;

export function createStatsStore(client: StatsRpc, ipHashKey: string | Buffer) {
  async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw new StatsStorageError(`${name} failed (${error.code || "network error"}).`);
    return data as T;
  }

  return {
    recordInstall: (slug: string, day: string) =>
      rpc<void>("record_install", { p_slug: slug, p_day: day }),
    // Fixed windows can allow two bursts across a boundary. On rejection the
    // routes send the full window in Retry-After, an upper bound on the wait.
    rateLimitHit: (scope: string, request: Request, windowSeconds: number, max: number) =>
      rpc<boolean>("rate_limit_hit", {
        p_scope: scope,
        p_key_hash: createHmac("sha256", ipHashKey).update(`${scope}\n${clientIp(request)}`).digest("hex"),
        p_window_seconds: windowSeconds,
        p_max: max,
      }),
    claimSupportDedup: (hash: string, ttlSeconds: number) =>
      rpc<boolean>("claim_support_dedup", { p_hash: hash, p_ttl_seconds: ttlSeconds }),
    releaseSupportDedup: (hash: string) =>
      rpc<void>("release_support_dedup", { p_hash: hash }),
    pendingInstallSnapshot: () => rpc<PendingInstall[]>("pending_install_snapshot"),
    markInstallsFlushed: (snapshot: InstallSnapshot[]) =>
      rpc<void>("mark_installs_flushed", { p_snapshot: snapshot }),
    installs7d: () => rpc<{ slug: string; installs: number }[]>("installs_7d"),
    purgeExpired: () => rpc<void>("purge_expired"),
    health: () => rpc<boolean>("health"),
  };
}

export function getStatsStore() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;

  let client;
  try {
    client = createClient(url, key, {
      db: { schema: "openadminos" },
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
  } catch {
    if (!loggedClientInitError) {
      loggedClientInitError = true;
      console.error("[stats] Could not initialize storage. Check SUPABASE_URL and SUPABASE_SECRET_KEY.");
    }
    return null;
  }
  const ipHashKey = process.env.STATS_IP_HASH_SECRET ||
    createHmac("sha256", key).update("openadminos:stats:ip-hash:v1").digest();
  return createStatsStore(client, ipHashKey);
}

function clientIp(request: Request): string {
  // Use Vercel's IP headers. Proxies in front of Vercel can overwrite x-forwarded-for.
  const forwarded = request.headers.get("x-vercel-forwarded-for");
  return forwarded?.split(",", 1)[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "unknown";
}
