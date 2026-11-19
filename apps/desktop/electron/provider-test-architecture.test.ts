import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

import { assertProviderTestGuardActive } from "../../../tests/provider-test-guard.mjs";

it("requires the shared guard for Electron tests that import provider checks", async () => {
  const directory = fileURLToPath(new URL(".", import.meta.url));
  const files = await readdir(directory, { recursive: true });
  const importerFiles: string[] = [];
  for (const file of files.filter((name) => name.endsWith(".test.ts"))) {
    const source = await readFile(join(directory, file), "utf8");
    if (/(?:from\s+|import\s*\(\s*)["'][^"']*\/(?:model-scan|provider-detail)\.js["']/.test(source)) {
      importerFiles.push(file);
      assert.match(source, /^assertProviderTestGuardActive\(\);$/m, `${file} must check that the guard is active when run on its own.`);
    }
  }
  assert.ok(importerFiles.length, "Expected to find Electron tests that import the real provider checks.");
  assert.doesNotThrow(assertProviderTestGuardActive, `Enable the provider test setup for ${importerFiles.join(", ")}.`);
});
