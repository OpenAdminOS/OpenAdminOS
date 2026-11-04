import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { tsImport } from "tsx/esm/api";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

// Load the service registry source, so this test needs no build step.
async function registry() {
  return tsImport("../packages/agent-sdk/src/services.ts", import.meta.url);
}

function ownRegistrationDoc() {
  return readFileSync(
    join(root, "docs", "gitbook", "getting-started", "own-app-registration.md"),
    "utf8",
  );
}

/** Rows of the per-service permission table under `### <title>`. */
function documentedRows(doc, title) {
  const section = doc.match(
    new RegExp(`### ${title}\\n\\n\\| Part \\| Permission \\| Permission ID \\|\\n\\| --- \\| --- \\| --- \\|\\n((?:\\|.*\\|\\n)+)`),
  );
  assert.ok(section, `permission table for ${title} not found in own-app-registration.md`);
  return [...section[1].matchAll(/^\| (.+?) \| `([^`]+)` \| `([^`]+)` \|$/gm)].map((match) => ({
    part: match[1],
    name: match[2],
    permissionId: match[3],
  }));
}

test("own app registration docs list each service's parts, scopes and permission IDs", async () => {
  const { AVAILABLE_SERVICES } = await registry();
  const doc = ownRegistrationDoc();
  for (const service of AVAILABLE_SERVICES) {
    const expected = service.parts
      .filter((part) => !part.planned)
      .flatMap((part) =>
        part.scopes.map((scope) => ({ part: part.title, name: scope.name, permissionId: scope.permissionId })),
      );
    assert.deepEqual(documentedRows(doc, service.title), expected);
  }
});

test("own app registration docs cover exactly the default read scopes", async () => {
  const { AVAILABLE_SERVICES, DEFAULT_GRAPH_READ_SCOPE_NAMES } = await registry();
  const doc = ownRegistrationDoc();
  const documented = new Set(
    AVAILABLE_SERVICES.flatMap((service) => documentedRows(doc, service.title).map((row) => row.name)),
  );
  assert.deepEqual([...documented].sort(), [...DEFAULT_GRAPH_READ_SCOPE_NAMES].sort());
});

test("the requiredResourceAccess example matches the registry for Defender", async () => {
  const { MICROSOFT_GRAPH_APP_ID, partIdsFor, requestedScopes } = await registry();
  const block = ownRegistrationDoc().match(/```json\n([\s\S]+?)\n```/);
  assert.ok(block, "JSON snippet not found in own-app-registration.md");
  assert.deepEqual(JSON.parse(block[1]), [
    {
      resourceAppId: MICROSOFT_GRAPH_APP_ID,
      resourceAccess: requestedScopes(partIdsFor(["defender"])).map((scope) => ({
        id: scope.permissionId,
        type: "Scope",
      })),
    },
  ]);
});
