#!/usr/bin/env node
/**
 * Writes the Markdown notes of a nightly prerelease to stdout:
 *
 *   node scripts/nightly-release-notes.mjs <tag> <sha> <assets dir>
 *
 * The notes list what changed on main since the previous release of either
 * channel, the current [Unreleased] section of CHANGELOG.md, and the
 * installers in the assets directory. Install-stats commits are left out.
 * Needs a full clone (fetch-depth 0) with tags, and GITHUB_REPOSITORY.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Turns `git log --first-parent --format=%H%x09%s` lines into list items.
 * `bodies` maps a merge commit hash to its body, where GitHub puts the pull
 * request title.
 */
export function formatChanges(logLines, bodies, repo) {
  const pr = (number) => `[#${number}](https://github.com/${repo}/pull/${number})`;
  const items = [];
  for (const line of logLines) {
    if (!line) continue;
    const [hash, ...rest] = line.split("\t");
    const subject = rest.join("\t");
    if (/^stats: /.test(subject)) continue;
    const merge = /^Merge pull request #(\d+)/.exec(subject);
    if (merge) {
      const title = (bodies.get(hash) ?? "").split("\n").find((text) => text.trim() !== "");
      items.push(`- ${title?.trim() || subject} (${pr(merge[1])})`);
      continue;
    }
    if (/^Merge /.test(subject)) continue;
    const squash = /^(.*?)\s*\(#(\d+)\)$/.exec(subject);
    if (squash) {
      items.push(`- ${squash[1]} (${pr(squash[2])})`);
      continue;
    }
    items.push(`- ${subject} ([${hash.slice(0, 7)}](https://github.com/${repo}/commit/${hash}))`);
  }
  return items;
}

/**
 * Returns the body of the `## [Unreleased]` section, without headings that
 * have no entries under them.
 */
export function unreleasedSection(changelog) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => /^## \[Unreleased\]/i.test(line));
  if (start === -1) return "";
  const end = lines.findIndex((line, index) => index > start && /^## \[/.test(line));
  const body = lines.slice(start + 1, end === -1 ? undefined : end);

  // Split into blocks that each start at a "### " heading, keep the blocks
  // with entries, and demote the headings below the notes' own "##" level.
  const blocks = [];
  for (const line of body) {
    if (/^### /.test(line) || blocks.length === 0) blocks.push([]);
    blocks[blocks.length - 1].push(line);
  }
  return blocks
    .filter((block) => block.some((line) => line.trim() !== "" && !/^### /.test(line)))
    .map((block) => block.map((line) => (/^### /.test(line) ? `#${line}` : line)).join("\n").trim())
    .join("\n\n");
}

const INSTALLERS = [
  [/\.dmg$/, "macOS (Apple silicon), disk image"],
  [/-win-x64\.exe$/, "Windows x64, installer"],
  [/\.AppImage$/, "Linux x64, AppImage"],
  [/\.deb$/, "Linux x64, .deb"],
  [/\.rpm$/, "Linux x64, .rpm"],
];

export function downloadsTable(files, baseUrl) {
  const rows = [];
  for (const [pattern, label] of INSTALLERS) {
    const file = files.find((name) => pattern.test(name));
    if (file) rows.push(`| ${label} | [\`${file}\`](${baseUrl}/${file}) |`);
  }
  if (rows.length === 0) return "";
  return ["| Platform | File |", "|---|---|", ...rows].join("\n");
}

export function buildNotes({ tag, sha, previous, changes, unreleased, downloads, repo }) {
  const sections = [
    `Nightly build of \`main\` at [\`${sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${sha}). Nightly builds are signed like stable releases but get less testing. Installed nightlies update to newer nightlies and to newer stable releases. Turn nightly builds on or off in Settings > About.`,
  ];
  if (changes.length > 0) {
    const heading = previous ? `## Changes since ${previous}` : "## Changes";
    const compare = previous
      ? `\n\n[Compare with ${previous}](https://github.com/${repo}/compare/${previous}...${tag})`
      : "";
    sections.push(`${heading}\n\n${changes.join("\n")}${compare}`);
  }
  if (unreleased) {
    sections.push(`## Unreleased changelog\n\n${unreleased}`);
  }
  if (downloads) {
    sections.push(`## Downloads\n\n${downloads}\n\nLinux packages are attached here only. The apt repository carries stable releases.`);
  }
  return `${sections.join("\n\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [tag, sha, assetsDir] = process.argv.slice(2);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!tag || !/^[0-9a-f]{40}$/.test(sha ?? "") || !assetsDir || !repo) {
    throw new Error("Usage: GITHUB_REPOSITORY=owner/repo nightly-release-notes.mjs <tag> <sha> <assets dir>");
  }

  let previous = "";
  try {
    previous = git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", sha);
  } catch {
    previous = "";
  }
  const range = previous ? [`${previous}..${sha}`] : ["-n", "100", sha];
  const log = git("log", "--first-parent", "--format=%H%x09%s", ...range).split("\n");
  const bodies = new Map();
  for (const line of log) {
    const [hash, subject = ""] = line.split("\t");
    if (/^Merge pull request #/.test(subject)) bodies.set(hash, git("log", "-1", "--format=%b", hash));
  }

  process.stdout.write(
    buildNotes({
      tag,
      sha,
      previous,
      changes: formatChanges(log, bodies, repo),
      unreleased: unreleasedSection(readFileSync("CHANGELOG.md", "utf8")),
      downloads: downloadsTable(
        readdirSync(assetsDir).sort(),
        `https://github.com/${repo}/releases/download/${tag}`,
      ),
      repo,
    }),
  );
}
