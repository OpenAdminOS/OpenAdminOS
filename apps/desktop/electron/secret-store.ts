import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenCacheStorage } from "@openadminos/runtime";

/**
 * MSAL token cache for the desktop process.
 *
 * Deliberately in-memory: using Electron safeStorage on macOS triggers a
 * scary Keychain prompt at app startup ("Electron wants to use your
 * confidential information..."). For an admin tool, that prompt is worse
 * for trust than asking the user to sign in again after a restart.
 *
 * Tenant records are still persisted in state.json, but OAuth refresh
 * tokens are not written to disk. If the process restarts and MSAL cannot
 * acquire silently, the existing tenant session falls back to interactive
 * Microsoft sign-in when a token is actually needed.
 */
export class SafeStorageTokenCacheStore implements TokenCacheStorage {
  constructor(private readonly filePath: string) {}

  async read(): Promise<string> {
    try {
      const encrypted = await readFile(this.filePath);
      if (encrypted.length === 0) return "";
      const { safeStorage } = await import("electron");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("OS secure storage is unavailable.");
      }
      return safeStorage.decryptString(encrypted);
    } catch (error) {
      if (isMissingFile(error)) return "";
      throw error;
    }
  }

  async write(plaintext: string): Promise<void> {
    const { safeStorage } = await import("electron");
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS secure storage is unavailable.");
    }
    const ciphertext = safeStorage.encryptString(plaintext);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, ciphertext, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
