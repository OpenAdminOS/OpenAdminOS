#!/usr/bin/env node
// Work around a Vercel Git Integration finalization bug for projects whose
// configured Root Directory is `web/`. The app builds in web/.next, but the
// finalizer currently lstat()s this manifest at the repository root.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.VERCEL) {
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const repoRoot = join(webRoot, "..");

const source =
  [
    join(webRoot, ".next", "routes-manifest-deterministic.json"),
    join(webRoot, ".next", "routes-manifest.json"),
  ].find((candidate) => existsSync(candidate)) ?? null;

if (!source) {
  console.error(
    "[vercel-root-manifest] no Next routes manifest found under web/.next",
  );
  process.exit(1);
}

const destDir = join(repoRoot, ".next");
const dest = join(destDir, "routes-manifest-deterministic.json");

mkdirSync(destDir, { recursive: true });
copyFileSync(source, dest);

console.log(
  `[vercel-root-manifest] copied ${source} -> ${dest} (${statSync(dest).size} bytes)`,
);
