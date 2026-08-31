import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Installing a documentation index.
 *
 * The index is far too large to bundle in an installer that already
 * carries a model, so it arrives after first run: either fetched from a
 * URL or pointed at a folder the admin already has (an air-gapped site
 * can copy it in by hand). Either way it lands in a staging directory
 * and is validated before it replaces a working index, so a truncated
 * download cannot leave the app with a corrupt index.
 */

export const INDEX_FILES = ["index-meta.json", "chunks.jsonl", "embeddings.f32"] as const;

export interface InstallProgress {
  file: string;
  receivedBytes: number;
  totalBytes?: number;
}

export interface InstallResult {
  installed: boolean;
  chunkCount: number;
  dim: number;
  embeddingModel: string;
  builtAt: string;
}

/** Validate a staged index directory, returning its metadata. */
export async function validateIndexDirectory(dir: string): Promise<InstallResult> {
  for (const file of INDEX_FILES) {
    if (!existsSync(join(dir, file))) {
      throw new Error(`The index is incomplete: ${file} is missing.`);
    }
  }
  const meta = JSON.parse(await readFile(join(dir, "index-meta.json"), "utf8")) as {
    dim?: unknown;
    chunkCount?: unknown;
    embeddingModel?: unknown;
    builtAt?: unknown;
  };
  if (typeof meta.dim !== "number" || meta.dim <= 0) {
    throw new Error("The index metadata does not declare a vector dimension.");
  }
  if (typeof meta.embeddingModel !== "string" || !meta.embeddingModel) {
    throw new Error(
      "The index metadata does not name the embedding model it was built with. Without it the vectors cannot be trusted to match.",
    );
  }
  const chunkLines = (await readFile(join(dir, "chunks.jsonl"), "utf8"))
    .split("\n")
    .filter(Boolean).length;
  const vectorBytes = (await readFile(join(dir, "embeddings.f32"))).byteLength;
  const vectors = Math.floor(vectorBytes / 4 / meta.dim);
  if (chunkLines !== vectors) {
    throw new Error(
      `The index is inconsistent: ${chunkLines} chunks but ${vectors} vectors. The download is probably truncated.`,
    );
  }
  return {
    installed: true,
    chunkCount: chunkLines,
    dim: meta.dim,
    embeddingModel: meta.embeddingModel,
    builtAt: typeof meta.builtAt === "string" ? meta.builtAt : "unknown",
  };
}

/** Copy an already-downloaded index from a local folder. */
export async function installIndexFromDirectory(input: {
  sourceDir: string;
  targetDir: string;
}): Promise<InstallResult> {
  const staging = `${input.targetDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  for (const file of INDEX_FILES) {
    const from = join(input.sourceDir, file);
    if (!existsSync(from)) {
      throw new Error(`The selected folder is not an index: ${file} is missing.`);
    }
    await writeFile(join(staging, file), await readFile(from));
  }
  const result = await validateIndexDirectory(staging);
  await promoteStaging(staging, input.targetDir);
  return result;
}

/**
 * Fetch an index from a base URL. Each file is streamed to staging and
 * the set is validated before it replaces the installed index.
 */
export async function downloadIndex(input: {
  baseUrl: string;
  targetDir: string;
  onProgress?: (progress: InstallProgress) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<InstallResult> {
  const doFetch = input.fetchImpl ?? fetch;
  const base = input.baseUrl.replace(/\/$/, "");
  const staging = `${input.targetDir}.staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });

  for (const file of INDEX_FILES) {
    const response = await doFetch(`${base}/${file}`, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!response.ok) {
      throw new Error(`Downloading ${file} failed with HTTP ${response.status}.`);
    }
    const declared = Number(response.headers.get("content-length") ?? "");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (Number.isFinite(declared) && declared > 0 && buffer.byteLength !== declared) {
      throw new Error(
        `${file} downloaded ${buffer.byteLength} bytes but the server declared ${declared}. Treating it as truncated.`,
      );
    }
    await writeFile(join(staging, file), buffer);
    input.onProgress?.({
      file,
      receivedBytes: buffer.byteLength,
      ...(Number.isFinite(declared) && declared > 0 ? { totalBytes: declared } : {}),
    });
  }

  const result = await validateIndexDirectory(staging);
  await promoteStaging(staging, input.targetDir);
  return result;
}

/** Content hash of the installed index, for support and reproducibility. */
export async function indexDigest(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of INDEX_FILES) {
    hash.update(await readFile(join(dir, file)));
  }
  return hash.digest("hex").slice(0, 16);
}

async function promoteStaging(staging: string, target: string): Promise<void> {
  // Replace only after validation so a failed install never leaves a
  // half-written index where a working one used to be.
  await rm(`${target}.previous`, { recursive: true, force: true });
  if (existsSync(target)) await rename(target, `${target}.previous`);
  await rename(staging, target);
  await rm(`${target}.previous`, { recursive: true, force: true });
}
