"use strict";

const { spawnSync } = require("node:child_process");
const { basename } = require("node:path");

const SIGNING_ENV_VARS = [
  "SM_HOST",
  "SM_API_KEY",
  "SM_CLIENT_CERT_FILE",
  "SM_CLIENT_CERT_PASSWORD",
  "SM_KEYPAIR_ALIAS",
];

function sign(configuration) {
  const filePath = configuration && configuration.path;
  if (!filePath) {
    throw new Error(
      "Windows signing hook received no configuration.path from electron-builder.",
    );
  }

  const file = basename(filePath);
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

  const keypairAlias = process.env.SM_KEYPAIR_ALIAS;
  if (!keypairAlias) {
    throw new Error(
      "SM_KEYPAIR_ALIAS is not set. It must name the DigiCert KeyLocker keypair used for Windows signing.",
    );
  }

  console.log(`signing ${file}`);
  const result = spawnSync(
    "smctl",
    ["sign", `--keypair-alias=${keypairAlias}`, "--input", filePath],
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
      `smctl exited ${result.status} while signing ${file}. Output: ${formattedOutput}`,
    );
  }
  if (/fail(ed|ure)?/i.test(output)) {
    throw new Error(
      `smctl reported a failure while signing ${file} despite exiting 0. Output: ${formattedOutput}`,
    );
  }
}

exports.sign = sign;
exports.default = sign;
