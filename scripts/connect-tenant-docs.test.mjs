import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tsImport } from "tsx/esm/api";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Load the derived list from the service registry source, so this test
// needs no build step.
async function defaultReadScopes() {
  const { DEFAULT_GRAPH_READ_SCOPE_NAMES } = await tsImport(
    "../packages/agent-sdk/src/services.ts",
    import.meta.url,
  );
  return [...DEFAULT_GRAPH_READ_SCOPE_NAMES];
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

test("own app registration docs list exactly the sign-in read scopes", async () => {
  assert.deepEqual([...documentedReadScopes()].sort(), (await defaultReadScopes()).sort());
});
