import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenCacheStorage } from "@openadminos/runtime";

export interface SafeStorageApi {
  isEncryptionAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(encrypted: Buffer): string;
  getSelectedStorageBackend?(): string;
}

interface SafeStorageTokenCacheStoreOptions {
  loadSafeStorage?: () => Promise<SafeStorageApi>;
  platform?: NodeJS.Platform;
}

export class SecureStorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecureStorageUnavailableError";
  }
}

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
  private readonly loadSafeStorage: () => Promise<SafeStorageApi>;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly filePath: string,
    options: SafeStorageTokenCacheStoreOptions = {},
  ) {
    this.loadSafeStorage =
      options.loadSafeStorage ??
      (async () => {
        const { safeStorage } = await import("electron");
        return safeStorage;
      });
    this.platform = options.platform ?? process.platform;
  }

  async read(): Promise<string> {
    try {
      const safeStorage = await this.requireSafeStorage();
      const encrypted = await readFile(this.filePath);
      if (encrypted.length === 0) return "";
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
    const safeStorage = await this.requireSafeStorage();
    const ciphertext = safeStorage.encryptString(plaintext);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, ciphertext, { mode: 0o600 });
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }

  private async requireSafeStorage(): Promise<SafeStorageApi> {
    const safeStorage = await this.loadSafeStorage();
    return requireOsSecureStorage(safeStorage, this.platform);
  }
}

export function requireOsSecureStorage(
  safeStorage: SafeStorageApi,
  platform: NodeJS.Platform = process.platform,
): SafeStorageApi {
  const backend =
    platform === "linux"
      ? safeStorage.getSelectedStorageBackend?.()
      : undefined;
  if (!safeStorage.isEncryptionAvailable() || backend === "basic_text") {
    throw new SecureStorageUnavailableError(
      secureStorageUnavailableMessage({ backend, platform }),
    );
  }
  return safeStorage;
}

export function secureStorageUnavailableMessage(input: {
  backend?: string;
  platform?: NodeJS.Platform;
} = {}): string {
  const platform = input.platform ?? process.platform;
  const backend = input.backend;
  const base =
    "OS secure storage is unavailable. OpenAdminOS stores Microsoft sign-in tokens only in operating-system secure storage.";
  const backendDetail =
    backend === "basic_text"
      ? " Electron selected the unprotected Linux basic_text backend, so OpenAdminOS refused to store tokens there."
      : backend
        ? ` Electron selected backend: ${backend}.`
        : "";
  const linuxRecovery =
    platform === "linux"
      ? " On Debian/Ubuntu, install and unlock a Secret Service keyring such as gnome-keyring, or use KWallet on KDE, then sign out and back in before connecting the tenant again."
      : "";
  return `${base}${backendDetail}${linuxRecovery}`;
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
