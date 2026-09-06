import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// app-builder-lib 26.15.3 creates a keychain with a random password, but
// passes the certificate password to set-key-partition-list. Keep the
// certificate import password intact and pass the keychain password separately.
// Fail closed when upgrading the builder so this workaround is reviewed.
export function patchMacSigning(source) {
  const replacements = [
    ["importCerts(keychainFile, certPaths, cscPasswords)", "importCerts(keychainFile, certPaths, cscPasswords, keychainPassword)"],
    ["async function importCerts(keychainFile, paths, keyPasswords) {", "async function importCerts(keychainFile, paths, keyPasswords, keychainPassword) {"],
    ['["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", password, keychainFile]', '["set-key-partition-list", "-S", "apple-tool:,apple:", "-s", "-k", keychainPassword, keychainFile]'],
  ];
  if (replacements.every(([, after]) => source.includes(after))) return source;
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) {
      throw new Error("Unrecognized app-builder-lib signing code. Review the macOS signing workaround before building.");
    }
    source = source.replace(before, after);
  }
  return source;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  const version = require("app-builder-lib/package.json").version;
  if (version !== "26.15.3") throw new Error(`Review the macOS signing workaround for app-builder-lib ${version}.`);
  const path = require.resolve("app-builder-lib/out/codeSign/macCodeSign.js");
  const source = readFileSync(path, "utf8");
  writeFileSync(path, patchMacSigning(source));
  console.log("Applied macOS signing keychain-password correction for app-builder-lib 26.15.3.");
}
