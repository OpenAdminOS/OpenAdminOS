#!/usr/bin/env node
// Materialise repo-root data the site needs at build time:
//
//   - stats/agents.json -> web/public/stats/agents.json, served as a static
//     asset at /stats/agents.json.
//   - agents/index.json -> web/src/generated/registry-index.json, imported by
//     the homepage so registry names, modes, scopes, and the agent count come
//     from the registry itself instead of a hand-kept copy.
//
// Two paths for each file:
//
//   1. Local dev: the canonical file lives in the repo next to the `web/`
//      folder, so we just copy it.
//
//   2. Vercel build: Vercel's "Root Directory = web/" setting excludes
//      sibling folders from the build sandbox, so they aren't available. We
//      fall back to fetching the file from GitHub at the exact deployed
//      commit SHA (VERCEL_GIT_COMMIT_SHA) using the bot PAT we already have
//      wired up. That keeps the build slim and ensures the file matches the
//      commit being deployed.

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

const FILES = [
  {
    source: "stats/agents.json",
    dest: join(webRoot, "public", "stats", "agents.json"),
  },
  {
    source: "agents/index.json",
    dest: join(webRoot, "src", "generated", "registry-index.json"),
  },
];

const token = process.env.OPENAGENTS_GITHUB_TOKEN;
const owner = process.env.OPENAGENTS_GITHUB_OWNER ?? "ugurkocde";
const repo = process.env.OPENAGENTS_GITHUB_REPO ?? "OpenAdminOS";
const ref =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.OPENAGENTS_GITHUB_BRANCH ??
  "main";

for (const { source, dest } of FILES) {
  mkdirSync(dirname(dest), { recursive: true });

  const localSrc = join(webRoot, "..", source);
  if (existsSync(localSrc)) {
    copyFileSync(localSrc, dest);
    console.log(`[sync-stats] copied ${localSrc} -> ${dest} (${statSync(dest).size} bytes)`);
    continue;
  }

  if (!token) {
    console.error(
      `[sync-stats] no local ${source} AND no OPENAGENTS_GITHUB_TOKEN, cannot resolve.`,
    );
    process.exit(1);
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${source}?ref=${ref}`;
  console.log(`[sync-stats] fetching ${owner}/${repo}@${ref.slice(0, 7)} ${source}`);

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
      `[sync-stats] GitHub fetch failed for ${source}: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
    );
    process.exit(1);
  }

  writeFileSync(dest, await response.text());
  console.log(`[sync-stats] wrote ${dest} (${statSync(dest).size} bytes)`);
}
