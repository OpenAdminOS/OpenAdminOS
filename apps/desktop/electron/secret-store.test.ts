import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SafeStorageTokenCacheStore,
  secureStorageUnavailableMessage,
} from "./secret-store.js";

describe("SafeStorageTokenCacheStore", () => {
  it("fails before Microsoft sign-in when OS secure storage is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-secret-store-unavailable-"));
    const store = new SafeStorageTokenCacheStore(join(dir, "tokens.bin"), {
      platform: "linux",
      loadSafeStorage: async () => fakeSafeStorage({ available: false }),
    });

    try {
      await assert.rejects(
        () => store.read(),
        /install and unlock a Secret Service keyring/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects Electron's unprotected Linux basic_text backend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-secret-store-basic-"));
    const store = new SafeStorageTokenCacheStore(join(dir, "tokens.bin"), {
      platform: "linux",
      loadSafeStorage: async () =>
        fakeSafeStorage({ available: true, backend: "basic_text" }),
    });

    try {
      await assert.rejects(
        () => store.write("serialized-msal-cache"),
        /refused to store tokens/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the MSAL cache encrypted through safeStorage when available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-secret-store-roundtrip-"));
    const tokenPath = join(dir, "tokens.bin");
    const store = new SafeStorageTokenCacheStore(tokenPath, {
      platform: "linux",
      loadSafeStorage: async () =>
        fakeSafeStorage({ available: true, backend: "gnome_libsecret" }),
    });

    try {
      await store.write("serialized-msal-cache");

      assert.equal(await store.read(), "serialized-msal-cache");
      assert.equal(
        (await readFile(tokenPath)).toString("utf8"),
        "encrypted:serialized-msal-cache",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("clears corrupt encrypted cache files so tenants can reconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-secret-store-corrupt-"));
    const tokenPath = join(dir, "tokens.bin");
    const store = new SafeStorageTokenCacheStore(tokenPath, {
      loadSafeStorage: async () => fakeSafeStorage({ available: true }),
    });

    try {
      await writeFile(tokenPath, "not-encrypted", "utf8");

      assert.equal(await store.read(), "");
      await assert.rejects(() => readFile(tokenPath), /ENOENT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("secureStorageUnavailableMessage", () => {
  it("keeps Linux recovery copy specific and actionable", () => {
    assert.match(
      secureStorageUnavailableMessage({
        backend: "basic_text",
        platform: "linux",
      }),
      /Debian\/Ubuntu/,
    );
  });
});

function fakeSafeStorage(input: { available: boolean; backend?: string }) {
  return {
    isEncryptionAvailable: () => input.available,
    getSelectedStorageBackend: () => input.backend ?? "unknown",
    encryptString: (plaintext: string) =>
      Buffer.from(`encrypted:${plaintext}`, "utf8"),
    decryptString: (encrypted: Buffer) => {
      const value = encrypted.toString("utf8");
      if (!value.startsWith("encrypted:")) {
        throw new Error(
          "Error while decrypting the ciphertext provided to safeStorage.",
        );
      }
      return value.slice("encrypted:".length);
    },
  };
}
