import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "packages/runtime/native/apple-foundation-helper");
const binaryName = "openadminos-apple-foundation-helper";
const builtBinary = join(packagePath, ".build/release", binaryName);
const outputDir = join(root, "apps/desktop/electron/native/apple-foundation-helper");
const outputBinary = join(outputDir, binaryName);

mkdirSync(outputDir, { recursive: true });
rmSync(outputBinary, { force: true });

if (process.platform !== "darwin") {
  console.log("Skipping Apple Foundation helper build: not macOS.");
  process.exit(0);
}

const probe = spawnSync(
  "swift",
  ["-e", "import FoundationModels; print(\"ok\")"],
  { encoding: "utf8" },
);

if (probe.status !== 0) {
  const detail = (probe.stderr || probe.stdout || "").trim();
  console.log(
    `Skipping Apple Foundation helper build: FoundationModels.framework is not available.${detail ? ` ${detail}` : ""}`,
  );
  process.exit(0);
}

const build = spawnSync(
  "swift",
  ["build", "-c", "release", "--package-path", packagePath],
  { stdio: "inherit" },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(builtBinary)) {
  console.error(`Apple Foundation helper build finished, but ${builtBinary} was not created.`);
  process.exit(1);
}

copyFileSync(builtBinary, outputBinary);
console.log(`Copied Apple Foundation helper to ${outputBinary}`);
