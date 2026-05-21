/**
 * Registry client — fetches and caches the agent index from the configured
 * registry source. The app binary ships with zero bundled agents; everything
 * is fetched at runtime and cached to userData.
 *
 * Lifecycle:
 *   1. On launch (online): fetch index.json from registry source, update cache.
 *   2. On launch (offline) or fetch failure: fall back to cache.
 *   3. On manual refresh (user-triggered): same as online launch.
 *
 * Cache location: <userData>/registry-cache/index.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentTier, RequiredEntraTier } from "@openadminos/agent-sdk";

export const DEFAULT_REGISTRY_SOURCE =
  "https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents";

const FETCH_TIMEOUT_MS = 10_000;

export interface RegistryIndexEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  mode: "read" | "write";
  category: string;
  tier: AgentTier;
  /** Minimum Entra ID tier. May be absent on index.json built before v0.2 schema. */
  requiresEntraTier?: RequiredEntraTier;
  author: {
    name: string;
    handle?: string;
    verified: boolean;
  };
  scopes: string[];
  minAppVersion: string;
  manifestUrl: string;
}

interface RegistryIndex {
  schemaVersion: number;
  /** Optional. Older indexes carried a Date.now() string here; dropped
   *  to keep generator output deterministic across CI runs. Kept
   *  optional on the interface so existing cached payloads parse. */
  generatedAt?: string;
  agents: RegistryIndexEntry[];
}

interface CachedIndex extends RegistryIndex {
  cachedAt: string;
  sourceUrl: string;
}

export interface RefreshResult {
  entries: RegistryIndexEntry[];
  fromCache: boolean;
  cachedAt: string | null;
  error: string | null;
}

function cacheDir(userDataPath: string): string {
  return join(userDataPath, "registry-cache");
}

function cachePath(userDataPath: string): string {
  return join(cacheDir(userDataPath), "index.json");
}

function readCache(userDataPath: string): CachedIndex | null {
  const path = cachePath(userDataPath);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      raw &&
      typeof raw === "object" &&
      "agents" in raw &&
      Array.isArray((raw as { agents: unknown }).agents)
    ) {
      return raw as CachedIndex;
    }
    return null;
  } catch {
    return null;
  }
}

function writeCache(userDataPath: string, index: RegistryIndex, sourceUrl: string): void {
  const dir = cacheDir(userDataPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cached: CachedIndex = {
    ...index,
    cachedAt: new Date().toISOString(),
    sourceUrl,
  };
  writeFileSync(cachePath(userDataPath), JSON.stringify(cached, null, 2) + "\n");
}

function satisfiesMinVersion(minAppVersion: string, appVersion: string): boolean {
  const [mMaj = 0, mMin = 0] = minAppVersion.split(".").map(Number);
  const [aMaj = 0, aMin = 0] = appVersion.split(".").map(Number);
  if (aMaj !== mMaj) return aMaj > mMaj;
  return aMin >= mMin;
}

export async function refreshRegistry(
  userDataPath: string,
  registrySource: string,
): Promise<RefreshResult> {
  const sourceUrl = registrySource.replace(/\/$/, "");
  const indexUrl = `${sourceUrl}/index.json`;
  let appVersion = "0.0.0";
  try {
    const { app } = await import("electron");
    appVersion = app.getVersion();
  } catch {
    // dev/test context without Electron
  }

  let fetchedIndex: RegistryIndex | null = null;
  let fetchError: string | null = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const response = await fetch(indexUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as unknown;
    if (
      body &&
      typeof body === "object" &&
      "agents" in body &&
      Array.isArray((body as { agents: unknown }).agents)
    ) {
      fetchedIndex = body as RegistryIndex;
    } else {
      throw new Error("Invalid index shape");
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  if (fetchedIndex) {
    writeCache(userDataPath, fetchedIndex, sourceUrl);
    const filtered = fetchedIndex.agents.filter((e) =>
      satisfiesMinVersion(e.minAppVersion, appVersion),
    );
    return { entries: filtered, fromCache: false, cachedAt: new Date().toISOString(), error: null };
  }

  const cached = readCache(userDataPath);
  if (cached) {
    const filtered = cached.agents.filter((e) =>
      satisfiesMinVersion(e.minAppVersion, appVersion),
    );
    return { entries: filtered, fromCache: true, cachedAt: cached.cachedAt, error: fetchError };
  }

  return { entries: [], fromCache: false, cachedAt: null, error: fetchError };
}

export function readCachedRegistry(
  userDataPath: string,
  _registrySource: string,
  appVersion = "0.0.0",
): RefreshResult {
  const cached = readCache(userDataPath);
  if (cached) {
    const filtered = cached.agents.filter((e) =>
      satisfiesMinVersion(e.minAppVersion, appVersion),
    );
    return { entries: filtered, fromCache: true, cachedAt: cached.cachedAt, error: null };
  }
  return { entries: [], fromCache: false, cachedAt: null, error: null };
}
