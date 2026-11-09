import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { SecretAccessor } from "@openadminos/agent-sdk";

import { SafeStorageConnectorSecretStore } from "../connector-secret-store.js";
import type { SafeStorageApi } from "../secret-store.js";

const FOLDER = "splashtop";

function fileKey(organizationId: string): string {
  const safe = organizationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "_";
}

/**
 * Splashtop API tokens, one per organization, encrypted with Electron
 * safeStorage (macOS Keychain, Windows DPAPI, libsecret). A token is read
 * only to send it to its organization's regional host.
 */
export interface SplashtopTokenStore {
  get(organizationId: string): Promise<string | undefined>;
  set(organizationId: string, token: string): Promise<void>;
  remove(organizationId: string): Promise<void>;
  /** Deletes the token of every organization not in `keep`. Returns how many were deleted. */
  sweep(keep: ReadonlySet<string>): Promise<number>;
}

export class SafeStorageSplashtopTokenStore implements SplashtopTokenStore {
  private readonly accessor: SecretAccessor;

  constructor(
    private readonly rootDir: string,
    options: { loadSafeStorage?: () => Promise<SafeStorageApi>; platform?: NodeJS.Platform } = {},
  ) {
    this.accessor = new SafeStorageConnectorSecretStore(rootDir, options).forConnector(FOLDER);
  }

  get(organizationId: string): Promise<string | undefined> {
    return this.accessor.get(organizationId);
  }

  set(organizationId: string, token: string): Promise<void> {
    return this.accessor.set(organizationId, token);
  }

  async remove(organizationId: string): Promise<void> {
    await this.accessor.remove(organizationId);
  }

  async sweep(keep: ReadonlySet<string>): Promise<number> {
    let names: string[];
    try {
      names = await readdir(join(this.rootDir, FOLDER));
    } catch {
      return 0;
    }
    const kept = new Set([...keep].map(fileKey));
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".bin")) continue;
      const key = name.slice(0, -".bin".length);
      if (kept.has(key)) continue;
      await this.accessor.remove(key);
      removed += 1;
    }
    return removed;
  }
}

/** For tests and builds without a user data folder. */
export class MemorySplashtopTokenStore implements SplashtopTokenStore {
  readonly tokens = new Map<string, string>();

  async get(organizationId: string): Promise<string | undefined> {
    return this.tokens.get(organizationId);
  }

  async set(organizationId: string, token: string): Promise<void> {
    this.tokens.set(organizationId, token);
  }

  async remove(organizationId: string): Promise<void> {
    this.tokens.delete(organizationId);
  }

  async sweep(keep: ReadonlySet<string>): Promise<number> {
    let removed = 0;
    for (const id of [...this.tokens.keys()]) {
      if (!keep.has(id)) {
        this.tokens.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}
