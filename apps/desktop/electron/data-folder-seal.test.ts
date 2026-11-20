import assert from "node:assert/strict";
import fs from "node:fs";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { dataFolderSealed, isSealedPath, sealDataFolder, unsealDataFolder } from "./data-folder-seal.js";

afterEach(() => unsealDataFolder());

describe("data folder seal", () => {
  it("refuses every change by path inside the sealed folder and nothing outside it", async () => {
    const base = await mkdtemp(join(tmpdir(), "openadminos-seal-"));
    const data = join(base, "OpenAdminOS");
    const outside = join(base, "elsewhere");
    try {
      mkdirSync(join(data, "agents"), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(data, "state.json"), "restored state");
      sealDataFolder(data);
      assert.equal(dataFolderSealed(), true);
      assert.equal(isSealedPath(join(data, "state.json")), true);
      assert.equal(isSealedPath(join(outside, "x")), false);

      // Promise, callback and sync forms, through named imports too.
      await assert.rejects(writeFile(join(data, "state.json"), "old"), { code: "EROFS" });
      await assert.rejects(mkdir(join(data, "agents", "draft")), { code: "EROFS" });
      await assert.rejects(rm(join(data, "agents"), { recursive: true }), { code: "EROFS" });
      await assert.rejects(rename(join(outside, "nothing"), join(data, "state.json")), { code: "EROFS" });
      await assert.rejects(open(join(data, "state.json"), "w"), { code: "EROFS" });
      assert.throws(() => writeFileSync(join(data, "state.json"), "old"), { code: "EROFS" });
      assert.throws(() => renameSync(join(data, "state.json"), join(outside, "moved")), { code: "EROFS" });
      assert.throws(() => createWriteStream(join(data, "log.txt")), { code: "EROFS" });
      await new Promise<void>((resolve) => {
        fs.writeFile(join(data, "state.json"), "old", (error) => {
          assert.equal((error as NodeJS.ErrnoException | null)?.code, "EROFS");
          resolve();
        });
      });

      // Reading stays possible, and the folder is unchanged.
      assert.equal(await readFile(join(data, "state.json"), "utf8"), "restored state");
      const handle = await open(join(data, "state.json"), "r");
      await handle.close();
      assert.deepEqual(fs.readdirSync(data).sort(), ["agents", "state.json"]);
      assert.ok(!existsSync(join(data, "log.txt")));

      // Outside the data folder everything still works.
      await writeFile(join(outside, "file"), "ok");
      assert.equal(readFileSync(join(outside, "file"), "utf8"), "ok");

      // A write queued behind an await before the seal is refused when it runs.
      unsealDataFolder();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const queued = (async () => {
        await gate;
        await writeFile(join(data, "state.json"), "queued");
      })();
      sealDataFolder(data);
      release();
      await assert.rejects(queued, { code: "EROFS" });
      assert.equal(readFileSync(join(data, "state.json"), "utf8"), "restored state");

      // Unsealed again (a refused reset), writes work.
      unsealDataFolder();
      await writeFile(join(data, "state.json"), "saved");
      assert.equal(readFileSync(join(data, "state.json"), "utf8"), "saved");
    } finally {
      unsealDataFolder();
      await rm(base, { recursive: true, force: true });
    }
  });
});
