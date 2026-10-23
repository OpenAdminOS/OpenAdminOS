import type { UpdateChannel, UpdateUnavailableReason } from "@openadminos/agent-sdk";

/** Why the update channel cannot be changed on this install. */
export const UPDATE_UNAVAILABLE_DETAIL: Record<UpdateUnavailableReason, string> = {
  linux:
    "Linux updates come from the apt repository or a manual download; nightly packages are attached to the GitHub prerelease.",
  "windows-store": "Microsoft Store builds update through the Store.",
  development: "Development runs do not update. The channel applies to packaged builds.",
};

/**
 * Nightly builds carry versions such as 0.7.1-nightly.20261023141500: the
 * next patch after the newest stable release, then the UTC build time.
 * Shared by the main process (updater channel defaults) and the renderer
 * (the status strip badge).
 */
export function isNightlyVersion(version: string): boolean {
  return /-nightly\.\d+$/.test(version);
}

/** The updater follows the installed build until the admin picks a channel. */
export function defaultUpdateChannel(version: string): UpdateChannel {
  return isNightlyVersion(version) ? "nightly" : "stable";
}
