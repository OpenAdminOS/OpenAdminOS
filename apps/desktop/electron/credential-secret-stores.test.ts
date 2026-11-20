import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { SafeStorageConnectorSecretStore } from "./connector-secret-store.js";
import { sealDataFolder, unsealDataFolder } from "./data-folder-seal.js";
import { SafeStorageProviderSecretStore } from "./provider-secret-store.js";
import { SafeStorageTokenCacheStore } from "./secret-store.js";

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

describe("credential storage while a reset has sealed the data folder", () => {
  const working = {
    platform: "darwin" as const,
    loadSafeStorage: async () => ({
      isEncryptionAvailable: () => true,
      encryptString: (plaintext: string) => Buffer.from(plaintext),
      // A restored profile's file encrypted with another key: decrypting fails.
      decryptString: () => {
        throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      },
    }),
  };

  it("neither reads, writes nor deletes a secret or token file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-sealed-"));
    try {
      const provider = new SafeStorageProviderSecretStore(dir, working).forProvider("provider");
      const connector = new SafeStorageConnectorSecretStore(dir, working).forConnector("connector");
      const tokens = new SafeStorageTokenCacheStore(join(dir, "tokens.bin"), working);
      // Files of a profile restored at this path after the commit.
      mkdirSync(join(dir, "provider"), { recursive: true });
      mkdirSync(join(dir, "connector"), { recursive: true });
      writeFileSync(join(dir, "provider", "api-key.bin"), "restored provider key");
      writeFileSync(join(dir, "connector", "token.bin"), "restored connector token");
      writeFileSync(join(dir, "tokens.bin"), "restored tokens");
      sealDataFolder();
      try {
        for (const accessor of [provider, connector]) {
          assert.equal(await accessor.get(accessor === provider ? "api-key" : "token"), undefined);
          await assert.rejects(accessor.set("api-key", "new"), /resetting.*Nothing was saved/);
          await accessor.remove(accessor === provider ? "api-key" : "token");
        }
        assert.equal(await tokens.read(), "");
        await assert.rejects(tokens.write("new"), /Nothing was saved/);
        await tokens.clear();
      } finally {
        unsealDataFolder();
      }
      assert.equal(readFileSync(join(dir, "provider", "api-key.bin"), "utf8"), "restored provider key");
      assert.equal(readFileSync(join(dir, "connector", "token.bin"), "utf8"), "restored connector token");
      assert.equal(readFileSync(join(dir, "tokens.bin"), "utf8"), "restored tokens");
      assert.ok(!existsSync(join(dir, "provider", "new.bin")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
