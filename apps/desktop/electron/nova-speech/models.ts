import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, renameSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DataFolderSealedError, dataFolderSealed } from "../data-folder-seal.js";

export type ModelFile = Readonly<{ path: string; url: string; bytes: number; sha256: string }>;

function modelFile(base: string, path: string, bytes: number, sha256: string): ModelFile {
  return { path, url: base + path, bytes, sha256 };
}

const whisper = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/";
const kokoro = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/";

export const whisperModels = {
  small: modelFile(whisper, "ggml-small-q5_1.bin", 190085487, "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb"),
  turbo: modelFile(whisper, "ggml-large-v3-turbo-q5_0.bin", 574041195, "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
} as const;

const misaki = "https://raw.githubusercontent.com/hexgrad/misaki/fba1236595f2d2bf21d414ba6e57d25256afada3/";

export const kokoroVariants = {
  fp32: modelFile(kokoro, "onnx/model.onnx", 325532232, "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb"),
  fp16: modelFile(kokoro, "onnx/model_fp16.onnx", 163234740, "ba4527a874b42b21e35f468c10d326fdff3c7fc8cac1f85e9eb6c0dfc35c334a"),
  q8: modelFile(kokoro, "onnx/model_quantized.onnx", 92361116, "fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478"),
} as const;
export type KokoroVariant = keyof typeof kokoroVariants;

export const productionKokoroVariant = "fp16";
export const kokoroAssets = [
  modelFile(kokoro, "voices/af_heart.bin", 522240, "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b"),
  modelFile(kokoro, "tokenizer.json", 3497, "77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34"),
  modelFile(misaki, "LICENSE", 11357, "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"),
  modelFile(misaki, "misaki/data/us_gold.json", 3000469, "dc414872a49a28ae6c141463d502fd945f3b2fde040484fdc47d00cc4612686f"),
  modelFile(misaki, "misaki/data/us_silver.json", 3099517, "de8f67be911bb6c659187b4a65fd966b6a30e56350e0f790d763210b053ac475"),
] as const;

export const kokoroModels = [kokoroVariants[productionKokoroVariant], ...kokoroAssets] as const;

/** Install a model set into a new version directory on the same volume. */
export async function installSpeechModels(input: {
  target: string;
  files: readonly ModelFile[];
  signal: AbortSignal;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { target, files, signal, onProgress, fetchImpl = fetch } = input;
  assertWritable(signal);
  await mkdir(dirname(target), { recursive: true });
  assertWritable(signal);
  const staging = await mkdtemp(target + ".staging-");
  const total = files.reduce((bytes, file) => bytes + file.bytes, 0);
  let received = 0;
  const directories = new Set([staging]);

  try {
    for (const file of files) {
      assertWritable(signal);
      const destination = join(staging, file.path);
      await mkdir(dirname(destination), { recursive: true });
      for (let current = dirname(destination); current !== staging; current = dirname(current)) directories.add(current);
      const response = await fetchImpl(file.url, { signal, credentials: "omit" });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`Model download failed (HTTP ${response.status}). Retry setup.`);
      }
      const hash = createHash("sha256");
      let size = 0;
      const measure = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > file.bytes) {
            done(new Error("Model download exceeded its expected size. Retry setup."));
            return;
          }
          hash.update(chunk);
          received += chunk.length;
          try {
            assertWritable(signal);
            onProgress?.(received, total);
            done(null, chunk);
          } catch (error) {
            done(error as Error);
          }
        },
      });
      await pipeline(
        Readable.from(response.body),
        measure,
        createWriteStream(destination, { flags: "wx", flush: true }),
        { signal },
      );
      if (size !== file.bytes || hash.digest("hex") !== file.sha256) {
        throw new Error("Model download failed integrity verification. Retry setup.");
      }
    }
    // Windows does not support opening directories for fsync through Node.
    if (process.platform !== "win32") {
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
        await syncDirectory(directory);
      }
    }
    assertWritable(signal);
    renameSync(staging, target);
    if (process.platform !== "win32") await syncDirectory(dirname(target));
  } finally {
    if (!dataFolderSealed()) await rm(staging, { recursive: true, force: true });
  }
}

function assertWritable(signal: AbortSignal): void {
  signal.throwIfAborted();
  if (dataFolderSealed()) throw new DataFolderSealedError();
}

async function syncDirectory(path: string) {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export class SpeechModelIntegrity {
  private readonly verified = new Map<string, string>();

  async check(target: string, files: readonly ModelFile[], signal: AbortSignal): Promise<boolean> {
    try {
      for (const file of files) {
        signal.throwIfAborted();
        const path = join(target, file.path);
        const before = await stat(path);
        if (!before.isFile() || before.size !== file.bytes) return false;
        const stamp = fileStamp(before);
        if (this.verified.get(path) === stamp) continue;
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
        if (hash.digest("hex") !== file.sha256 || fileStamp(await stat(path)) !== stamp) return false;
        this.verified.set(path, stamp);
      }
      return true;
    } catch (error) {
      signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}

function fileStamp(stat: { size: number; mtimeMs: number; ctimeMs: number; ino: number }) {
  return `${stat.size}/${stat.mtimeMs}/${stat.ctimeMs}/${stat.ino}`;
}
