#!/usr/bin/env node
// Bump every workspace package.json + cross-workspace dep ref to the next
// version, and roll CHANGELOG.md so the [Unreleased] section becomes a
// dated [X.Y.Z] section with the entries that accumulated since the last
// release.
//
// Inputs (env vars, set by the calling workflow or shell):
//   BUMP_TYPE         "patch" (default) | "minor" | "major"
//   EXPLICIT_VERSION  Optional override like "0.1.5"; takes precedence
//                     over BUMP_TYPE.
//
// Output:
//   - All package.json files in PACKAGES_TO_BUMP (and their workspace
//     dep refs) rewritten in place.
//   - CHANGELOG.md rolled: a new "## [X.Y.Z] - YYYY-MM-DD" section is
//     inserted under "## [Unreleased]", carrying every non-empty entry
//     from the Unreleased section. The Unreleased section is reset to
//     the empty template.
//   - Prints "BUMPED X.Y.Z -> A.B.C" to stdout. Workflows can capture
//     the new version from `node -p 'require("./package.json").version'`
//     after the script runs.
//
// Safety rails:
//   - Refuses to roll if Unreleased contains only empty headers (no
//     real entries). This prevents creating a "no changes" release.
//   - Idempotent: re-running with the same version is a no-op for both
//     package.json (regex won't match) and CHANGELOG (won't double-roll
//     because the version header already exists).
//   - Refuses to roll minor or major unless BUMP_TYPE is explicitly
//     "minor" or "major". Default is "patch" — matches the project's
//     v0.1.x line discipline.

import { readFileSync, writeFileSync } from "node:fs";

const PACKAGES_TO_BUMP = [
  "package.json",
  "apps/desktop/package.json",
  "packages/agent-sdk/package.json",
  "packages/runtime/package.json",
  "packages/qa-graph/package.json",
  "packages/connector-teams/package.json",
];

// Registry agents used to ship as workspace packages with their own
// `package.json` that depended on `@openagents/agent-sdk`. They were
// migrated to pure `manifest.yaml` agents in 3005bc6 ("stats: introduce
// install-tracking pipeline + simplify agent contract"), so they no
// longer need version bumping. If new workspace packages with
// internal-version-pinned deps are added later, list them here.
const PACKAGES_WITH_WORKSPACE_DEPS = [...PACKAGES_TO_BUMP];

const CHANGELOG_PATH = "CHANGELOG.md";

const EMPTY_UNRELEASED_BODY = [
  "### Added",
  "",
  "### Changed",
  "",
  "### Removed",
  "",
  "### Fixed",
  "",
  "### Security",
  "",
].join("\n");

function main() {
  const rootPkg = JSON.parse(readFileSync("package.json", "utf8"));
  const current = rootPkg.version;
  const bumpType = (process.env.BUMP_TYPE ?? "patch").trim();
  const explicit = (process.env.EXPLICIT_VERSION ?? "").trim();

  const next = explicit || bumpVersion(current, bumpType);
  if (!/^\d+\.\d+\.\d+(-[\w.-]+)?$/.test(next)) {
    fail(`Computed next version "${next}" is not a valid semver.`);
  }
  if (compare(current, next) >= 0) {
    fail(`Computed next version "${next}" is not strictly greater than current "${current}".`);
  }

  rollChangelog(current, next);
  bumpPackages(current, next);

  process.stdout.write(`BUMPED ${current} -> ${next}\n`);
}

function bumpVersion(current, type) {
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) fail(`Current version "${current}" is not parseable as semver.`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);

  switch (type) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
    default:
      fail(
        `Unknown BUMP_TYPE "${type}". Use "patch" (default), "minor", or "major", or set EXPLICIT_VERSION.`,
      );
      return current; // unreachable, satisfies TS-style flow
  }
}

function compare(a, b) {
  const pa = a.split(".").map((s) => Number(s.split("-")[0]));
  const pb = b.split(".").map((s) => Number(s.split("-")[0]));
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function bumpPackages(current, next) {
  const currentEscaped = current.replace(/\./g, "\\.");

  for (const file of PACKAGES_TO_BUMP) {
    let text = readFileSync(file, "utf8");
    const before = text;
    text = text.replace(
      new RegExp(`"version": "${currentEscaped}"`),
      `"version": "${next}"`,
    );
    if (text === before) {
      fail(`Could not bump version in ${file}. Expected "${current}", not found.`);
    }
    writeFileSync(file, text);
  }

  for (const file of PACKAGES_WITH_WORKSPACE_DEPS) {
    let text = readFileSync(file, "utf8");
    text = text.replace(
      new RegExp(`("@openagents/[a-z-]+": ")${currentEscaped}"`, "g"),
      `$1${next}"`,
    );
    writeFileSync(file, text);
  }
}

function rollChangelog(current, next) {
  const original = readFileSync(CHANGELOG_PATH, "utf8");

  const unreleasedMatch = original.match(/## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/);
  if (!unreleasedMatch) {
    fail(`Could not find a [Unreleased] section in ${CHANGELOG_PATH}.`);
  }

  const body = unreleasedMatch[1].trim();
  if (!hasRealEntries(body)) {
    fail(
      `CHANGELOG.md [Unreleased] has no real entries — refusing to cut a "no changes" release.\n` +
      `Add at least one bullet under Added/Changed/Removed/Fixed/Security before rolling.`,
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const newSection = [
    "## [Unreleased]",
    "",
    EMPTY_UNRELEASED_BODY,
    `## [${next}] - ${today}`,
    "",
    body,
    "",
  ].join("\n");

  const replaced = original.replace(/## \[Unreleased\]\n[\s\S]*?(?=\n## \[)/, newSection);
  writeFileSync(CHANGELOG_PATH, replaced);
}

function hasRealEntries(body) {
  // A "real entry" is a bullet line (starts with "- ") under any of the
  // five subsection headers. Empty subsections (just the heading and a
  // blank line) don't count.
  for (const line of body.split("\n")) {
    if (line.startsWith("- ")) return true;
  }
  return false;
}

function fail(message) {
  process.stderr.write(`prepare-release: ${message}\n`);
  process.exit(1);
}

main();
