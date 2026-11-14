import { chmodSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";

import { SandboxRefusal } from "./refusal.js";

/**
 * Reads a file that must be private to the service user: the config, a
 * private key or the secrets file. The file is opened once and the checks
 * run on that open descriptor, so the file that is checked is the file
 * that is read. Refused when other users can read or change it, when
 * another user owns it, or when it is not a regular file.
 */
export function readPrivateFile(path: string, label: string): string {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
  } catch (cause) {
    throw new SandboxRefusal("file-permissions", `The ${label} at ${path} cannot be read: ${describe(cause)}`, { cause });
  }
  try {
    const stats = fstatSync(descriptor);
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
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Creates the data folder with mode 0700, and tightens it when it exists. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

/**
 * The host runs on Linux and macOS. On Windows it cannot yet check who can
 * read its files, so it refuses to start there.
 */
export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new SandboxRefusal(
      "platform-not-supported",
      "The sandbox host does not run on Windows yet: it cannot check who can read the config, the private key and the secrets file there. Run it on Linux or macOS.",
    );
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
