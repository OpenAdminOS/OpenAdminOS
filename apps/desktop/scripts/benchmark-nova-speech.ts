import { loadavg } from "node:os";
import { existsSync } from "node:fs";
import { readFile, mkdir, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installSpeechModels, kokoroAssets, kokoroVariants, whisperModels, type KokoroVariant } from "../electron/nova-speech/models.js";
import { loadKokoro } from "../electron/nova-speech/kokoro.js";
import { WhisperRuntime } from "../electron/nova-speech/whisper.js";

const [input, cache, choice] = process.argv.slice(2);
if (!input || !cache || (choice && choice !== "small" && choice !== "turbo")) {
  throw new Error("Usage: node --import tsx apps/desktop/scripts/benchmark-nova-speech.ts ten-seconds.wav cache-directory [small|turbo]");
}
const model = choice ?? (process.platform === "darwin" && process.arch === "arm64" ? "turbo" : "small");
const files = [whisperModels[model], kokoroVariants.q8, ...kokoroAssets];
const directory = resolve(cache, "nova-benchmark-" + model);
const signal = AbortSignal.timeout(30 * 60_000);
await mkdir(resolve(cache), { recursive: true });
if (!files.every(file => existsSync(join(directory, file.path)))) {
  await installSpeechModels({ target: directory, files, signal });
}
const executable = process.env.NOVA_BENCH_WHISPER ?? fileURLToPath(new URL("../build/nova-speech/" +
  (process.platform === "win32" ? "whisper-server.exe" : "whisper-server"), import.meta.url));
const whisper = new WhisperRuntime(executable, join(directory, whisperModels[model].path));
try {
  const wav = await readFile(input);
  await whisper.check(signal);
  const repetitions: number[] = [];
  const loads: number[] = [];
  let transcript = "";
  for (let repetition = 0; repetition < 4; repetition++) {
    const load = process.platform === "win32" ? undefined : loadavg()[0];
    const started = performance.now();
    const result = await whisper.transcribe(wav, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
    transcript = result.text;
    if (repetition > 0) {
      repetitions.push(Math.round(performance.now() - started));
      if (load !== undefined) loads.push(Number(load.toFixed(2)));
    }
  }
  console.info("Whisper median of 3 warm requests ms", [...repetitions].sort((a, b) => a - b)[1]);
  if (loads.length) console.info("One-minute load averages", loads.join(", "), Math.max(...loads) > 2 ? "(loaded)" : "");
  if (!transcript.trim()) throw new Error("Whisper found no speech in the benchmark WAV.");
  console.info("Whisper model", model);
  const variants = (process.env.NOVA_BENCH_KOKORO ?? "q8,fp32,fp16").split(",");
  for (const variant of variants) {
    if (!Object.hasOwn(kokoroVariants, variant)) throw new Error("Unknown Kokoro variant " + variant);
    try {
      const selected = variant as KokoroVariant;
      const modelFile = kokoroVariants[selected];
      const voiceDir = selected === "q8" ? directory : resolve(cache, "nova-benchmark-kokoro-" + selected);
      if (voiceDir !== directory) {
        if (!existsSync(join(voiceDir, modelFile.path))) {
          await installSpeechModels({ target: voiceDir, files: [modelFile], signal });
        }
        for (const file of kokoroAssets) {
          const target = join(voiceDir, file.path);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(directory, file.path), target);
        }
      }
      const started = performance.now();
      const speak = await loadKokoro(voiceDir, selected);
      console.info(variant, "model load ms", Math.round(performance.now() - started));
      const text = process.env.NOVA_BENCH_TEXT ?? transcript;
      const tts = performance.now();
      let first = true;
      let bytes = 0;
      for await (const { wav } of speak(text)) {
        if (first) console.info(variant, "first chunk ms", Math.round(performance.now() - tts));
        first = false;
        bytes += wav.length;
      }
      console.info(variant, "all chunks ms", Math.round(performance.now() - tts), "WAV bytes", bytes);
    } catch (error) {
      console.error(variant, error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
} finally {
  whisper.stop();
}
