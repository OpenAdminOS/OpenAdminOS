#!/usr/bin/env node
/**
 * Decides the version and tag of a release from the repository's tags.
 *
 *   node scripts/release-version.mjs nightly <package version> <YYYYMMDDHHMMSS, UTC> [tags...]
 *   node scripts/release-version.mjs stable <version>
 *
 * Nightlies preview the next stable version: the package version while it has
 * not shipped yet, otherwise the patch after the newest stable tag. The build
 * time is one fixed-width number, so nightlies sort the same by text (GitHub's
 * release page) and by semver (electron-updater), and every nightly sorts
 * below the stable release it previews.
 *
 * Prints JSON: { version, tag, prerelease }.
 */

import { pathToFileURL } from "node:url";

const STABLE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
export const NIGHTLY_VERSION = /^\d+\.\d+\.\d+-nightly\.2\d{13}$/;

export function nextNightly(packageVersion, timestamp, tags) {
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    throw new Error(`Invalid package version ${packageVersion}`);
  }
  if (!/^2\d{13}$/.test(String(timestamp))) {
    throw new Error(`Invalid build time ${timestamp}, expected YYYYMMDDHHMMSS`);
  }
  const newestStable = tags
    .map((tag) => STABLE_TAG.exec(tag))
    .filter(Boolean)
    .map((match) => match.slice(1, 4).map(Number))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .pop();
  const pkg = packageVersion.split(".").map(Number);
  const shipped =
    newestStable !== undefined &&
    (newestStable[0] > pkg[0] ||
      (newestStable[0] === pkg[0] &&
        (newestStable[1] > pkg[1] || (newestStable[1] === pkg[1] && newestStable[2] >= pkg[2]))));
  const base = shipped
    ? `${newestStable[0]}.${newestStable[1]}.${newestStable[2] + 1}`
    : packageVersion;
  const version = `${base}-nightly.${timestamp}`;
  return { version, tag: `v${version}`, prerelease: true };
}

export function stable(version) {
  const clean = String(version).replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(clean)) {
    throw new Error(`A stable version looks like 1.2.3, not ${version}`);
  }
  return { version: clean, tag: `v${clean}`, prerelease: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [channel, ...args] = process.argv.slice(2);
  const result =
    channel === "nightly" ? nextNightly(args[0], args[1], args.slice(2)) : stable(args[0]);
  console.log(JSON.stringify(result));
}
