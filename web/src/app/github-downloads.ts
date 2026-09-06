const GITHUB_RELEASES_API_URL =
  "https://api.github.com/repos/OpenAdminOS/OpenAdminOS/releases";

// Match the README's total-downloads badge: all assets across all releases.
export async function getGitHubDownloadCount(): Promise<number | null> {
  try {
    let total = 0;
    let page = 1;

    while (true) {
      const response = await fetch(
        `${GITHUB_RELEASES_API_URL}?per_page=100&page=${page}`,
        {
          headers: { Accept: "application/vnd.github+json" },
          next: { revalidate: 3600 },
        },
      );
      if (!response.ok) return null;

      const releases: unknown = await response.json();
      if (!Array.isArray(releases)) return null;

      for (const release of releases) {
        if (!isRecord(release) || !Array.isArray(release.assets)) return null;

        for (const asset of release.assets) {
          if (!isRecord(asset)) return null;
          const count = asset.download_count;
          if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
            return null;
          }
          total += count;
        }
      }

      if (releases.length < 100) return total;
      page += 1;
    }
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
