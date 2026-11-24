import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const targets = new Map([
  ["--mac", "darwin"], ["-m", "darwin"],
  ["--win", "win32"], ["-w", "win32"],
  ["--linux", "linux"], ["-l", "linux"],
]);
const requestedPlatforms = args.map(arg => targets.get(arg.split("=")[0])).filter(Boolean);
const requestedArchitectures = args
  .map(arg => /^--(x64|arm64|ia32|armv7l|universal)(?:=true)?$/.exec(arg)?.[1])
  .filter(Boolean);
const defaultArchitecture = process.platform === "darwin" ? "arm64" : "x64";
if (requestedPlatforms.some(platform => platform !== process.platform) ||
    (requestedArchitectures.length ? requestedArchitectures : [defaultArchitecture]).some(arch => arch !== process.arch)) {
  throw new Error("Run the desktop distribution build on a runner matching the target platform and architecture. The Whisper sidecar is built natively.");
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Run this script through npm run dist.");
const run = (args) => execFileSync(process.execPath, [npm, ...args], { stdio: "inherit" });
run(["run", "build:nova-speech", "--", process.arch]);
run(["run", "build"]);
run(["exec", "--no", "--", "electron-builder", ...args]);
