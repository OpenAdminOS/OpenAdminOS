import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import ts from "typescript";

import { assertProviderTestGuardActive } from "../../../tests/provider-test-guard.mjs";

const directory = fileURLToPath(new URL(".", import.meta.url));
const root = new URL("../../../", import.meta.url);

it("preloads the provider guard in both Node test runners", async () => {
  for (const path of ["apps/desktop/package.json", "packages/runtime/package.json"]) {
    const { scripts } = JSON.parse(await readFile(new URL(path, root), "utf8"));
    assert.match(scripts.test, /(?:^|\s)--import\s+\.\.\/\.\.\/tests\/provider-test-setup\.mjs(?=\s|$)/,
      `${path} must preload the provider test setup in scripts.test.`);
  }
});

it("isolates provider checks and AppStateStore discovery in Electron tests", async () => {
  const files = await readdir(directory, { recursive: true });
  const importerFiles: string[] = [];
  const violations: string[] = [];
  for (const file of files.filter((name) => name.endsWith(".test.ts"))) {
    const source = await readFile(join(directory, file), "utf8");
    const exercisesDiscovery = file === "model-scan.test.ts" || file === "model-scan-cancel.test.ts";
    const importsProviderChecks = /(?:from\s+|import\s*\(\s*)["'][^"']*\/(?:model-scan|provider-detail)\.js["']/.test(source);
    if (exercisesDiscovery || importsProviderChecks) {
      importerFiles.push(file);
      assert.match(source, /^assertProviderTestGuardActive\(\);$/m, `${file} must check that the guard is active when run on its own.`);
    }
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const storeNames = new Set(["AppStateStore"]);
    const constructions: ts.NewExpression[] = [];
    function record(node: ts.Node, message: string) {
      const { line } = syntax.getLineAndCharacterOfPosition(node.getStart(syntax));
      violations.push(`${file}:${line + 1} ${message}`);
    }
    function visit(node: ts.Node) {
      if (ts.isImportSpecifier(node) && node.propertyName?.text === "AppStateStore") {
        storeNames.add(node.name.text);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) constructions.push(node);
      if (ts.isPropertyAssignment(node) &&
          (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === "providerListFactory" &&
          ts.isIdentifier(node.initializer) && node.initializer.text === "undefined") {
        record(node, "providerListFactory must be a stub function when supplied.");
      }
      ts.forEachChild(node, visit);
    }
    visit(syntax);
    // The discovery suites may construct the real store with guarded CLI and HTTP fixtures.
    for (const node of exercisesDiscovery ? [] : constructions) {
      if (!storeNames.has(node.expression.getText(syntax))) continue;
      record(node, "Use createTestAppStateStore unless the suite exercises real provider discovery.");
    }
  }
  assert.deepEqual(violations, [], "Use the shared stubbed AppStateStore fixture in Electron tests.");
  assert.ok(importerFiles.length, "Expected to find Electron tests that import the real provider checks.");
  assert.doesNotThrow(assertProviderTestGuardActive, `Enable the provider test setup for ${importerFiles.join(", ")}.`);
});
