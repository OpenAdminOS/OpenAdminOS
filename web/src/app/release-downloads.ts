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

function findAsset(
  assets: GitHubReleaseAsset[] | undefined,
  predicate: (name: string) => boolean,
) {
  return assets?.find((asset) => {
    const name = asset.name?.toLowerCase() ?? "";
    return predicate(name);
  });
}

function parseSha256Sums(content: string) {
  const checksums: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const [hash, ...fileNameParts] = trimmed.split(/\s+/);
    if (!hash) continue;

    const fileName = fileNameParts.join(" ").replace(/^\*/, "");

    if (/^[a-f0-9]{64}$/i.test(hash) && fileName) {
      checksums[fileName.toLowerCase()] = hash.toLowerCase();
    }
  }

  return checksums;
}

async function fetchSha256Sums(checksumUrl: string) {
  if (checksumUrl === LATEST_RELEASE_URL) return {};

  try {
    const response = await fetch(checksumUrl, {
      next: { revalidate: RELEASE_REVALIDATE_SECONDS },
    });

    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);

    return parseSha256Sums(await response.text());
  } catch {
    return {};
  }
}

function toDownloadAsset(
  asset: GitHubReleaseAsset | undefined,
  fallbackFileName: string,
  checksums: Record<string, string>,
) {
  const fileName = asset?.name ?? fallbackFileName;

  return {
    fileName,
    sha256: checksums[fileName.toLowerCase()],
    url: asset?.browser_download_url ?? LATEST_RELEASE_URL,
  };
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
    const checksumAsset = findAsset(
      assets,
      (name) => name === "sha256sums.txt",
    );
    const checksumUrl = checksumAsset?.browser_download_url ?? LATEST_RELEASE_URL;
    const checksums = await fetchSha256Sums(checksumUrl);
    const linuxAppImage = toDownloadAsset(
      findAsset(
        assets,
        (name) => name.includes("linux") && name.endsWith(".appimage"),
      ),
      "OpenAdminOS-linux-x86_64.AppImage",
      checksums,
    );
    const linuxDeb = toDownloadAsset(
      findAsset(
        assets,
        (name) => name.includes("linux") && name.endsWith(".deb"),
      ),
      "OpenAdminOS-linux-amd64.deb",
      checksums,
    );
    const linuxRpm = toDownloadAsset(
      findAsset(
        assets,
        (name) => name.includes("linux") && name.endsWith(".rpm"),
      ),
      "OpenAdminOS-linux-x86_64.rpm",
      checksums,
    );
    const macosDmg = toDownloadAsset(
      findAsset(
        assets,
        (name) => name.endsWith(".dmg") && name.includes("arm64"),
      ),
      "OpenAdminOS-mac-arm64.dmg",
      checksums,
    );

    return {
      checksumUrl,
      linuxAppImage,
      linuxAppImageUrl: linuxAppImage.url,
      linuxDeb,
      linuxDebUrl: linuxDeb.url,
      linuxRpm,
      linuxRpmUrl: linuxRpm.url,
      macosDmg,
      macosDmgUrl: macosDmg.url,
      releaseNotesUrl: release.html_url ?? LATEST_RELEASE_URL,
      version: release.tag_name ?? "Latest release",
    };
  } catch {
    const fallbackAsset = {
      fileName: "Latest release",
      sha256: undefined,
      url: LATEST_RELEASE_URL,
    };

    return {
      checksumUrl: LATEST_RELEASE_URL,
      linuxAppImage: fallbackAsset,
      linuxAppImageUrl: LATEST_RELEASE_URL,
      linuxDeb: fallbackAsset,
      linuxDebUrl: LATEST_RELEASE_URL,
      linuxRpm: fallbackAsset,
      linuxRpmUrl: LATEST_RELEASE_URL,
      macosDmg: fallbackAsset,
      macosDmgUrl: LATEST_RELEASE_URL,
      releaseNotesUrl: LATEST_RELEASE_URL,
      version: "Latest release",
    };
  }
}
