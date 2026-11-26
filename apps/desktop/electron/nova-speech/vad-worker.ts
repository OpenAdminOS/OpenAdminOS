import { validVadFrames, VAD_MODEL_SHA256 } from "./vad-protocol.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { InferenceSession, Tensor } from "onnxruntime-node";

const port = process.parentPort;
const path = process.argv.at(-1);
if (!port || !path) throw new Error("Nova detection requires a model.");
const model = await readFile(path);
if (createHash("sha256").update(model).digest("hex") !== VAD_MODEL_SHA256)
  throw new Error("Nova detection model failed verification.");
const session = await InferenceSession.create(model, { intraOpNumThreads: 1, interOpNumThreads: 1 });
const input = new Float32Array(576);
let state: Tensor = new Tensor("float32", new Float32Array(256), [2, 1, 128]);
const sr = new Tensor("int64", new BigInt64Array([16000n]), []);
let busy = false;
port.on("message", async ({ data }: { data: unknown }) => {
  if (busy || !validVadFrames(data)) { port.postMessage({ failed: true }); return; }
  busy = true;
  try {
    const scores: number[] = [];
    for (const frame of data) {
      input.set(frame, 64);
      const result = await session.run({ input: new Tensor("float32", input, [1, 576]), state, sr });
      state = result.stateN!;
      input.copyWithin(0, 512);
      scores.push(Number(result.output!.data[0]));
    }
    port.postMessage({ scores });
  } catch {
    port.postMessage({ failed: true });
  } finally {
    busy = false;
  }
});
port.postMessage({ ready: true });
