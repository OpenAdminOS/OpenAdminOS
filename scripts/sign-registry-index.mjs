import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPrivateKey, sign } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const indexPath = join(repoRoot, "agents", "index.json");
const signaturePath = join(repoRoot, "agents", "index.sig");
const keyFlag = process.argv.indexOf("--key");
const keyPath =
  keyFlag >= 0 ? process.argv[keyFlag + 1] : process.env.OPENADMINOS_REGISTRY_SIGNING_KEY;

if (!keyPath) {
  console.error(
    "Registry signing key is required. Pass --key <PEM path> or set OPENADMINOS_REGISTRY_SIGNING_KEY.",
  );
  process.exit(1);
}

const privateKey = createPrivateKey(readFileSync(resolve(keyPath)));
if (privateKey.asymmetricKeyType !== "ed25519") {
  console.error("Registry signing key must be an Ed25519 private key.");
  process.exit(1);
}

const signature = sign(null, readFileSync(indexPath), privateKey).toString("base64");
writeFileSync(signaturePath, `${signature}\n`, { mode: 0o644 });
console.log(`Signed ${indexPath}; wrote ${signaturePath}.`);
