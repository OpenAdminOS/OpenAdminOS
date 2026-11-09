import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { syncDirectory, writeFileDurably } from "./durable-file.js";

function fakeOpen(options: { syncError?: NodeJS.ErrnoException; windows?: boolean } = {}) {
  const calls: Array<{ path: string; flags: string; synced: boolean; written: string }> = [];
  const openFile = async (path: string, flags: string) => {
    const call = { path, flags, synced: false, written: "" };
    calls.push(call);
    return {
      writeFile: async (data: string) => {
        call.written = data;
      },
      sync: async () => {
        // Windows FlushFileBuffers fails on a handle without write access.
        if (options.windows && !/[wa+]/.test(flags)) throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" });
        if (options.syncError) throw options.syncError;
        call.synced = true;
      },
      close: async () => undefined,
    };
  };
  return { calls, openFile };
}

describe("durable state writes (design round review 2)", () => {
  it("flushes through the writable handle it wrote with, as Windows requires", async () => {
    const fs = fakeOpen({ windows: true });
    await writeFileDurably("/state/state.json.tmp", "{}", { durable: true, openFile: fs.openFile });
    assert.equal(fs.calls.length, 1);
    assert.match(fs.calls[0]!.flags, /w/);
    assert.equal(fs.calls[0]!.synced, true);
    assert.equal(fs.calls[0]!.written, "{}");
  });

  it("does not flush a write that holds no audit history", async () => {
    const fs = fakeOpen();
    await writeFileDurably("/state/state.json.tmp", "{}", { durable: false, openFile: fs.openFile });
    assert.equal(fs.calls[0]!.synced, false);
  });

  it("skips the directory flush on Windows and surfaces other failures", async () => {
    const fs = fakeOpen();
    await syncDirectory("/state", { platform: "win32", openFile: fs.openFile });
    assert.equal(fs.calls.length, 0);
    const failing = fakeOpen({ syncError: Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" }) });
    await assert.rejects(syncDirectory("/state", { platform: "linux", openFile: failing.openFile }), /EIO/);
    const unsupported = fakeOpen({ syncError: Object.assign(new Error("EINVAL"), { code: "EINVAL" }) });
    await syncDirectory("/state", { platform: "linux", openFile: unsupported.openFile });
  });
});
