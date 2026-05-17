#!/usr/bin/env node
// Materialise the canonical stats/agents.json into web/public/stats/ so
// Next.js serves it as a static asset at /stats/agents.json. Two paths:
//
//   1. Local dev — the canonical file lives at `<repo>/stats/agents.json`
//      next to the `web/` folder, so we just copy it.
//
//   2. Vercel build — Vercel's "Root Directory = web/" setting excludes
//      sibling folders from the build sandbox, so `../stats/` isn't
//      available. We fall back to fetching the file from GitHub at the
//      exact deployed commit SHA (VERCEL_GIT_COMMIT_SHA) using the bot
//      PAT we already have wired up. That keeps the build slim and
//      ensures the file matches the commit being deployed.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const destDir = join(webRoot, "public", "stats");
const dest = join(destDir, "agents.json");

mkdirSync(destDir, { recursive: true });

const localSrc = join(webRoot, "..", "stats", "agents.json");
if (existsSync(localSrc)) {
  copyFileSync(localSrc, dest);
  console.log(`[sync-stats] copied ${localSrc} -> ${dest} (${statSync(dest).size} bytes)`);
  process.exit(0);
}

const token = process.env.OPENAGENTS_GITHUB_TOKEN;
const owner = process.env.OPENAGENTS_GITHUB_OWNER ?? "ugurkocde";
const repo = process.env.OPENAGENTS_GITHUB_REPO ?? "OpenAgents";
const ref =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.OPENAGENTS_GITHUB_BRANCH ??
  "main";

if (!token) {
  console.error(
    "[sync-stats] no local stats/agents.json AND no OPENAGENTS_GITHUB_TOKEN — cannot resolve.",
  );
  process.exit(1);
}

const url = `https://api.github.com/repos/${owner}/${repo}/contents/stats/agents.json?ref=${ref}`;
console.log(`[sync-stats] fetching ${owner}/${repo}@${ref.slice(0, 7)} stats/agents.json`);

const response = await fetch(url, {
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github.raw",
    "x-github-api-version": "2022-11-28",
    "user-agent": "openagents-stats-sync",
  },
});

if (!response.ok) {
  const detail = await response.text().catch(() => "");
  console.error(
    `[sync-stats] GitHub fetch failed: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
  );
  process.exit(1);
}

const body = await response.text();
writeFileSync(dest, body);
console.log(`[sync-stats] wrote ${dest} (${statSync(dest).size} bytes)`);
