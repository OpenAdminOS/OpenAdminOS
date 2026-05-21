import { getRedis, keys } from "./redis";

const SLUGS_TTL_SECONDS = 60 * 60; // 1 hour

interface CachedSlugs {
  slugs: string[];
  cachedAt: number;
}

/**
 * Returns the set of slugs the API will accept install events for.
 * Sourced from the live `agents/` directory listing on GitHub, cached
 * in Redis for an hour so we don't hit GitHub on every install request.
 *
 * If the cache is empty AND the GitHub fetch fails, we return an empty
 * set rather than guessing — the `/api/install` handler then rejects
 * the request with a 503, which is the right signal for the client to
 * back off and retry later. We never trust the client's slug claim
 * against an unknown allowlist.
 */
export async function getKnownSlugs(): Promise<Set<string>> {
  const redis = getRedis();
  const cached = (await redis.get<CachedSlugs>(keys.knownSlugs())) ?? null;
  if (cached && Array.isArray(cached.slugs)) {
    return new Set(cached.slugs);
  }

  const fresh = await fetchSlugsFromGithub();
  await redis.set(
    keys.knownSlugs(),
    { slugs: [...fresh], cachedAt: Date.now() } satisfies CachedSlugs,
    { ex: SLUGS_TTL_SECONDS },
  );
  return fresh;
}

interface GithubContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

async function fetchSlugsFromGithub(): Promise<Set<string>> {
  const owner = requireEnv("OPENADMINOS_GITHUB_OWNER");
  const repo = requireEnv("OPENADMINOS_GITHUB_REPO");
  const token = requireEnv("OPENADMINOS_GITHUB_TOKEN");
  const branch = process.env.OPENADMINOS_GITHUB_BRANCH ?? "main";

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/agents?ref=${branch}`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch agent slugs from GitHub: ${response.status} ${response.statusText}`,
    );
  }
  const entries = (await response.json()) as GithubContentEntry[];
  return new Set(entries.filter((entry) => entry.type === "dir").map((entry) => entry.name));
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}.`);
  return value;
}
