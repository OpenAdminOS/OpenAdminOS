import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { InferenceSession, Tensor } from "onnxruntime-node";
import { kokoroVariants, productionKokoroVariant, type KokoroVariant } from "./models.js";
import { speechThreads } from "./threads.js";
import { englishPhonemes, type Lexicon } from "./kokoro-english.js";

export async function loadKokoro(directory: string, variant: KokoroVariant = productionKokoroVariant) {
  const [session, voice, tokenizer, gold, silver] = await Promise.all([
    InferenceSession.create(join(directory, kokoroVariants[variant].path), {
      executionProviders: ["cpu"], intraOpNumThreads: Math.min(4, speechThreads()),
    }),
    readFile(join(directory, "voices", "af_heart.bin")),
    readFile(join(directory, "tokenizer.json"), "utf8"),
    readFile(join(directory, "misaki/data/us_gold.json"), "utf8").then(data => JSON.parse(data) as Lexicon),
    readFile(join(directory, "misaki/data/us_silver.json"), "utf8").then(data => JSON.parse(data) as Lexicon),
  ]);
  const { model: { vocab } } = JSON.parse(tokenizer) as { model: { vocab: Record<string, number> } };
  return async function* (text: string): AsyncGenerator<{ wav: Buffer; remainingText: string }> {
    let produced = false;
    const remaining = speechParts(text);
    while (remaining.length > 0) {
      const part = remaining.shift()!;
      const phones = englishPhonemes(part, gold, silver);
      const ids = Array.from(phones).flatMap((phone) => Object.hasOwn(vocab, phone) ? [vocab[phone]!] : []);
      if (ids.length === 0) continue;
      if (ids.length > 510 && Array.from(part).length > 1) {
        const letters = Array.from(part);
        const middle = Math.floor(letters.length / 2);
        const boundary = letters.lastIndexOf(" ", middle);
        const split = boundary > 0 ? boundary : middle;
        remaining.unshift(letters.slice(0, split).join("").trim(), letters.slice(split).join("").trim());
        continue;
      }
      const idsWithBoundaries = BigInt64Array.from([0, ...ids.slice(0, 510), 0].map(BigInt));
      const styleRow = Math.min(ids.length, 509);
      const style = Float32Array.from({ length: 256 }, (_, index) => voice.readFloatLE((styleRow * 256 + index) * 4));
      const { waveform } = await session.run({
        input_ids: new Tensor("int64", idsWithBoundaries, [1, idsWithBoundaries.length]),
        style: new Tensor("float32", style, [1, 256]),
        speed: new Tensor("float32", [1], [1]),
      });
      if (!(waveform?.data instanceof Float32Array)) throw new Error("Kokoro did not return audio.");
      produced = true;
      yield { wav: waveformWav(waveform.data), remainingText: remaining.join(" ") };
    }
    if (!produced) throw new Error("Kokoro did not find speakable text.");
  };
}

export function speechParts(text: string): string[] {
  const sentence = /(?<=[.!?])\s+/u;
  const words = text.trim().split(/\s+/u);
  const first = words.slice(0, 6).join(" ").match(/^.+?[,:;.!?](?=\s|$)/u)?.[0]
    ?? words.slice(0, 6).join(" ");
  if (!first) return [];
  const rest = words.join(" ").slice(first.length).trim();
  return [first, ...rest.split(sentence).flatMap(part => part.match(/.{1,200}(?:\s|$)|.{1,200}/gu) ?? [])];
}

function waveformWav(wave: Float32Array): Buffer {
  const size = 2 * wave.length;
  const wav = Buffer.alloc(44 + size);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + size, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(size, 40);
  let offset = 44;
  for (const sample of wave) {
    wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), offset);
    offset += 2;
  }
  return wav;
}
