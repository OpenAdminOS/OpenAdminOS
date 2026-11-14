import assert from "node:assert/strict";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { assertSupportedPlatform, readPrivateFile } from "./files.js";
import { SandboxRefusal } from "./refusal.js";
import { tempDir, writePrivate } from "./test-support.js";

const refused = (error: unknown) => error instanceof SandboxRefusal && error.reason === "file-permissions";

describe("readPrivateFile", () => {
  it("reads a private file and checks the file it read, not the path", () => {
    const { dir, cleanup } = tempDir();
    try {
      const open = writePrivate(join(dir, "open.json"), "{}", 0o644);
      const link = join(dir, "link.json");
      symlinkSync(open, link);
      assert.throws(() => readPrivateFile(link, "secrets file"), refused);
      assert.equal(readPrivateFile(writePrivate(join(dir, "private.json"), "{\"a\":1}"), "secrets file"), "{\"a\":1}");
      mkdirSync(join(dir, "folder"), { mode: 0o700 });
      assert.throws(() => readPrivateFile(join(dir, "folder"), "secrets file"), refused);
      assert.throws(() => readPrivateFile(join(dir, "missing.json"), "secrets file"), refused);
    } finally {
      cleanup();
    }
  });
});

describe("assertSupportedPlatform", () => {
  it("refuses Windows with a named reason", () => {
    assert.throws(() => assertSupportedPlatform("win32"), (error: unknown) => error instanceof SandboxRefusal && error.reason === "platform-not-supported");
    assertSupportedPlatform("linux");
    assertSupportedPlatform("darwin");
  });
});
