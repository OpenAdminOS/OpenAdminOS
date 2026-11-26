import { loadKokoro } from "./kokoro.js";

const port = process.parentPort;
const model = process.argv.at(-1);
if (!port || !model) throw new Error("Kokoro worker requires its parent and model directory.");

const started = performance.now();
const speak = await loadKokoro(model);
port.on("message", async ({ data }: { data: { id: number; text: string } }) => {
  const start = performance.now();
  try {
    let first = true;
    for await (const { wav: audio, remainingText } of speak(data.text)) {
      port.postMessage({ id: data.id, audio, remainingText, ...(first ? { firstAudioMs: Math.round(performance.now() - start) } : {}) });
      first = false;
    }
    port.postMessage({ id: data.id, done: true, wavReadyMs: Math.round(performance.now() - start) });
  } catch {
    port.postMessage({ id: data.id, failed: true });
  }
});
port.postMessage({ ready: true, loadMs: Math.round(performance.now() - started) });
