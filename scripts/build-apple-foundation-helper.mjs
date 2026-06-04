import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = join(root, "packages/runtime/native/apple-foundation-helper");
const binaryName = "openadminos-apple-foundation-helper";
const outputDir = join(root, "apps/desktop/electron/native/apple-foundation-helper");
const outputBinary = join(outputDir, binaryName);
const requireHelper = process.env.OPENADMINOS_REQUIRE_APPLE_FOUNDATION_HELPER === "1";

function stop(message) {
  if (requireHelper) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });
rmSync(outputBinary, { force: true });

if (process.platform !== "darwin") {
  stop("Skipping Apple Foundation helper build: not macOS.");
}

const probe = spawnSync("swift", ["-e", 'import FoundationModels; print("ok")'], {
  encoding: "utf8",
});

if (probe.status !== 0) {
  const detail = (probe.stderr || probe.stdout || "").trim();
  stop(
    `Skipping Apple Foundation helper build: FoundationModels.framework is not available.${
      detail ? ` ${detail}` : ""
    }`,
  );
}

const build = spawnSync(
  "swift",
  ["build", "-c", "release", "--package-path", packagePath],
  { stdio: "inherit" },
);

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const builtBinary = [
  join(packagePath, ".build/release", binaryName),
  join(packagePath, ".build/arm64-apple-macosx/release", binaryName),
  join(packagePath, ".build/x86_64-apple-macosx/release", binaryName),
].find((candidate) => existsSync(candidate));

if (!builtBinary) {
  console.error(
    `Apple Foundation helper build finished, but ${binaryName} was not created under ${packagePath}/.build.`,
  );
  process.exit(1);
}

copyFileSync(builtBinary, outputBinary);
console.log(`Copied Apple Foundation helper to ${outputBinary}`);
