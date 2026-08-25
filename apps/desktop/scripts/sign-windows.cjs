"use strict";

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { basename, join, sep } = require("node:path");

const SIGNING_ENV_VARS = [
  "SM_HOST",
  "SM_API_KEY",
  "SM_CLIENT_CERT_FILE",
  "SM_CLIENT_CERT_PASSWORD",
  "SM_KEYPAIR_ALIAS",
];

// Bundled third-party binaries that already carry their vendor's Authenticode
// signature. Re-signing them would replace Microsoft's attestation with ours
// and claim their code as our own, and DigiCert's pre-sign binary analysis
// rejects them anyway. electron-builder hands every packaged executable to
// this hook, so the exclusion lives here; the release workflow separately
// verifies that every skipped file still has a valid vendor signature.
const THIRD_PARTY_SIGNED_DIRS = [
  ["native", "mxc-sdk", "bin"].join(sep) + sep,
];

// smctl's console output on failure is a single unhelpful FAILED line; the
// actual reason only lands in its log file. Surface the tail of that log in
// the thrown error so a red CI job is diagnosable without a runner.
function smctlLogTail() {
  try {
    const log = readFileSync(
      join(homedir(), ".signingmanager", "logs", "smctl.log"),
      "utf8",
    );
    const lines = log.trimEnd().split(/\r?\n/);
    return lines.slice(-15).join("\n");
  } catch {
    return "(smctl.log not readable)";
  }
}

function sign(configuration) {
  const filePath = configuration && configuration.path;
  if (!filePath) {
    throw new Error(
      "Windows signing hook received no configuration.path from electron-builder.",
    );
  }

  const file = basename(filePath);
  if (THIRD_PARTY_SIGNED_DIRS.some((dir) => filePath.includes(dir))) {
    console.log(
      `skipping ${file}: third-party binary that keeps its vendor signature`,
    );
    return;
  }
  if (!process.env.SM_API_KEY) {
    if (process.env.OPENADMINOS_ALLOW_UNSIGNED_WINDOWS === "1") {
      console.warn(
        `WARNING: OPENADMINOS_ALLOW_UNSIGNED_WINDOWS=1, producing an UNSIGNED Windows build. Not signing ${file}.`,
      );
      return;
    }
    throw new Error(
      `Windows signing requires DigiCert KeyLocker credentials: ${SIGNING_ENV_VARS.join(", ")}. Set OPENADMINOS_ALLOW_UNSIGNED_WINDOWS=1 only for packaging validation.`,
    );
  }

  // Selecting the certificate by SHA1 fingerprint (CertCentral calls it the
  // thumbprint) is preferred: it addresses the certificate directly instead
  // of going through the keypair's default-certificate lookup, which fails
  // with "no certificate found for the given constraints" while DigiCert has
  // a certificate provisioned but not yet marked as the keypair default.
  const fingerprint = process.env.SM_CERT_FINGERPRINT;
  const keypairAlias = process.env.SM_KEYPAIR_ALIAS;
  let selector;
  if (fingerprint) {
    selector = `--fingerprint=${fingerprint}`;
  } else if (keypairAlias) {
    selector = `--keypair-alias=${keypairAlias}`;
  } else {
    throw new Error(
      "Neither SM_CERT_FINGERPRINT nor SM_KEYPAIR_ALIAS is set. One of them must identify the DigiCert KeyLocker certificate used for Windows signing.",
    );
  }

  console.log(`signing ${file} (${selector.split("=")[0]})`);
  const result = spawnSync(
    "smctl",
    ["sign", selector, "--input", filePath],
    { encoding: "utf8" },
  );

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}${stderr}`;
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  const formattedOutput = output.trim() || "(none)";
  if (result.error) {
    throw new Error(
      `Could not run smctl to sign ${file}: ${result.error.message}. smctl is not on PATH; install DigiCert Software Trust Manager before electron-builder runs. Output: ${formattedOutput}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `smctl exited ${result.status} while signing ${file}. Output: ${formattedOutput}\nsmctl.log tail:\n${smctlLogTail()}`,
    );
  }
  if (/fail(ed|ure)?/i.test(output)) {
    throw new Error(
      `smctl reported a failure while signing ${file} despite exiting 0. Output: ${formattedOutput}\nsmctl.log tail:\n${smctlLogTail()}`,
    );
  }
}

exports.sign = sign;
exports.default = sign;
