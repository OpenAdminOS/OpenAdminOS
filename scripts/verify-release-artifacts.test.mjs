import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dump as toYaml } from "js-yaml";

const script = fileURLToPath(new URL("./verify-release-artifacts.mjs", import.meta.url));
const hasDpkg = spawnSync("dpkg-deb", ["--version"]).status === 0;
const digest = (bytes) => createHash("sha512").update(bytes).digest("base64");

function fixture(t, { channel = "nightly", linuxManifestIncludesPackages = false, validDeb = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-artifacts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stage = join(root, "staged");
  const version = channel === "nightly" ? "0.7.3-nightly.20261124081056" : "0.8.0";
  const updateChannel = channel === "nightly" ? "nightly" : "latest";
  const base = `OpenAdminOS-${version}`;
  const exe = `${base}-win-x64.exe`;
  const dmg = `${base}-arm64.dmg`;
  const zip = `${base}-arm64-mac.zip`;
  const pkg = `${base}-arm64.pkg`;
  const appImage = `${base}-linux-x86_64.AppImage`;
  const deb = `${base}-linux-amd64.deb`;
  const rpm = `${base}-linux-x86_64.rpm`;
  const platforms = {
    "windows-x64": { manifest: `${updateChannel}.yml`, assets: [exe], entries: [exe] },
    "macos-arm64": {
      manifest: `${updateChannel}-mac.yml`,
      assets: channel === "stable" ? [dmg, zip, pkg] : [dmg, zip],
      entries: [zip, dmg],
    },
    "linux-x64": {
      manifest: `${updateChannel}-linux.yml`,
      assets: [appImage, deb, rpm],
      entries: linuxManifestIncludesPackages ? [appImage, deb, rpm] : [appImage],
    },
  };
  const expected = [];
  const files = {};
  const record = (platform) => execFileSync(process.execPath, [script, "record", channel, version, platform, join(root, platform)]);
  for (const [platform, { manifest, assets, entries }] of Object.entries(platforms)) {
    const dir = join(root, platform);
    mkdirSync(dir);
    for (const name of assets) {
      files[name] = join(dir, name);
      if (name === deb && validDeb) {
        const packageDir = join(root, "deb-source");
        mkdirSync(join(packageDir, "DEBIAN"), { recursive: true });
        writeFileSync(join(packageDir, "DEBIAN", "control"), [
          "Package: openadminos", "Version: 0.8.0", "Architecture: amd64", "Maintainer: Test", "Description: Test package", "",
        ].join("\n"));
        execFileSync("dpkg-deb", ["--build", "--root-owner-group", packageDir, files[name]]);
      } else {
        writeFileSync(files[name], `Fixture bytes for ${name}\n`);
      }
    }
    const updates = entries.map((name) => {
      const bytes = readFileSync(files[name]);
      return { url: name, sha512: digest(bytes), size: bytes.length };
    });
    files[manifest] = join(dir, manifest);
    writeFileSync(files[manifest], toYaml({ version, files: updates, path: entries[0], sha512: updates[0].sha512 }));
    expected.push(...assets, manifest);
    record(platform);
  }

  const prepare = () => spawnSync(process.execPath, [script, "prepare", channel, version, root, stage], { encoding: "utf8" });
  const expectFailure = (message) => {
    const result = prepare();
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
    assert.equal(existsSync(stage), false);
  };
  return { deb, dmg, exe, pkg, appImage, expected, files, prepare, expectFailure, stage };
}

for (const channel of ["stable", "nightly"]) {
  test(`stages exactly the verified ${channel} assets`, { skip: !hasDpkg && "requires dpkg-deb" }, (t) => {
    const { expected, files, prepare, stage, exe } = fixture(t, {
      channel, validDeb: true, linuxManifestIncludesPackages: channel === "stable",
    });
    writeFileSync(`${files[exe]}.blockmap`, "Unpublished blockmap");
    const result = prepare();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(stage).sort(), expected.sort());
  });
}

test("blocks a truncated .deb even when the updater manifest omits it", (t) => {
  const { deb, files, expectFailure } = fixture(t);
  truncateSync(files[deb], 8);
  expectFailure(/::error::.*linux-amd64\.deb SHA-256 mismatch/);
});

test("manual apt backfill verifies the .deb against the stable Linux manifest", (t) => {
  const { deb, files } = fixture(t, { channel: "stable", linuxManifestIncludesPackages: true });
  const directory = dirname(files[deb]);
  const verify = () => spawnSync(process.execPath, [script, "verify-apt", "stable", "0.8.0", directory], { encoding: "utf8" });
  const manifest = files["latest-linux.yml"];
  const bytes = readFileSync(files[deb]);

  const valid = verify();
  assert.equal(valid.status, 0, valid.stderr);

  truncateSync(files[deb], 8);
  const truncated = verify();
  assert.equal(truncated.status, 1, truncated.stderr);
  assert.match(truncated.stderr, /::error::.*linux-amd64\.deb has 8 bytes, expected/);

  bytes[0] ^= 1;
  writeFileSync(files[deb], bytes);
  const corrupted = verify();
  assert.equal(corrupted.status, 1, corrupted.stderr);
  assert.match(corrupted.stderr, /::error::.*linux-amd64\.deb SHA-512 mismatch/);

  rmSync(manifest);
  const missingManifest = verify();
  assert.equal(missingManifest.status, 1, missingManifest.stderr);
  assert.match(missingManifest.stderr, /::error::.*latest-linux\.yml is missing/);
});

test("blocks a missing AppImage even when the nightly .deb is present", (t) => {
  const { appImage, files, expectFailure } = fixture(t);
  rmSync(files[appImage]);
  expectFailure(/::error::.*linux-x86_64\.AppImage is missing/);
});

test("blocks a missing stable macOS PKG", (t) => {
  const { pkg, files, expectFailure } = fixture(t, { channel: "stable" });
  rmSync(files[pkg]);
  expectFailure(/::error::.*arm64\.pkg is missing/);
});

test("blocks a missing nightly Linux update manifest", (t) => {
  const { files, expectFailure } = fixture(t);
  rmSync(files["nightly-linux.yml"]);
  expectFailure(/::error::.*nightly-linux\.yml is missing/);
});

test("checks the manifest's size for a truncated macOS DMG", (t) => {
  const { dmg, files, expectFailure } = fixture(t);
  truncateSync(files[dmg], 8);
  expectFailure(/::error::.*arm64\.dmg has 8 bytes, expected/);
});

test("checks the manifest's SHA-512 for a same-size corrupt Windows installer", (t) => {
  const { exe, files, expectFailure } = fixture(t);
  const bytes = readFileSync(files[exe]);
  bytes[0] ^= 1;
  writeFileSync(files[exe], bytes);
  expectFailure(/::error::.*win-x64\.exe SHA-512 mismatch/);
});

test("checks the digest of the update manifest itself", (t) => {
  const { files, expectFailure } = fixture(t);
  truncateSync(files["nightly-linux.yml"], 16);
  expectFailure(/::error::.*nightly-linux\.yml SHA-256 mismatch/);
});

test("runs dpkg-deb on the verified bytes", { skip: !hasDpkg && "requires dpkg-deb" }, (t) => {
  const { expectFailure } = fixture(t);
  expectFailure(/::error::.*dpkg-deb --info .*linux-amd64\.deb/);
});
