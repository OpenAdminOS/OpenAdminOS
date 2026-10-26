import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { applyNightly } from "./prepare-nightly-build.mjs";
import {
  buildNotes,
  downloadsTable,
  formatChanges,
  unreleasedSection,
} from "./nightly-release-notes.mjs";
import { NIGHTLY_VERSION, nextNightly, stable } from "./release-version.mjs";

test("nightlies preview the package version until it ships, then the next patch", () => {
  assert.deepEqual(nextNightly("0.7.0", "20261023141500", []), {
    version: "0.7.0-nightly.20261023141500",
    tag: "v0.7.0-nightly.20261023141500",
    prerelease: true,
  });
  assert.equal(
    nextNightly("0.7.0", "20261023141500", ["v0.7.0", "v0.7.1-nightly.20261022000000", "docs-index"]).version,
    "0.7.1-nightly.20261023141500",
  );
  assert.equal(
    nextNightly("0.7.0", "20261023141500", ["v0.7.2", "v0.7.10", "v0.7.9"]).version,
    "0.7.11-nightly.20261023141500",
  );
  assert.equal(nextNightly("0.8.0", "20261023141500", ["v0.7.0"]).version, "0.8.0-nightly.20261023141500");
  assert.throws(() => nextNightly("0.7.0", "20261023", []));
  assert.throws(() => nextNightly("0.7.0-rc.1", "20261023141500", []));
});

test("nightly tags sort the same by text as by build time", () => {
  const tags = ["20261023090000", "20261023100000", "20261101000000"].map(
    (time) => nextNightly("0.7.0", time, ["v0.7.0"]).tag,
  );
  assert.deepEqual([...tags].sort(), tags);
  for (const tag of tags) assert.match(tag.slice(1), NIGHTLY_VERSION);
});

test("stable releases accept only plain versions", () => {
  assert.deepEqual(stable("v0.7.1"), { version: "0.7.1", tag: "v0.7.1", prerelease: false });
  assert.throws(() => stable("0.7.1-nightly.20261023141500"));
  assert.throws(() => stable("main"));
});

test("a nightly build sets the version and nightly channel and drops the pkg target", () => {
  const desktopPackage = JSON.parse(readFileSync("apps/desktop/package.json", "utf8"));
  const lockfile = {
    packages: { "": { version: "0.7.0" }, "apps/desktop": { name: "@openadminos/desktop", version: "0.7.0" } },
  };
  const result = applyNightly(desktopPackage, lockfile, "0.7.1-nightly.20261023141500");

  assert.equal(result.desktopPackage.version, "0.7.1-nightly.20261023141500");
  assert.deepEqual(
    result.desktopPackage.build.publish.map((entry) => entry.channel),
    desktopPackage.build.publish.map(() => "nightly"),
  );
  assert.equal(result.desktopPackage.build.publish[0].owner, "OpenAdminOS");
  assert.deepEqual(
    result.desktopPackage.build.mac.target.map((entry) => entry.target),
    ["dmg", "zip"],
  );
  assert.deepEqual(result.desktopPackage.dependencies, desktopPackage.dependencies);
  assert.equal(result.lockfile.packages["apps/desktop"].version, "0.7.1-nightly.20261023141500");
  assert.equal(result.lockfile.packages[""].version, "0.7.0");
  // The input objects stay untouched.
  assert.equal(desktopPackage.build.publish[0].channel, undefined);

  assert.throws(() => applyNightly(desktopPackage, lockfile, "0.7.1"));
  assert.throws(() => applyNightly(desktopPackage, { packages: {} }, "0.7.1-nightly.20261023141500"));
});

test("nightly notes list pull requests and commits, without install-stats commits", () => {
  const repo = "OpenAdminOS/OpenAdminOS";
  const lines = [
    "a".repeat(40) + "\tMerge pull request #98 from OpenAdminOS/feature/nightly",
    "b".repeat(40) + "\tstats: +6 installs",
    "c".repeat(40) + "\tui: midnight theme (#97)",
    "d".repeat(40) + "\tdocs: fix typo",
    "e".repeat(40) + "\tMerge branch 'main' into release",
    "",
  ];
  const bodies = new Map([["a".repeat(40), "\nAdd a nightly update channel\n"]]);
  assert.deepEqual(formatChanges(lines, bodies, repo), [
    `- Add a nightly update channel ([#98](https://github.com/${repo}/pull/98))`,
    `- ui: midnight theme ([#97](https://github.com/${repo}/pull/97))`,
    `- docs: fix typo ([ddddddd](https://github.com/${repo}/commit/${"d".repeat(40)}))`,
  ]);
});

test("the unreleased section drops empty headings", () => {
  const changelog = [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "### Added",
    "",
    "- Nightly update channel.",
    "",
    "### Changed",
    "",
    "### Fixed",
    "",
    "- Something.",
    "",
    "## [0.7.0] - 2026-10-12",
    "",
    "### Added",
    "- Old entry.",
  ].join("\n");
  assert.equal(
    unreleasedSection(changelog),
    "#### Added\n\n- Nightly update channel.\n\n#### Fixed\n\n- Something.",
  );
  assert.equal(unreleasedSection("# Changelog\n"), "");
});

