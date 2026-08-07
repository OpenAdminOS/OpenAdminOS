import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { SecretAccessor } from "@openadminos/agent-sdk";
import {
  requireOsSecureStorage,
  type SafeStorageApi,
} from "./secret-store.js";

interface ProviderSecretStoreOptions {
  loadSafeStorage?: () => Promise<SafeStorageApi>;
  platform?: NodeJS.Platform;
}

export class SafeStorageProviderSecretStore {
  private readonly loadSafeStorage: () => Promise<SafeStorageApi>;
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly rootDir: string,
    options: ProviderSecretStoreOptions = {},
  ) {
    this.loadSafeStorage =
      options.loadSafeStorage ??
      (async () => {
        const { safeStorage } = await import("electron");
        return safeStorage;
      });
    this.platform = options.platform ?? process.platform;
  }

  forProvider(providerId: string): SecretAccessor {
    const safeProviderId = sanitizePathSegment(providerId);
    return {
      get: async (key: string) => {
        const path = this.pathFor(safeProviderId, key);
        try {
          const encrypted = await readFile(path);
          if (encrypted.length === 0) return undefined;
          const safeStorage = requireOsSecureStorage(
            await this.loadSafeStorage(),
            this.platform,
          );
          return safeStorage.decryptString(encrypted);
        } catch (error) {
          if (isMissingFile(error)) return undefined;
          if (isSafeStorageDecryptError(error)) {
            await rm(path, { force: true });
            return undefined;
          }
          throw error;
        }
      },
      set: async (key: string, value: string) => {
        const safeStorage = requireOsSecureStorage(
          await this.loadSafeStorage(),
          this.platform,
        );
        const path = this.pathFor(safeProviderId, key);
        await mkdir(join(this.rootDir, safeProviderId), { recursive: true });
        await writeFile(path, safeStorage.encryptString(value), { mode: 0o600 });
      },
      remove: async (key: string) => {
        await rm(this.pathFor(safeProviderId, key), { force: true });
      },
    };
  }

  private pathFor(providerId: string, key: string): string {
    return join(this.rootDir, providerId, `${sanitizePathSegment(key)}.bin`);
  }
}

function sanitizePathSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "_";
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
