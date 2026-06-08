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
import { isIP } from "node:net";
import { join } from "node:path";

import type {
  AgentExecution,
  AgentTier,
  RequiredEntraTier,
} from "@openadminos/agent-sdk";

export const DEFAULT_REGISTRY_SOURCE =
  "https://raw.githubusercontent.com/OpenAdminOS/OpenAdminOS/main/agents";

const FETCH_TIMEOUT_MS = 10_000;

export interface RegistrySourceValidationOptions {
  allowDevSource?: boolean;
}

export interface RegistrySourceValidationResult {
  sourceUrl: string;
  isOfficial: boolean;
  requiresTrustReview: boolean;
  host: string;
}

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
  execution?: AgentExecution;
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

function readCache(userDataPath: string, sourceUrl?: string): CachedIndex | null {
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
      const cached = raw as CachedIndex;
      if (sourceUrl && cached.sourceUrl !== sourceUrl) {
        return null;
      }
      return cached;
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

export function validateRegistrySource(
  rawSource: string,
  options: RegistrySourceValidationOptions = {},
): RegistrySourceValidationResult {
  const raw = rawSource.trim();
  if (!raw) {
    throw new Error("Registry source URL must not be empty.");
  }
  if (raw.length > 500) {
    throw new Error("Registry source URL is too long.");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Registry source must be a valid URL.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Registry source must not include credentials.");
  }
  if (parsed.search || parsed.hash) {
    throw new Error("Registry source must not include query strings or fragments.");
  }
  if (parsed.pathname.endsWith("/index.json")) {
    throw new Error("Registry source must point to the agent directory, not index.json.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Registry source must use HTTPS.");
  }

  const host = normalizeHost(parsed.hostname);
  const privateOrLocal = isPrivateOrLocalHost(host);
  if (parsed.protocol === "http:") {
    if (!options.allowDevSource || !privateOrLocal) {
      throw new Error(
        "Registry source must use HTTPS. Local HTTP registries require OPENADMINOS_ALLOW_DEV_REGISTRY_SOURCE=1.",
      );
    }
  }
  if (parsed.protocol === "https:" && privateOrLocal && !options.allowDevSource) {
    throw new Error(
      "Private or localhost registry sources require OPENADMINOS_ALLOW_DEV_REGISTRY_SOURCE=1.",
    );
  }

  const sourceUrl = normalizeRegistrySource(parsed);
  const officialSource = normalizeRegistrySource(new URL(DEFAULT_REGISTRY_SOURCE));
  return {
    sourceUrl,
    isOfficial: sourceUrl === officialSource,
    requiresTrustReview: sourceUrl !== officialSource,
    host,
  };
}

export async function refreshRegistry(
  userDataPath: string,
  registrySource: string,
  options: RegistrySourceValidationOptions = {},
): Promise<RefreshResult> {
  let sourceUrl: string;
  try {
    sourceUrl = validateRegistrySource(registrySource, options).sourceUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { entries: [], fromCache: false, cachedAt: null, error: message };
  }
  const indexUrl = `${sourceUrl}/index.json`;

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
    return { entries: fetchedIndex.agents, fromCache: false, cachedAt: new Date().toISOString(), error: null };
  }

  const cached = readCache(userDataPath, sourceUrl);
  if (cached) {
    return { entries: cached.agents, fromCache: true, cachedAt: cached.cachedAt, error: fetchError };
  }

  return { entries: [], fromCache: false, cachedAt: null, error: fetchError };
}

export function readCachedRegistry(
  userDataPath: string,
  registrySource: string,
  _appVersion = "0.0.0",
): RefreshResult {
  let sourceUrl: string;
  try {
    sourceUrl = validateRegistrySource(registrySource).sourceUrl;
  } catch (error) {
    return {
      entries: [],
      fromCache: false,
      cachedAt: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const cached = readCache(userDataPath, sourceUrl);
  if (cached) {
    return { entries: cached.agents, fromCache: true, cachedAt: cached.cachedAt, error: null };
  }
  return { entries: [], fromCache: false, cachedAt: null, error: null };
}

function normalizeRegistrySource(url: URL): string {
  const normalized = new URL(url.toString());
  normalized.pathname = normalized.pathname.replace(/\/+$/, "");
  return normalized.toString().replace(/\/$/, "");
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function isPrivateOrLocalHost(host: string): boolean {
  if (host === "localhost" || host === "localhost.") return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return isPrivateIpv4(host);
  if (ipVersion === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map((part) => Number.parseInt(part, 10));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host === "::") return true;
  const normalized = host.toLowerCase();
  return (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}