test("the downloads table links the installers that were built", () => {
  const base = "https://github.com/OpenAdminOS/OpenAdminOS/releases/download/v0.7.1-nightly.20261023141500";
  const table = downloadsTable(
    [
      "OpenAdminOS-0.7.1-nightly.20261023141500-arm64-mac.zip",
      "OpenAdminOS-0.7.1-nightly.20261023141500-arm64.dmg",
      "OpenAdminOS-0.7.1-nightly.20261023141500-win-x64.exe",
      "nightly.yml",
    ],
    base,
  );
  assert.match(table, /\| macOS \(Apple silicon\), disk image \| \[`OpenAdminOS-0\.7\.1-nightly\.20261023141500-arm64\.dmg`\]/);
  assert.match(table, /Windows x64, installer/);
  assert.doesNotMatch(table, /mac\.zip|nightly\.yml|Linux/);
  assert.equal(downloadsTable([], base), "");

  const notes = buildNotes({
    tag: "v0.7.1-nightly.20261023141500",
    sha: "f".repeat(40),
    previous: "v0.7.0",
    changes: ["- one"],
    unreleased: "",
    downloads: table,
    repo: "OpenAdminOS/OpenAdminOS",
  });
  assert.match(notes, /## Changes since v0\.7\.0\n\n- one/);
  assert.match(notes, /compare\/v0\.7\.0\.\.\.v0\.7\.1-nightly\.20261023141500/);
  assert.doesNotMatch(notes, /Unreleased changelog/);
  assert.doesNotMatch(notes, /\u2014|\u2013/);
});

test("nightly-app-changes lists app paths and skips commits a release already contains", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const script = resolve("scripts/nightly-app-changes.sh");
  const repo = mkdtempSync(join(tmpdir(), "nightly-app-changes-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const changes = (commit) =>
    execFileSync("bash", [script, commit], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = (path, message) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), message);
    git("add", "-A");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    commit("apps/a.ts", "base");
    git("tag", "v0.7.0");
    assert.equal(changes("HEAD"), "");

    const a = commit("apps/a.ts", "app change A");
    commit("stats/agents.json", "stats: +1 install");
    commit("README.md", "docs");
    const b = commit("packages/b.ts", "app change B");
    assert.equal(changes(a), "apps/a.ts");
    assert.equal(changes(b), "apps/a.ts\npackages/b.ts");

    // B publishes first. A, dispatched earlier but started later, has nothing to ship.
    git("tag", "v0.7.1-nightly.20261023150000", b);
    assert.equal(changes(a), "");
    assert.equal(changes(b), "");

    // Only stats and docs after the newest nightly: nothing to ship.
    const stats = commit("stats/agents.json", "stats: +2 installs");
    assert.equal(changes(stats), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("nightly-app-changes ignores contributor tooling, npm scripts, and linguist attributes", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const script = resolve("scripts/nightly-app-changes.sh");
  const repo = mkdtempSync(join(tmpdir(), "nightly-app-tooling-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const changes = (commit) =>
    execFileSync("bash", [script, commit], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  const commit = (path, content) => {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
    git("add", "-A");
    git("commit", "-qm", `change ${path}`);
    return git("rev-parse", "HEAD");
  };
  const manifest = (scripts, version = "0.7.2") =>
    `${JSON.stringify({ name: "openadminos", version, scripts }, null, 2)}\n`;
  const nightly = (sha) => git("tag", `v0.7.3-nightly.${sha.slice(0, 8)}`, sha);
  try {
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    commit("package.json", manifest({ build: "npm run build -w app", test: "node --test" }));
    commit(".gitattributes", "agents/index.json text eol=lf\n");
    git("tag", "v0.7.2");

    commit("scripts/smoke-chat.mjs", "smoke");
    commit("scripts/release-scripts.test.mjs", "test");
    commit("scripts/capture-screenshots.mjs", "capture");
    commit("scripts/generate-gitbook-docs.mjs", "docs");
    commit("scripts/nightly-app-changes.sh", "filter");
    commit("scripts/nightly-release-notes.mjs", "notes");
    commit("scripts/prepare-release.mjs", "prep");
    commit("scripts/check-release-compatibility.mjs", "check");
    commit("package.json", manifest({ build: "npm run build -w app", test: "node --test", "docs:check": "x" }));
    const tooling = commit(".gitattributes", "agents/index.json text eol=lf\nweb/content/** linguist-generated=true\n");
    assert.equal(changes(tooling), "");

    const buildScript = commit("package.json", manifest({ build: "npm run build -w app -- --x", test: "node --test", "docs:check": "x" }));
    assert.equal(changes(buildScript), "package.json");
    nightly(buildScript);

    const eol = commit(".gitattributes", "agents/index.json text eol=crlf\nweb/content/** linguist-generated=true\n");
    assert.equal(changes(eol), ".gitattributes");
    nightly(eol);

    const newScript = commit("scripts/build-helper.mjs", "build");
    assert.equal(changes(newScript), "scripts/build-helper.mjs");
    nightly(newScript);

    // Nightly builds patch the app with this script, so it still counts.
    const nightlyBuild = commit("scripts/prepare-nightly-build.mjs", "patch");
    assert.equal(changes(nightlyBuild), "scripts/prepare-nightly-build.mjs");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
