import { GITHUB_URL } from "./seo";

export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/OpenAdminOS/OpenAdminOS/releases/latest";

export const RELEASE_REVALIDATE_SECONDS = 900;

interface GitHubReleaseAsset {
  browser_download_url?: string;
  name?: string;
}

interface GitHubLatestRelease {
  assets?: GitHubReleaseAsset[];
  html_url?: string;
  tag_name?: string;
}

function findAssetUrl(
  assets: GitHubReleaseAsset[] | undefined,
  predicate: (name: string) => boolean,
) {
  return assets?.find((asset) => {
    const name = asset.name?.toLowerCase() ?? "";
    return predicate(name);
  })?.browser_download_url;
}

export async function getLatestReleaseDownloads() {
  try {
    const response = await fetch(LATEST_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });

    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    const release = (await response.json()) as GitHubLatestRelease;
    const assets = release.assets ?? [];

    return {
      checksumUrl:
        findAssetUrl(assets, (name) => name === "sha256sums.txt") ??
        LATEST_RELEASE_URL,
      linuxAppImageUrl:
        findAssetUrl(
          assets,
          (name) => name.includes("linux") && name.endsWith(".appimage"),
        ) ?? LATEST_RELEASE_URL,
      linuxDebUrl:
        findAssetUrl(
          assets,
          (name) => name.includes("linux") && name.endsWith(".deb"),
        ) ?? LATEST_RELEASE_URL,
      linuxRpmUrl:
        findAssetUrl(
          assets,
          (name) => name.includes("linux") && name.endsWith(".rpm"),
        ) ?? LATEST_RELEASE_URL,
      macosDmgUrl:
        findAssetUrl(
          assets,
          (name) => name.endsWith(".dmg") && name.includes("arm64"),
        ) ?? LATEST_RELEASE_URL,
      releaseNotesUrl: release.html_url ?? LATEST_RELEASE_URL,
      version: release.tag_name ?? "Latest release",
    };
  } catch {
    return {
      checksumUrl: LATEST_RELEASE_URL,
      linuxAppImageUrl: LATEST_RELEASE_URL,
      linuxDebUrl: LATEST_RELEASE_URL,
      linuxRpmUrl: LATEST_RELEASE_URL,
      macosDmgUrl: LATEST_RELEASE_URL,
      releaseNotesUrl: LATEST_RELEASE_URL,
      version: "Latest release",
    };
  }
}
