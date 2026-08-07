import { readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "apps", "desktop");
const packageJson = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));

if (packageJson.name !== "@openadminos/desktop") {
  throw new Error("Refusing to clean an unexpected package directory.");
}

rmSync(join(desktopRoot, "dist-electron"), { recursive: true, force: true });
