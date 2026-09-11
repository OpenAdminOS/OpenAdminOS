import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { atomicRename } from "./atomic-rename.js";

test("Windows replacement preserves the previous file while retrying a temporary lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-rename-"));
  const source = join(dir, "state.tmp"),
    destination = join(dir, "state.json");
  const delays: number[] = [];
  let attempts = 0;
  try {
    await writeFile(source, "new state");
    await writeFile(destination, "previous state");
    await atomicRename(source, destination, {
      platform: "win32",
      replace: async (from, to) => {
        if (attempts++ < 2)
          throw Object.assign(new Error("locked"), { code: "EPERM" });
        await rename(from, to);
      },
      wait: async (ms) => {
        delays.push(ms);
        assert.equal(await readFile(destination, "utf8"), "previous state");
        assert.equal(await readFile(source, "utf8"), "new state");
      },
    });
    assert.deepEqual(delays, [20, 40]);
    assert.equal(await readFile(destination, "utf8"), "new state");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("permanent Windows access failures stop after bounded retries and retain the error", async () => {
  const error = Object.assign(new Error("access denied"), { code: "EACCES" });
  let attempts = 0,
    waited = 0;
  await assert.rejects(
    atomicRename("source", "destination", {
      platform: "win32",
      replace: async () => {
        attempts++;
        throw error;
      },
      wait: async (ms) => {
        waited += ms;
      },
    }),
    (caught) => caught === error,
  );
  assert.equal(attempts, 7);
  assert.equal(waited, 1260);
});

test("non-Windows errors and non-lock failures are reported without retrying", async () => {
  for (const [platform, code] of [
    ["linux", "EPERM"],
    ["darwin", "EBUSY"],
    ["win32", "ENOENT"],
  ] as const) {
    let attempts = 0;
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(
      atomicRename("source", "destination", {
        platform,
        replace: async () => {
          attempts++;
          throw error;
        },
        wait: async () => assert.fail("Unexpected retry"),
      }),
      (caught) => caught === error,
    );
    assert.equal(attempts, 1);
  }
});
