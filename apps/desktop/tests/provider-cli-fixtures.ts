import type { ManagedPolicyStatus, ProviderId } from "@openadminos/agent-sdk";

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { registerProviderFixtureDirectory } from "../../../tests/provider-test-guard.mjs";

export async function fakeCli(directory: string, name: string, body: string): Promise<string> {
  const binary = join(directory, name);
  const log = join(directory, `${name}.log`);
  await writeFile(binary, `#!/bin/sh\necho "$*" >> "${log}"\n${body}\n`);
  await chmod(binary, 0o755);
  registerProviderFixtureDirectory(directory);
  return binary;
}

/** Narrow scan checks only. Provider discovery outside a scan still needs a providerListFactory stub. */
export function onlyScanProviders(...allowedProviders: ProviderId[]): ManagedPolicyStatus {
  return { files: [], values: { allowedProviders }, sources: {}, locked: [], issues: [] };
}

// Up to 5 seconds: a killed child is reaped by the system, which can be slow on a loaded machine.
export async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
