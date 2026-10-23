import type { AppUpdater } from "electron-updater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";

type GithubOptions = ConstructorParameters<typeof GitHubProvider>[0];
type ProviderRuntimeOptions = ConstructorParameters<typeof GitHubProvider>[2];
type Latest = Awaited<ReturnType<GitHubProvider["getLatestVersion"]>>;

/** The repository releases are published to, as in the desktop package.json `build.publish`. */
export const RELEASE_FEED = {
  provider: "github",
  owner: "OpenAdminOS",
  repo: "OpenAdminOS",
} as const satisfies GithubOptions;

/** Numeric parts of a release version (0.7.1) or a nightly (0.7.1-nightly.20261023141500). */
function parts(version: string): { release: number[]; nightly: number[] | null } {
  const [release = "", pre] = version.replace(/^v/, "").split("-", 2);
  return {
    release: release.split(".").map(Number),
    nightly: pre === undefined ? null : pre.split(".").slice(1).map(Number),
  };
}

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Positive when `a` is newer than `b`. A nightly sorts before the stable release it previews. */
export function compareVersions(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  const release = compareNumbers(left.release, right.release);
  if (release !== 0) return release;
  if (left.nightly === null || right.nightly === null) {
    return (left.nightly === null ? 1 : 0) - (right.nightly === null ? 1 : 0);
  }
  return compareNumbers(left.nightly, right.nightly);
}

/**
 * GitHub releases for both channels. Stable follows stable releases only
 * (GitHub's "latest" release and latest*.yml). Nightly follows the nightly
 * prereleases (nightly*.yml), but a stable release newer than the newest
 * nightly, such as 0.7.1 over 0.7.1-nightly.20261023141500, is offered as
 * well. Without that, electron-updater's GitHub provider never hands a
 * nightly install a stable release, so turning on nightlies would hold
 * back the stable release they preview.
 *
 * Wired through `setFeedURL({ provider: "custom", updateProvider })`;
 * electron-updater constructs it with (options, updater, runtimeOptions).
 */
export class ReleaseProvider extends GitHubProvider {
  private readonly stable: GitHubProvider;

  constructor(
    options: GithubOptions | Record<string, unknown>,
    private readonly appUpdater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(options as GithubOptions, appUpdater, runtimeOptions);
    // The stable feed as the updater sees it with nightlies turned off.
    const stableView = Object.create(appUpdater, {
      channel: { value: "latest" },
      allowPrerelease: { value: false },
    }) as AppUpdater;
    this.stable = new GitHubProvider(options as GithubOptions, stableView, runtimeOptions);
  }

  // Headers the updater sets, such as its staging id, go to both feeds.
  override setRequestHeaders(value: Parameters<GitHubProvider["setRequestHeaders"]>[0]): void {
    super.setRequestHeaders(value);
    this.stable.setRequestHeaders(value);
  }

  override async getLatestVersion(): Promise<Latest> {
    if (!this.appUpdater.allowPrerelease) return super.getLatestVersion();
    const [nightly, stable] = await Promise.allSettled([
      super.getLatestVersion(),
      this.stable.getLatestVersion(),
    ]);
    if (nightly.status === "rejected") {
      if (stable.status === "fulfilled") return stable.value;
      throw nightly.reason;
    }
    if (
      stable.status === "fulfilled" &&
      compareVersions(stable.value.version, nightly.value.version) > 0
    ) {
      return stable.value;
    }
    return nightly.value;
  }
}
