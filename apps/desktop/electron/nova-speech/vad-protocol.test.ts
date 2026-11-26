import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { validVadFrames, VAD_MODEL_SHA256 } from "./vad-protocol.js";

test("pins the bundled Silero model to its verified SHA-256", async () => {
  const model = await readFile(new URL("../native/nova-vad/silero_vad.onnx", import.meta.url));
  assert.equal(createHash("sha256").update(model).digest("hex"), VAD_MODEL_SHA256);
});

test("rejects invalid utility process frame batches", () => {
  assert.equal(validVadFrames(Array.from({ length: 4 }, () => new Float32Array(512))), true);
  for (const value of [null, [], Array(2), Array(9).fill(new Float32Array(512)), [new Float32Array(511)],
    [new Float32Array(512).fill(NaN)], [new Float32Array(512).fill(1.1)]]) {
    assert.equal(validVadFrames(value), false);
  }
});

test("retries a failed batch on one fresh worker", async () => {
  const { EventEmitter } = await import("node:events");
  const { NovaVad } = await import("./vad.js");
  const controller = new AbortController();
  let forks = 0;
  const vad = new NovaVad("fixture.onnx", controller.signal, () => {
    const child = new EventEmitter();
    const first = ++forks === 1;
    queueMicrotask(() => child.emit("message", { ready: true }));
    return Object.assign(child, {
      kill: () => child.emit("exit", 0),
      postMessage: () => queueMicrotask(() => {
        if (first) child.emit("exit", 1);
        else child.emit("message", { scores: [0.9] });
      }),
    }) as unknown as import("electron").UtilityProcess;
  });
  assert.deepEqual(await vad.score([new Float32Array(512)]), [0.9]);
  assert.equal(forks, 2);
  controller.abort();
});
