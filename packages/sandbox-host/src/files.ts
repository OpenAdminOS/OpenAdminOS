import { chmodSync, mkdirSync, statSync } from "node:fs";

import { SandboxRefusal } from "./refusal.js";

/**
 * Refuses a file that other users can read or write, or that another user
 * owns. The config, the private key and the secrets file hold what lets
 * the sandbox read the tenant and send reports. Windows has no POSIX mode
 * bits; there the folder's access control list is the admin's to set, as
 * the README says.
 */
export function assertPrivateFile(path: string, label: string): void {
  if (process.platform === "win32") return;
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    throw new SandboxRefusal("file-permissions", `The ${label} at ${path} cannot be read: ${describe(cause)}`, { cause });
  }
  if (!stats.isFile()) {
    throw new SandboxRefusal("file-permissions", `The ${label} at ${path} is not a file.`);
  }
  const mode = stats.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new SandboxRefusal(
      "file-permissions",
      `The ${label} at ${path} can be read or changed by other users (mode ${mode.toString(8).padStart(4, "0")}). Run chmod 600 ${path}, then start again.`,
    );
  }
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new SandboxRefusal(
      "file-permissions",
      `The ${label} at ${path} is owned by another user (uid ${stats.uid}). Give it to the user the sandbox runs as (uid ${uid}), then start again.`,
    );
  }
}

/** Creates the data folder with mode 0700, and tightens it when it exists. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(path, 0o700);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
