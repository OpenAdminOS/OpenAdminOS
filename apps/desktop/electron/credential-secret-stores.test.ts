import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SafeStorageConnectorSecretStore } from "./connector-secret-store.js";
import { SafeStorageProviderSecretStore } from "./provider-secret-store.js";

describe("provider and connector credential storage", () => {
  for (const [label, create] of [
    [
      "provider",
      (dir: string) =>
        new SafeStorageProviderSecretStore(dir, unsafeLinuxOptions()).forProvider(
          "provider",
        ),
    ],
    [
      "connector",
      (dir: string) =>
        new SafeStorageConnectorSecretStore(dir, unsafeLinuxOptions()).forConnector(
          "connector",
        ),
    ],
  ] as const) {
    it(`rejects the unprotected Linux basic_text backend for ${label} secrets`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `openadminos-${label}-secret-`));
      try {
        await assert.rejects(
          () => create(dir).set("api-key", "secret"),
          /unprotected Linux basic_text backend/,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

function unsafeLinuxOptions() {
  return {
    platform: "linux" as const,
    loadSafeStorage: async () => ({
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "basic_text",
      encryptString: (plaintext: string) => Buffer.from(plaintext),
      decryptString: (encrypted: Buffer) => encrypted.toString("utf8"),
    }),
  };
}
