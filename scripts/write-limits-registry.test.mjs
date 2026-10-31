import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("registry generation preserves declared limits and rejects malformed limits", () => {
  const root = mkdtempSync(join(tmpdir(), "openadminos-limits-registry-"));
  try {
    for (const directory of ["scripts", "packages/agent-sdk/src", "agents/limited-agent"]) mkdirSync(join(root, directory), { recursive: true });
    for (const file of ["scripts/generate-registry-index.mjs", "packages/agent-sdk/src/write-limits.ts"]) copyFileSync(join(repoRoot, file), join(root, file));
    symlinkSync(join(repoRoot, "node_modules"), join(root, "node_modules"), "junction");
    writeFileSync(join(root, "agents/registry-revision.txt"), "1\n");
    writeFileSync(join(root, "agents/limited-agent/README.md"), "# Limited agent\n");
    const writeLimits = { maxActions: 25, maxActionsPerOperation: { "graph-write": 10 } };
    const manifest = { descriptor: { id: "limited-agent", name: "Limited agent", description: "Review changes.", version: "1.0.0", minAppVersion: "0.7.2", mode: "write", writeLimits } };
    const path = join(root, "agents/limited-agent/manifest.yaml");
    writeFileSync(path, JSON.stringify(manifest));
    execFileSync(process.execPath, [join(root, "scripts/generate-registry-index.mjs")], { stdio: "pipe" });
    const index = JSON.parse(readFileSync(join(root, "agents/index.json"), "utf8"));
    assert.deepEqual(index.agents[0].writeLimits, writeLimits);
    manifest.descriptor.writeLimits.maxActions = 0;
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => execFileSync(process.execPath, [join(root, "scripts/generate-registry-index.mjs")], { stdio: "pipe" }), /writeLimits.maxActions.*positive integer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
