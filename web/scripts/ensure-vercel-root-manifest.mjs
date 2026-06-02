#!/usr/bin/env node
// Work around a Vercel Git Integration finalization bug for projects whose
// configured Root Directory is `web/`. The app builds in web/.next, but the
// finalizer currently lstat()s Next build files at the repository root.

import {
  copyFileSync,
  cpSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.VERCEL) {
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const repoRoot = join(webRoot, "..");
const webNextRoot = join(webRoot, ".next");
const repoNextRoot = join(repoRoot, ".next");
const webNodeModules = join(webRoot, "node_modules");
const repoNodeModules = join(repoRoot, "node_modules");

if (!existsSync(webNextRoot)) {
  console.error(
    "[vercel-root-manifest] no Next build output found under web/.next",
  );
  process.exit(1);
}

rmSync(repoNextRoot, { recursive: true, force: true });
cpSync(webNextRoot, repoNextRoot, { recursive: true });

if (!existsSync(repoNodeModules) && existsSync(webNodeModules)) {
  symlinkSync("web/node_modules", repoNodeModules, "dir");
}

if (!existsSync(join(repoNextRoot, "routes-manifest-deterministic.json"))) {
  const routesManifest = join(repoNextRoot, "routes-manifest.json");
  if (existsSync(routesManifest)) {
    copyFileSync(
      routesManifest,
      join(repoNextRoot, "routes-manifest-deterministic.json"),
    );
  }
}

const requiredFiles = [
  "routes-manifest-deterministic.json",
  "server/pages-manifest.json",
  "server/prefetch-hints.json",
];
const missingFiles = requiredFiles.filter(
  (filePath) => !existsSync(join(repoNextRoot, filePath)),
);

if (missingFiles.length > 0) {
  console.error(
    `[vercel-root-manifest] missing mirrored Next files: ${missingFiles.join(", ")}`,
  );
  process.exit(1);
}

const requiredNodeFiles = ["next/dist/build/adapter/setup-node-env.external.js"];
const missingNodeFiles = requiredNodeFiles.filter(
  (filePath) => !existsSync(join(repoNodeModules, filePath)),
);

if (missingNodeFiles.length > 0) {
  console.error(
    `[vercel-root-manifest] missing repo-root node_modules files: ${missingNodeFiles.join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `[vercel-root-manifest] mirrored Next build output to ${repoNextRoot} and linked repo-root node_modules`,
);
