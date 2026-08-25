#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";

const BASELINE_VERSION = "0.3.0";
const VERSIONED_PACKAGES = [
  "package.json",
  "apps/desktop/package.json",
  "packages/agent-sdk/package.json",
  "packages/runtime/package.json",
  "packages/qa-graph/package.json",
  "packages/connector-discord/package.json",
  "packages/connector-outlook/package.json",
  "packages/connector-signal/package.json",
  "packages/connector-slack/package.json",
  "packages/connector-teams/package.json",
  "packages/connector-whatsapp-web/package.json",
  "web/package.json",
];

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function fail(message) {
  process.stderr.write(`release compatibility: ${message}\n`);
  process.exitCode = 1;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must remain ${JSON.stringify(expected)}; found ${JSON.stringify(actual)}.`);
  }
}

function assertIncludes(values, expected, label) {
  if (!Array.isArray(values) || !values.includes(expected)) {
    fail(`${label} must include ${JSON.stringify(expected)}.`);
  }
}

function compareSemver(left, right) {
  const parse = (value) => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    if (!match) throw new Error(`Invalid semver: ${value}`);
    return match.slice(1).map(Number);
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

const rootPackage = readJson("package.json");
const desktopPackage = readJson("apps/desktop/package.json");
const releaseVersion = rootPackage.version;

if (compareSemver(releaseVersion, BASELINE_VERSION) <= 0) {
  fail(`release version ${releaseVersion} must be newer than ${BASELINE_VERSION}.`);
}

for (const path of VERSIONED_PACKAGES) {
  assertEqual(readJson(path).version, releaseVersion, `${path} version`);
}

const build = desktopPackage.build ?? {};
assertEqual(build.appId, "com.openadminos.desktop", "macOS application identity");
assertEqual(build.productName, "OpenAdminOS", "product name");
assertEqual(desktopPackage.desktopName, "com.openadminos.desktop.desktop", "Linux desktop identity");
assertEqual(build.linux?.executableName, "openadminos", "Linux executable identity");

const macTargets = Array.isArray(build.mac?.target) ? build.mac.target : [];
for (const target of ["dmg", "pkg", "zip"]) {
  const entry = macTargets.find((candidate) => candidate?.target === target);
  if (!entry) {
    fail(`macOS targets must include ${target}.`);
  } else {
    assertIncludes(entry.arch, "arm64", `macOS ${target} architectures`);
  }
}

for (const target of ["AppImage", "deb", "rpm"]) {
  assertIncludes(build.linux?.target, target, "Linux package targets");
}

const winTargets = Array.isArray(build.win?.target) ? build.win.target : [];
const nsisTarget = winTargets.find((candidate) => candidate?.target === "nsis");
if (!nsisTarget) {
  fail("Windows targets must include nsis; the published Windows artifact is the NSIS installer.");
} else {
  assertIncludes(nsisTarget.arch, "x64", "Windows nsis architectures");
}

const signtoolOptions = build.win?.signtoolOptions ?? {};
assertEqual(
  signtoolOptions.publisherName,
  "Ugurlabs UG (haftungsbeschränkt)",
  "Windows publisher identity",
);
assertEqual(
  signtoolOptions.sign,
  "./scripts/sign-windows.cjs",
  "Windows signing hook",
);
if (!existsSync("apps/desktop/scripts/sign-windows.cjs")) {
  fail("apps/desktop/scripts/sign-windows.cjs is missing; Windows builds cannot be signed without it.");
}
assertIncludes(
  signtoolOptions.signingHashAlgorithms,
  "sha256",
  "Windows signing hash algorithms",
);
if (
  Array.isArray(signtoolOptions.signingHashAlgorithms) &&
  signtoolOptions.signingHashAlgorithms.includes("sha1")
) {
  fail(
    "Windows signing hash algorithms must not include sha1; it doubles KeyLocker signature usage and fails against a modern code signing certificate.",
  );
}

const githubPublisher = (build.publish ?? []).find(
  (entry) => entry?.provider === "github",
);
assertEqual(githubPublisher?.owner, "OpenAdminOS", "update publisher owner");
assertEqual(githubPublisher?.repo, "OpenAdminOS", "update publisher repository");

const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes(`## [${releaseVersion}]`)) {
  fail(`CHANGELOG.md must contain a ## [${releaseVersion}] release section.`);
}

const releaseWorkflow = readFileSync(".github/workflows/release.yml", "utf8");
if (
  releaseWorkflow.includes(
    "for name in APT_GPG_PRIVATE_KEY APT_GPG_PASSPHRASE",
  )
) {
  fail(
    "APT_GPG_PASSPHRASE must remain optional because the repository signing key may be unencrypted.",
  );
}

if (!process.exitCode) {
  process.stdout.write(
    `Release ${releaseVersion} keeps the macOS updater identity, Linux package identities, and Windows signing configuration required after ${BASELINE_VERSION}.\n`,
  );
}
