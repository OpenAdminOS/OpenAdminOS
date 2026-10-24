import { getAllReleases } from "./github-releases";

// Match the README's total-downloads badge: all assets across all releases.
// Reads the shared release listing rather than fetching it again.
export async function getGitHubDownloadCount(): Promise<number | null> {
  const releases = await getAllReleases();
  if (!releases) return null;

  let total = 0;
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
  return total;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
