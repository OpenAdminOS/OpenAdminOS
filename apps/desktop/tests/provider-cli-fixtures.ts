import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, join, relative, sep } from "node:path";
import { afterEach, beforeEach, mock } from "node:test";

import type { ManagedPolicyStatus, ProviderId } from "@openadminos/agent-sdk";

const binaryOverrides = [
  "OPENADMINOS_CLAUDE_CODE_BINARY",
  "OPENADMINOS_CODEX_BINARY",
  "OPENADMINOS_COPILOT_BINARY",
  "OPENADMINOS_GEMINI_BINARY",
  "OPENADMINOS_APPLE_FOUNDATION_HELPER",
] as const;

/** Install the guard for this test file and return a writer for permitted CLI fixtures. */
export function guardProviderCliFixtures() {
  const fixtureDirectories = new Set<string>();
  const unexpectedCommands: string[] = [];
  const originalOverrides = new Map<string, string | undefined>();
  let restoreSpawn: (() => void) | undefined;

  beforeEach(() => {
    for (const key of binaryOverrides) {
      originalOverrides.set(key, process.env[key]);
      delete process.env[key];
    }

    const spawn = childProcess.spawn;
    const guarded = mock.method(childProcess, "spawn", (
      command: string,
      ...args: [readonly string[], childProcess.SpawnOptions]
    ) => {
      const executable = isAbsolute(command) && existsSync(command) ? realpathSync(command) : undefined;
      if (executable && [...fixtureDirectories].some((dir) => {
        const path = relative(dir, executable);
        return path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
      })) {
        return spawn(command, ...args);
      }
      unexpectedCommands.push(command);
      throw new Error(`Blocked subprocess outside provider fixture directories: ${command}`);
    });
    syncBuiltinESMExports();
    restoreSpawn = () => guarded.mock.restore();
  });

  afterEach(() => {
    restoreSpawn?.();
    syncBuiltinESMExports();
    for (const [key, value] of originalOverrides) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    originalOverrides.clear();
    fixtureDirectories.clear();
    // Provider probes may catch a spawn error and report an unavailable CLI.
    assert.deepEqual(unexpectedCommands.splice(0), [], "all subprocesses must run from a provider fixture directory");
  });

  return async (directory: string, name: string, body: string): Promise<string> => {
    const binary = join(directory, name);
    const log = join(directory, `${name}.log`);
    await writeFile(binary, `#!/bin/sh\necho "$*" >> "${log}"\n${body}\n`, { mode: 0o755 });
    fixtureDirectories.add(realpathSync(directory));
    return binary;
  };
}

/** Keep end-to-end scans focused on the real adapters the test exercises. */
export function onlyScanProviders(...allowedProviders: ProviderId[]): ManagedPolicyStatus {
  return { files: [], values: { allowedProviders }, sources: {}, locked: [], issues: [] };
}
