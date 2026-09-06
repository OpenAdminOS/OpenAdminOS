import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { it } from "node:test";

it("uses separate keychain and certificate passwords for both macOS signing certificates", async () => {
  // Load the build-time helper without importing its CLI side effect.
  const script = readFileSync(new URL("../../../scripts/patch-macos-signing.mjs", import.meta.url), "utf8");
  const definition = script.slice(script.indexOf("export function patchMacSigning"), script.indexOf("\nif (process.argv[1]"))
    .replace("export function", "function");
  const patch = runInNewContext(`${definition}\npatchMacSigning`) as (source: string) => string;
  const require = createRequire(import.meta.url);
  const source = readFileSync(require.resolve("app-builder-lib/out/codeSign/macCodeSign.js"), "utf8");
  const patched = patch(source);
  assert.equal(patch(patched), patched);
  assert.throws(() => patch("unexpected source"), /Unrecognized/);
  const calls: string[][] = [];
  const functions = patched.slice(patched.indexOf("async function createKeychain("), patched.indexOf("async function sign("));
  const createKeychain = runInNewContext(`${functions}\ncreateKeychain`, {
    process: { env: { TRAVIS: "true" } },
    path: { join: (...parts: string[]) => parts.join("/") },
    os_1: { tmpdir: () => "/test" },
    crypto_1: { createHash: () => ({ update() { return this; }, digest: () => "temporary" }), randomBytes: () => ({ toString: () => "keychain-password" }) },
    removeKeychain: async () => undefined,
    listUserKeychains: async () => [],
    codesign_1: { importCertificate: async (link: string) => link },
    builder_util_1: { exec: async (_command: string, args: string[]) => { calls.push(args); } },
  });
  await createKeychain({ tmpDir: {}, currentDir: "/project", cscLink: "app.p12", cscKeyPassword: "app-password",
    cscILink: "installer.p12", cscIKeyPassword: "installer-password" });
  assert.equal(calls.find((args) => args[0] === "create-keychain")?.[2], "keychain-password");
  assert.deepEqual(calls.filter((args) => args[0] === "import").map((args) => args[args.indexOf("-P") + 1]), ["app-password", "installer-password"]);
  assert.deepEqual(calls.filter((args) => args[0] === "set-key-partition-list").map((args) => args[args.indexOf("-k") + 1]), ["keychain-password", "keychain-password"]);
});
