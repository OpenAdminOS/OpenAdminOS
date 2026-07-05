#!/usr/bin/env node
// Work around a Vercel Git Integration finalization bug for projects whose
// configured Root Directory is `web/`. The app builds in web/.next, but the
// finalizer currently lstat()s Next build files at the repository root.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  rmSync,
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
const webNodeModules = join(webRoot, "node_modules");
const repoNodeModules = join(repoRoot, "node_modules");
const webContentRoot = join(webRoot, "content");
const repoContentRoot = join(repoRoot, "content");
const webPublicRoot = join(webRoot, "public");
const repoPublicRoot = join(repoRoot, "public");

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

linkMissingTracedNodePackages();

if (!existsSync(repoContentRoot) && existsSync(webContentRoot)) {
  symlinkSync("web/content", repoContentRoot, "dir");
}

if (!existsSync(repoPublicRoot) && existsSync(webPublicRoot)) {
  symlinkSync("web/public", repoPublicRoot, "dir");
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

function linkMissingTracedNodePackages() {
  if (!existsSync(repoNextRoot) || !existsSync(webNodeModules)) {
    return;
  }

  for (const packageName of collectTracedNodePackages(repoNextRoot)) {
    const repoPackagePath = join(repoNodeModules, packageName);
    const webPackagePath = join(webNodeModules, packageName);

    if (existsSync(repoPackagePath) || !existsSync(webPackagePath)) {
      continue;
    }

    mkdirSync(dirname(repoPackagePath), { recursive: true });
    symlinkSync(
      relative(dirname(repoPackagePath), webPackagePath),
      repoPackagePath,
      "dir",
    );
  }
}

function collectTracedNodePackages(rootDir) {
  const packages = new Set();

  for (const nftFile of findFiles(rootDir, ".nft.json")) {
    const manifest = JSON.parse(readFileSync(nftFile, "utf8"));
    for (const filePath of manifest.files ?? []) {
      const parts = filePath.split(/[\\/]+/);
      const nodeModulesIndex = parts.indexOf("node_modules");
      if (nodeModulesIndex === -1) {
        continue;
      }

      const packageName = parts[nodeModulesIndex + 1];
      if (!packageName) {
        continue;
      }

      if (packageName.startsWith("@")) {
        const scopedName = parts[nodeModulesIndex + 2];
        if (scopedName) {
          packages.add(`${packageName}/${scopedName}`);
        }
        continue;
      }

      packages.add(packageName);
    }
  }

  return packages;
}

function findFiles(rootDir, suffix) {
  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(entryPath, suffix));
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      files.push(entryPath);
    }
  }

  return files;
}
