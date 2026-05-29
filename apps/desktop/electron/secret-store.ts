import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenCacheStorage } from "@openadminos/runtime";

/**
 * MSAL token cache for the desktop process.
 *
 * The cache is encrypted with Electron safeStorage. If macOS Keychain or
 * Windows secure storage can no longer decrypt a previous cache value (for
 * example after app identity/keychain changes), we delete the cache and let
 * MSAL behave as if there is no cached account. That produces the product
 * recovery path users can act on: reconnect the tenant.
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
      if (isSafeStorageDecryptError(error)) {
        await this.clear();
        return "";
      }
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

function isSafeStorageDecryptError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /decrypt|ciphertext|safeStorage/i.test(error.message)
  );
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
