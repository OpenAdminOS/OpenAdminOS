#!/usr/bin/env node
/**
 * Turns a checkout into a nightly build before `npm run dist`:
 *
 *   node scripts/prepare-nightly-build.mjs <X.Y.Z-nightly.YYYYMMDDHHMMSS>
 *
 * - Sets the desktop package version, which electron-builder, app.getVersion()
 *   and the renderer's __APP_VERSION__ all read.
 * - Sets the GitHub publish channel to "nightly", so the build writes
 *   nightly.yml / nightly-mac.yml / nightly-linux.yml instead of latest*.yml.
 *   electron-builder only infers the channel from a prerelease version for
 *   generic providers, not for GitHub, so it has to be explicit.
 * - Drops the macOS .pkg target. The pkg exists for MDM deployment of stable
 *   releases; nightly testers install the .dmg and update through the .zip.
 *
 * Runs after `npm ci` in the release workflow and is never committed. The
 * workspace dependency versions stay untouched so the installed tree still
 * matches the lockfile.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NIGHTLY_VERSION } from "./release-version.mjs";

const DESKTOP_DIR = "apps/desktop";

export function applyNightly(desktopPackage, lockfile, version) {
  if (!NIGHTLY_VERSION.test(version)) {
    throw new Error(`Expected a nightly version like 0.7.1-nightly.20261023141500, got ${version}`);
  }
  const build = desktopPackage.build;
  if (!Array.isArray(build?.publish) || build.publish.length === 0) {
    throw new Error("apps/desktop/package.json build.publish must list the GitHub publisher.");
  }

  const nextPackage = {
    ...desktopPackage,
    version,
    build: {
      ...build,
      publish: build.publish.map((entry) => ({ ...entry, channel: "nightly" })),
      mac: {
        ...build.mac,
        target: build.mac.target.filter((entry) => entry.target !== "pkg"),
      },
    },
  };

  const desktopLock = lockfile.packages?.[DESKTOP_DIR];
  if (!desktopLock) {
    throw new Error(`package-lock.json has no entry for ${DESKTOP_DIR}.`);
  }
  const nextLockfile = {
    ...lockfile,
    packages: {
      ...lockfile.packages,
      [DESKTOP_DIR]: { ...desktopLock, version },
    },
  };

  return { desktopPackage: nextPackage, lockfile: nextLockfile };
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const version = process.argv[2] ?? "";
  const packagePath = join(DESKTOP_DIR, "package.json");
  const result = applyNightly(
    JSON.parse(readFileSync(packagePath, "utf8")),
    JSON.parse(readFileSync("package-lock.json", "utf8")),
    version,
  );
  writeJson(packagePath, result.desktopPackage);
  writeJson("package-lock.json", result.lockfile);
  console.log(`Prepared nightly build ${version} on the "nightly" update channel.`);
}
