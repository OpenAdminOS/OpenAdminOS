#!/usr/bin/env node
// Copies the canonical stats/agents.json (repo root) into web/public/stats/
// so Next.js serves it as a static asset at /stats/agents.json. Runs before
// every `vercel dev` and `next build` via package.json hooks.
//
// Why a script and not a build-time JSON import: keeping the file as a real
// static asset means the desktop can fetch it directly without going through
// a serverless function, and Vercel's edge cache serves it for free.

import { existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const repoRoot = join(webRoot, "..");

const src = join(repoRoot, "stats", "agents.json");
const destDir = join(webRoot, "public", "stats");
const dest = join(destDir, "agents.json");

if (!existsSync(src)) {
  console.error(`[sync-stats] missing ${src}`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);

const size = statSync(dest).size;
console.log(`[sync-stats] ${src} -> ${dest} (${size} bytes)`);
