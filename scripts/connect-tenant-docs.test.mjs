import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Read the scope list from source so this test needs no build step.
function defaultReadScopes() {
  const sdk = readFileSync(
    join(root, "packages", "agent-sdk", "src", "index.ts"),
    "utf8",
  );
  const block = sdk.match(
    /export const DEFAULT_GRAPH_READ_SCOPE_NAMES = \[([\s\S]*?)\] as const;/,
  );
  assert.ok(block, "DEFAULT_GRAPH_READ_SCOPE_NAMES not found in agent-sdk");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function documentedReadScopes() {
  const doc = readFileSync(
    join(root, "docs", "gitbook", "getting-started", "connect-tenant.md"),
    "utf8",
  );
  const section = doc.match(
    /Delegated read permissions requested at sign-in:\n\n((?:- `[^`]+`\n)+)/,
  );
  assert.ok(section, "scope list not found in connect-tenant.md");
  return [...section[1].matchAll(/- `([^`]+)`/g)].map((match) => match[1]);
}

test("own app registration docs list exactly the sign-in read scopes", () => {
  assert.deepEqual(documentedReadScopes(), defaultReadScopes());
});
