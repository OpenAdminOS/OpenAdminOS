"use strict";

// electron-builder Windows signing hook, backed by Azure Trusted Signing.
//
// The signing certificate is issued and rotated by Microsoft's Trusted
// Signing service (short-lived, HSM-held); nothing secret reaches the
// runner beyond a service principal credential. electron-builder calls this
// hook once per file and we delegate to the Invoke-TrustedSigning
// PowerShell cmdlet, the same tool electron-builder's built-in
// azureSignOptions path uses. We keep the custom hook instead of
// azureSignOptions because it lets us skip the bundled third-party
// Microsoft binaries (they keep their vendor Authenticode signature; the
// release workflow verifies that separately) and fail loudly on every
// error path.
//
// Auth comes from the environment (Azure EnvironmentCredential):
//   AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET
// Signing target configuration:
//   AZURE_SIGNING_ENDPOINT        e.g. https://weu.codesigning.azure.net
//   AZURE_SIGNING_ACCOUNT_NAME    Trusted Signing account name
//   AZURE_CERT_PROFILE_NAME       certificate profile name

const { spawnSync } = require("node:child_process");
const { basename, sep } = require("node:path");

const SIGNING_ENV_VARS = [
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_SIGNING_ENDPOINT",
  "AZURE_SIGNING_ACCOUNT_NAME",
  "AZURE_CERT_PROFILE_NAME",
];

// Bundled third-party binaries that already carry their vendor's Authenticode
// signature. Re-signing them would replace Microsoft's attestation with ours
// and claim their code as our own. electron-builder hands every packaged
// executable to this hook, so the exclusion lives here; the release workflow
// separately verifies that every skipped file still has a valid vendor
// signature.
const THIRD_PARTY_SIGNED_DIRS = [
  ["native", "mxc-sdk", "bin"].join(sep) + sep,
];

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { result, output };
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

  if (!process.env.AZURE_CLIENT_SECRET) {
    // The opt-out exists only for packaging-validation builds (the AppX job,
    // secretless forks, and local runs). It is never set on a tagged release.
    if (process.env.OPENADMINOS_ALLOW_UNSIGNED_WINDOWS === "1") {
      console.warn(
        `WARNING: OPENADMINOS_ALLOW_UNSIGNED_WINDOWS=1, producing an UNSIGNED Windows build. Not signing ${file}.`,
      );
      return;
    }
    throw new Error(
      `Refusing to produce an unsigned Windows build. Signing ${file} requires Azure Trusted Signing credentials (${SIGNING_ENV_VARS.join(", ")}). Set OPENADMINOS_ALLOW_UNSIGNED_WINDOWS=1 only for packaging validation.`,
    );
  }

  const missing = SIGNING_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Azure Trusted Signing configuration is incomplete; missing ${missing.join(", ")}.`,
    );
  }

  // Single quotes are doubled for PowerShell single-quoted strings, matching
  // how electron-builder's own azureSignOptions path escapes arguments.
  const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const command = [
    "Invoke-TrustedSigning",
    "-Endpoint", psQuote(process.env.AZURE_SIGNING_ENDPOINT),
    "-CodeSigningAccountName", psQuote(process.env.AZURE_SIGNING_ACCOUNT_NAME),
    "-CertificateProfileName", psQuote(process.env.AZURE_CERT_PROFILE_NAME),
    "-FileDigest", "SHA256",
    "-TimestampRfc3161", "http://timestamp.acs.microsoft.com",
    "-TimestampDigest", "SHA256",
    "-Files", psQuote(filePath),
  ].join(" ");

  console.log(`signing ${file} (Azure Trusted Signing)`);
  const { result, output } = run("pwsh", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]);
  if (output.trim()) {
    console.log(output.trim());
  }
  if (result.error) {
    throw new Error(
      `Could not run pwsh to sign ${file}: ${result.error.message}.`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `Invoke-TrustedSigning exited ${result.status} while signing ${file}. Output: ${output.trim() || "(none)"}`,
    );
  }

  // Confirm the signature actually landed. signtool verify /pa means Windows
  // itself accepts the file, independent of what the signing service said.
  const verify = run("signtool", ["verify", "/pa", filePath]);
  if (verify.output.trim()) {
    console.log(verify.output.trim());
  }
  if (verify.result.error || verify.result.status !== 0) {
    throw new Error(
      `signtool verify did not confirm a valid signature on ${file}. Output: ${verify.output.trim() || "(none)"}`,
    );
  }
  console.log(`verified signature on ${file}`);
}

exports.sign = sign;
exports.default = sign;
