import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { InferenceSession, Tensor } from "onnxruntime-node";

const port = process.parentPort;
const path = process.argv.at(-1);
if (!port || !path) throw new Error("Nova detection requires a model.");
// Silero VAD v6.2.1, upstream commit 7e30209a3e901f9842f81b225f3e93d8199902b1.
const model = await readFile(path);
if (createHash("sha256").update(model).digest("hex") !== "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3")
  throw new Error("Nova detection model failed verification.");
const session = await InferenceSession.create(model, { intraOpNumThreads: 1, interOpNumThreads: 1 });
const input = new Float32Array(576);
let state: Tensor = new Tensor("float32", new Float32Array(256), [2, 1, 128]);
const sr = new Tensor("int64", new BigInt64Array([16000n]), []);
port.on("message", async ({ data }: { data: Float32Array }) => {
  try {
    input.set(data, 64);
    const result = await session.run({ input: new Tensor("float32", input, [1, 576]), state, sr });
    state = result.stateN!;
    input.copyWithin(0, 512);
    port.postMessage({ score: Number(result.output!.data[0]) });
  } catch {
    port.postMessage({ failed: true });
  }
});
port.postMessage({ ready: true });
