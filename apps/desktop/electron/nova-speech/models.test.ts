import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sealDataFolder, unsealDataFolder } from "../data-folder-seal.js";
import { installSpeechModels } from "./models.js";

const content = "model data";
const file = {
  path: "onnx/model.onnx",
  url: "https://example.invalid/model.onnx",
  bytes: Buffer.byteLength(content),
  sha256: createHash("sha256").update(content).digest("hex"),
};

test("speech models become visible together only after verification", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nova-model-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "models");
  const progress: number[] = [];
  await installSpeechModels({
    target,
    files: [file, { ...file, path: "voices/voice.bin" }],
    signal: new AbortController().signal,
    fetchImpl: async () => {
      await assert.rejects(readFile(join(target, file.path)), { code: "ENOENT" });
      return new Response(content);
    },
    onProgress: (received, total) => {
      assert.equal(total, file.bytes * 2);
      progress.push(received);
    },
  });
  assert.deepEqual(progress, [file.bytes, file.bytes * 2]);
  assert.equal(await readFile(join(target, file.path), "utf8"), content);
  assert.deepEqual(await readdir(root), ["models"]);
});

for (const failure of ["checksum", "cancel", "reset"] as const) {
  test(`speech model installation refuses ${failure} before promotion`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "nova-model-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const controller = new AbortController();
    try {
      await assert.rejects(installSpeechModels({
        target: join(root, "models"),
        files: [file],
        signal: controller.signal,
        fetchImpl: async () => new Response(failure === "checksum" ? "bad  data!" : content),
        onProgress: () => {
          if (failure === "cancel") controller.abort();
          if (failure === "reset") sealDataFolder();
        },
      }), {
        name: failure === "cancel" ? "AbortError" : failure === "reset" ? "DataFolderSealedError" : "Error",
        ...(failure === "checksum" ? { message: /integrity verification/ } : {}),
      });
      assert.ok(!(await readdir(root)).includes("models"));
      if (failure !== "reset") assert.deepEqual(await readdir(root), []);
    } finally {
      unsealDataFolder();
    }
  });
}
