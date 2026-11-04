import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { OPENADMINOS_CLIENT_ID } from "@openadminos/runtime";

import { adoptLegacyTokenCacheFiles, tokenCacheFileName } from "./token-cache-files.js";

const DEFAULT_PARTITION = OPENADMINOS_CLIENT_ID;
const CUSTOM = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-token-files-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function caseSensitive(dir: string): Promise<boolean> {
  await writeFile(join(dir, "probe-a"), "");
  const sensitive = await stat(join(dir, "PROBE-A")).then(() => false, () => true);
  await rm(join(dir, "probe-a"));
  return sensitive;
}

describe("token cache file names", () => {
  it("keeps tokens.bin for the default partition and lower-case names for others", () => {
    assert.equal(tokenCacheFileName(DEFAULT_PARTITION, DEFAULT_PARTITION), "tokens.bin");
    assert.equal(tokenCacheFileName(CUSTOM, DEFAULT_PARTITION), `tokens-${CUSTOM}.bin`);
  });

  it("moves an upper case file onto its canonical name when that name is free", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, `tokens-${CUSTOM.toUpperCase()}.bin`), "custom");
      const legacy = await adoptLegacyTokenCacheFiles(dir, DEFAULT_PARTITION);
      assert.equal(legacy.size, 0);
      assert.equal(await readFile(join(dir, `tokens-${CUSTOM}.bin`), "utf8"), "custom");
    });
  });

  it("moves the upper case OpenAdminOS custom cache onto tokens.bin when tokens.bin does not exist", async () => {
    await withDir(async (dir) => {
      await writeFile(join(dir, `tokens-${DEFAULT_PARTITION.toUpperCase()}.bin`), "legacy");
      const legacy = await adoptLegacyTokenCacheFiles(dir, DEFAULT_PARTITION);
      assert.equal(legacy.size, 0);
      assert.deepEqual(await readdir(dir), ["tokens.bin"]);
      assert.equal(await readFile(join(dir, "tokens.bin"), "utf8"), "legacy");
    });
  });

  it("keeps both files and reports the legacy one when the canonical file exists separately", async () => {
    await withDir(async (dir) => {
      const legacyPath = join(dir, `tokens-${DEFAULT_PARTITION.toUpperCase()}.bin`);
      await writeFile(join(dir, "tokens.bin"), "default");
      await writeFile(legacyPath, "legacy");
      await writeFile(join(dir, `tokens-${CUSTOM}.bin`), "custom");
      const legacy = await adoptLegacyTokenCacheFiles(dir, DEFAULT_PARTITION);
      assert.deepEqual([...legacy.entries()], [[DEFAULT_PARTITION, [legacyPath]]]);
      assert.equal(await readFile(join(dir, "tokens.bin"), "utf8"), "default");
      assert.equal(await readFile(legacyPath, "utf8"), "legacy");
      assert.equal(await readFile(join(dir, `tokens-${CUSTOM}.bin`), "utf8"), "custom");
    });
  });

  it("treats a name differing only in case as the canonical file where the filesystem ignores case, and as a legacy file where it does not", async () => {
    await withDir(async (dir) => {
      const upperPath = join(dir, `tokens-${CUSTOM.toUpperCase()}.bin`);
      const sensitive = await caseSensitive(dir);
      await writeFile(upperPath, "upper");
      if (sensitive) await writeFile(join(dir, `tokens-${CUSTOM}.bin`), "lower");
      const legacy = await adoptLegacyTokenCacheFiles(dir, DEFAULT_PARTITION);
      if (sensitive) {
        assert.deepEqual([...legacy.entries()], [[CUSTOM, [upperPath]]]);
        assert.equal(await readFile(join(dir, `tokens-${CUSTOM}.bin`), "utf8"), "lower");
      } else {
        assert.equal(legacy.size, 0);
      }
      assert.equal(await readFile(upperPath, "utf8"), "upper");
    });
  });

  it("returns nothing for a missing directory", async () => {
    const legacy = await adoptLegacyTokenCacheFiles(join(tmpdir(), "openadminos-missing-dir-x"), DEFAULT_PARTITION);
    assert.equal(legacy.size, 0);
  });
});
