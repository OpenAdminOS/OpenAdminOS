import { RELEASE_REVALIDATE_SECONDS } from "./release-downloads";

const RELEASES_API_URL =
  "https://api.github.com/repos/OpenAdminOS/OpenAdminOS/releases?per_page=30";

interface GitHubRelease {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
  body?: string | null;
}

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
  try {
    const response = await fetch(RELEASES_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });
    if (!response.ok) return [];
    const releases = (await response.json()) as GitHubRelease[];
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
  } catch {
    return [];
  }
}
