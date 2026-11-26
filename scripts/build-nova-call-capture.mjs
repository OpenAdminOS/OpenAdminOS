import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "darwin" && process.arch === "arm64") {
  const desktop = fileURLToPath(new URL("../apps/desktop/", import.meta.url));
  const build = join(desktop, "build");
  const binary = join(build, "openadminos-nova-call-capture");
  mkdirSync(build, { recursive: true });
  rmSync(binary, { force: true });
  const result = spawnSync("xcrun", [
    "swiftc", "-O", "-target", "arm64-apple-macosx14.2",
    join(desktop, "electron/nova-call-capture/main.swift"), "-o", binary,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
