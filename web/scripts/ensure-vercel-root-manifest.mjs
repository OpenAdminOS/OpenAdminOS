#!/usr/bin/env node
// Work around a Vercel Git Integration finalization bug for projects whose
// configured Root Directory is `web/`. The app builds in web/.next, but the
// finalizer currently lstat()s Next manifest files at the repository root.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.VERCEL) {
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const repoRoot = join(webRoot, "..");
const webNextRoot = join(webRoot, ".next");
const repoNextRoot = join(repoRoot, ".next");

if (!existsSync(webNextRoot)) {
  console.error(
    "[vercel-root-manifest] no Next build output found under web/.next",
  );
  process.exit(1);
}

const copied = [];

function copyManifest(relativePath, targetRelativePath = relativePath) {
  const source = join(webNextRoot, relativePath);
  if (!existsSync(source)) return;

  const dest = join(repoNextRoot, targetRelativePath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  copied.push(`${targetRelativePath} (${statSync(dest).size} bytes)`);
}

for (const entry of readdirSync(webNextRoot, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  if (
    entry.name.endsWith("-manifest.json") ||
    entry.name === "required-server-files.json"
  ) {
    copyManifest(entry.name);
  }
}

const serverRoot = join(webNextRoot, "server");
if (existsSync(serverRoot)) {
  const queue = [serverRoot];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.includes("manifest")) continue;
      copyManifest(relative(webNextRoot, fullPath));
    }
  }
}

copyManifest("routes-manifest-deterministic.json");
if (!existsSync(join(repoNextRoot, "routes-manifest-deterministic.json"))) {
  copyManifest("routes-manifest.json", "routes-manifest-deterministic.json");
}

if (copied.length === 0) {
  console.error("[vercel-root-manifest] no Next manifest files were mirrored");
  process.exit(1);
}

console.log(
  `[vercel-root-manifest] mirrored ${copied.length} manifest files to ${repoNextRoot}`,
);
