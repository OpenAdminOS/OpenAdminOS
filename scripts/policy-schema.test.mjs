import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { tsImport } from "tsx/esm/api";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const schema = JSON.parse(readFileSync(join(root, "schemas", "policy.schema.json"), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const catalog = {
  providerIds: schema.$defs.providerId.enum,
  publicReferenceIds: schema.$defs.publicReferenceId.enum,
};

async function parser() {
  return tsImport("../apps/desktop/electron/managed-policy.ts", import.meta.url);
}

/** Problems the app reports for one machine file, after the merge checks. */
async function problems(text) {
  const { loadManagedPolicy } = await parser();
  const status = await loadManagedPolicy({
    ...catalog,
    paths: [{ scope: "machine", path: "/policy.json" }],
    read: async () => new TextEncoder().encode(text),
  });
  return status?.issues ?? [];
}

function docExamples() {
  const page = readFileSync(join(root, "docs", "gitbook", "getting-started", "managed-configuration.md"), "utf8");
  const json = [...page.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
  // The policies embedded in the Intune and Jamf scripts.
  const embedded = [...page.matchAll(/(?:@'|<<'EOF')\n(\{[\s\S]*?\})\n(?:'@|EOF)/g)].map((match) => match[1]);
  return [...json, ...embedded];
}

test("every policy in the IT admin docs is valid for the schema and the app", async () => {
  const examples = docExamples();
  assert.ok(examples.length >= 3, "the page shows an example and the deployment scripts");
  for (const text of examples) {
    assert.ok(validate(JSON.parse(text)), JSON.stringify(validate.errors));
    assert.deepEqual(await problems(text), [], text);
  }
});

test("the schema and the app reject the same files", async () => {
  const invalid = [
    { allowedProviders: ["olama"] },
    { defaultProvider: 7 },
    { defaultModel: "llama3.1:8b" },
    { allowedPublicReferences: "microsoft-learn" },
    { appRegistration: { clientId: "not-a-guid" } },
    { appRegistration: { label: "No client" } },
    { skipFirstRunScan: "yes" },
    { lock: ["everything"] },
    { version: 2 },
    { telemetry: false },
  ];
  for (const policy of invalid) {
    assert.equal(validate(policy), false, JSON.stringify(policy));
    assert.notDeepEqual(await problems(JSON.stringify(policy)), [], JSON.stringify(policy));
  }
});
