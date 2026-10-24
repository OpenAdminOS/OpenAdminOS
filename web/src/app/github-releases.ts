import { cache } from "react";

import { RELEASE_REVALIDATE_SECONDS } from "./release-downloads";

const RELEASES_API_URL =
  "https://api.github.com/repos/OpenAdminOS/OpenAdminOS/releases";

export interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string | null;
  assets?: unknown;
}

/**
 * Every release, newest first, from one paginated listing. The homepage
 * changelog and the download total both read it, so a render spends one
 * unauthenticated GitHub request per page (60 an hour per IP) instead of one
 * per feature. Null when GitHub is unavailable.
 */
export const getAllReleases = cache(async (): Promise<GitHubRelease[] | null> => {
  try {
    const releases: GitHubRelease[] = [];
    for (let page = 1; ; page += 1) {
      const response = await fetch(`${RELEASES_API_URL}?per_page=100&page=${page}`, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        next: { revalidate: RELEASE_REVALIDATE_SECONDS },
      });
      if (!response.ok) return null;
      const batch: unknown = await response.json();
      if (!Array.isArray(batch)) return null;
      releases.push(...(batch as GitHubRelease[]));
      if (batch.length < 100) return releases;
    }
  } catch {
    return null;
  }
});

export interface ReleaseNote {
  version: string;
  url: string;
  publishedAt: string;
  summary: string;
}

/** First readable line of a release body: skips headings and blank lines. */
function summarize(body: string | null | undefined) {
  for (const raw of (body ?? "").split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[`*_]/g, "");
    if (!line || line.startsWith("#")) continue;
    return line.length > 150 ? `${line.slice(0, 147).trimEnd()}...` : line;
  }
  return "";
}

/**
 * Recent stable desktop releases for the homepage changelog. Nightlies and
 * non-app releases (such as the documentation index) are excluded. Returns an
 * empty list when GitHub is unavailable, so the section is simply omitted.
 */
export async function getRecentReleases(limit = 4): Promise<ReleaseNote[]> {
  const releases = await getAllReleases();
  if (!releases) return [];
  return releases
    .filter(
      (release) =>
        !release.draft &&
        !release.prerelease &&
        /^v\d+\.\d+\.\d+$/.test(release.tag_name ?? "") &&
        release.html_url &&
        release.published_at,
    )
    .slice(0, limit)
    .map((release) => ({
      version: release.tag_name!,
      url: release.html_url!,
      publishedAt: release.published_at!,
      summary: summarize(release.body),
    }));
}
