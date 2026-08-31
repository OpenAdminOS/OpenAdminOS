#!/usr/bin/env node
// Materialise the canonical model/site/public-data.json into
// web/src/data/training/ so Next.js can validate and render it at build time.
// Two paths, matching sync-stats.mjs:
//
//   1. Local dev: copy the sibling repository file directly.
//
//   2. Vercel build: fetch the file from GitHub at the exact deployed
//      commit SHA using the existing bot PAT environment variables.

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
const destDir = join(webRoot, "src", "data", "training");
const dest = join(destDir, "public-data.json");

mkdirSync(destDir, { recursive: true });

const localSrc = join(webRoot, "..", "model", "site", "public-data.json");
if (existsSync(localSrc)) {
  copyFileSync(localSrc, dest);
  console.log(
    `[sync-training-data] copied ${localSrc} -> ${dest} (${statSync(dest).size} bytes)`,
  );
  process.exit(0);
}

const token = process.env.OPENAGENTS_GITHUB_TOKEN;
const owner = process.env.OPENAGENTS_GITHUB_OWNER ?? "ugurkocde";
const repo = process.env.OPENAGENTS_GITHUB_REPO ?? "OpenAdminOS";
const ref =
  process.env.VERCEL_GIT_COMMIT_SHA ??
  process.env.OPENAGENTS_GITHUB_BRANCH ??
  "main";

if (!token) {
  console.error(
    "[sync-training-data] no local model/site/public-data.json AND no OPENAGENTS_GITHUB_TOKEN: cannot resolve.",
  );
  process.exit(1);
}

const path = "model/site/public-data.json";
const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
console.log(
  `[sync-training-data] fetching ${owner}/${repo}@${ref.slice(0, 7)} ${path}`,
);

const response = await fetch(url, {
  headers: {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github.raw",
    "x-github-api-version": "2022-11-28",
    "user-agent": "openadminos-training-data-sync",
  },
});

if (!response.ok) {
  const detail = await response.text().catch(() => "");
  console.error(
    `[sync-training-data] GitHub fetch failed: ${response.status} ${response.statusText} ${detail.slice(0, 200)}`,
  );
  process.exit(1);
}

const body = await response.text();
writeFileSync(dest, body);
console.log(
  `[sync-training-data] wrote ${dest} (${statSync(dest).size} bytes)`,
);
