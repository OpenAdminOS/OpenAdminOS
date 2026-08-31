import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeIndexMeta } from "./retrieval.js";

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

/** Checksum manifest published alongside the index files. */
export const INDEX_CHECKSUM_FILE = "SHA256SUMS.txt";

/**
 * Where the published documentation index lives.
 *
 * GitHub release assets are free to download with no bandwidth limit and
 * allow files just under 2 GiB, which suits a 264 MB index far better
 * than the marketing site's host. The index ships on its own tag so it
 * can be rebuilt on the documentation's cadence without cutting an app
 * release.
 */
export const DEFAULT_INDEX_BASE_URL =
  "https://github.com/OpenAdminOS/OpenAdminOS/releases/download/docs-index-2026-08-26";

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
  const meta = normalizeIndexMeta(
    JSON.parse(await readFile(join(dir, "index-meta.json"), "utf8")) as Record<
      string,
      unknown
    >,
  );
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

  // Fetch the checksum manifest first when it is published. Size alone
  // catches a truncated download; only a hash catches a corrupted or
  // substituted one.
  let checksums = new Map<string, string>();
  try {
    const sums = await doFetch(`${base}/${INDEX_CHECKSUM_FILE}`, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (sums.ok) checksums = parseChecksums(await sums.text());
  } catch {
    // A missing manifest is not fatal; the consistency check still runs.
  }

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
    const expected = checksums.get(file);
    if (expected) {
      const actual = createHash("sha256").update(buffer).digest("hex");
      if (actual !== expected) {
        throw new Error(
          `${file} does not match its published checksum. The download was corrupted or tampered with, so it was discarded.`,
        );
      }
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

/** Parse a `sha256  filename` manifest into a map. */
export function parseChecksums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (match) map.set(match[2]!.trim(), match[1]!.toLowerCase());
  }
  return map;
}

async function promoteStaging(staging: string, target: string): Promise<void> {
  // Replace only after validation so a failed install never leaves a
  // half-written index where a working one used to be.
  await rm(`${target}.previous`, { recursive: true, force: true });
  if (existsSync(target)) await rename(target, `${target}.previous`);
  await rename(staging, target);
  await rm(`${target}.previous`, { recursive: true, force: true });
}
