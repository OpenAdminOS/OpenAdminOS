import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RetrievalStatus } from "@openadminos/agent-sdk";

export type { RetrievalStatus } from "@openadminos/agent-sdk";

/**
 * Local documentation retrieval, ported from `model/eval/retrieve.mjs`
 * so app answers match what the model bench measures. Everything is
 * local: the index is a set of files on disk, and query embedding hits
 * a loopback embedding server. When a local provider is selected, no
 * part of retrieval may call a remote service.
 *
 * The index and its embedding model are a matched pair: the index
 * stores vectors from one specific model, so the query must be embedded
 * by the same model or the cosine scores are meaningless.
 */

export interface RetrievalIndexMeta {
  dim: number;
  embeddingModel: string;
  builtAt: string;
  chunkCount: number;
  sources?: string[];
}

export interface RetrievedChunk {
  file: string;
  title?: string;
  text: string;
  score: number;
}


export interface EmbedQuery {
  (text: string): Promise<number[]>;
}

interface LoadedIndex {
  meta: RetrievalIndexMeta;
  chunks: Array<{ file: string; title?: string; text: string }>;
  matrix: Float32Array;
  norms: Float32Array;
}

export class RetrievalIndex {
  private loaded: LoadedIndex | null = null;
  private loadError: string | null = null;

  constructor(private readonly indexDir: string) {}

  status(): RetrievalStatus {
    try {
      const index = this.ensureLoaded();
      return {
        available: true,
        builtAt: index.meta.builtAt,
        chunkCount: index.meta.chunkCount,
        embeddingModel: index.meta.embeddingModel,
        dim: index.meta.dim,
      };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Retrieve the top-k chunks for a query. `embedQuery` must use the
   * same embedding model the index was built with. Returns [] when the
   * index is unavailable so callers can degrade to an honest
   * "not documentation-grounded" state rather than throwing.
   */
  async retrieve(
    query: string,
    embedQuery: EmbedQuery,
    options: { k?: number } = {},
  ): Promise<RetrievedChunk[]> {
    let index: LoadedIndex;
    try {
      index = this.ensureLoaded();
    } catch {
      return [];
    }
    const k = Math.max(1, Math.min(options.k ?? 12, 50));
    const q = await embedQuery(query);
    if (q.length !== index.meta.dim) {
      throw new Error(
        `Query embedding has ${q.length} dimensions but the index expects ${index.meta.dim}. The embedding model does not match the index.`,
      );
    }
    let qNorm = 0;
    for (const value of q) qNorm += value * value;
    qNorm = Math.sqrt(qNorm) || 1;

    const dim = index.meta.dim;
    const count = index.chunks.length;
    const scored: Array<{ i: number; score: number }> = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const off = i * dim;
      let dot = 0;
      for (let j = 0; j < dim; j += 1) dot += index.matrix[off + j]! * q[j]!;
      const denom = qNorm * (index.norms[i]! || 1);
      scored[i] = { i, score: denom === 0 ? 0 : dot / denom };
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k).map(({ i, score }) => ({
      file: index.chunks[i]!.file,
      ...(index.chunks[i]!.title ? { title: index.chunks[i]!.title } : {}),
      text: index.chunks[i]!.text,
      score,
    }));
  }

  private ensureLoaded(): LoadedIndex {
    if (this.loaded) return this.loaded;
    if (this.loadError) throw new Error(this.loadError);
    try {
      this.loaded = loadIndexFrom(this.indexDir);
      return this.loaded;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      throw new Error(this.loadError);
    }
  }

  /** Drop the cached index so a refreshed index is picked up. */
  reset(): void {
    this.loaded = null;
    this.loadError = null;
  }
}

/**
 * Accept the index metadata as the build pipeline writes it.
 *
 * The pipeline emits `{dim, count, corpora, when}`; this module was
 * written against `{dim, chunkCount, embeddingModel, builtAt}`. Rather
 * than force one side to change and break the other, normalise here.
 * `embeddingModel` is absent in pipeline output, so it falls back to the
 * model the corpus was built with; the dimension check below is what
 * actually catches a mismatched embedding model at query time.
 */
export function normalizeIndexMeta(raw: Record<string, unknown>): RetrievalIndexMeta {
  const dim = typeof raw.dim === "number" ? raw.dim : Number.NaN;
  if (!Number.isFinite(dim) || dim <= 0) {
    throw new Error("The index metadata does not declare a vector dimension.");
  }
  const chunkCount =
    typeof raw.chunkCount === "number"
      ? raw.chunkCount
      : typeof raw.count === "number"
        ? raw.count
        : 0;
  const builtAt =
    typeof raw.builtAt === "string"
      ? raw.builtAt
      : typeof raw.when === "string"
        ? raw.when
        : "unknown";
  const embeddingModel =
    typeof raw.embeddingModel === "string" && raw.embeddingModel
      ? raw.embeddingModel
      : DEFAULT_INDEX_EMBEDDING_MODEL;
  const sources = Array.isArray(raw.corpora)
    ? raw.corpora.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  return {
    dim,
    chunkCount,
    builtAt,
    embeddingModel,
    ...(sources && sources.length > 0 ? { sources } : {}),
  };
}

/** What the published index corpus was embedded with. */
export const DEFAULT_INDEX_EMBEDDING_MODEL = "nomic-embed-text";

function loadIndexFrom(dir: string): LoadedIndex {
  const metaPath = join(dir, "index-meta.json");
  if (!existsSync(metaPath)) {
    throw new Error(
      "The documentation index is not installed. Answers are not documentation-grounded yet.",
    );
  }
  const meta = normalizeIndexMeta(
    JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>,
  );
  const chunks = readFileSync(join(dir, "chunks.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { file: string; title?: string; text: string });
  const raw = readFileSync(join(dir, "embeddings.f32"));
  const matrix = new Float32Array(
    raw.buffer,
    raw.byteOffset,
    Math.floor(raw.byteLength / 4),
  );
  if (chunks.length * meta.dim !== matrix.length) {
    throw new Error(
      `Documentation index is corrupt: ${chunks.length} chunks but ${matrix.length / meta.dim} vectors. Rebuild the index.`,
    );
  }
  // Precompute per-chunk norms once so retrieval is a single dot loop.
  const norms = new Float32Array(chunks.length);
  for (let i = 0; i < chunks.length; i += 1) {
    const off = i * meta.dim;
    let n = 0;
    for (let j = 0; j < meta.dim; j += 1) {
      const v = matrix[off + j]!;
      n += v * v;
    }
    norms[i] = Math.sqrt(n);
  }
  return { meta, chunks, matrix, norms };
}

/**
 * Query embedding against a loopback OpenAI-compatible embedding server
 * (the app's local model runtime on its embedding port). The
 * "search_query:" prefix matches how the index passages were embedded.
 */
export function loopbackEmbedQuery(endpoint: string): EmbedQuery {
  return async (text: string) => {
    assertLoopback(endpoint);
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [`search_query: ${text}`] }),
    });
    if (!response.ok) {
      throw new Error(`Embedding server responded with HTTP ${response.status}.`);
    }
    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const embedding = payload.data?.[0]?.embedding;
    if (!Array.isArray(embedding)) {
      throw new Error("Embedding server returned no embedding vector.");
    }
    return embedding;
  };
}

/**
 * Query embedding through the local Ollama the app already manages.
 *
 * The model bench served the embedding model on its own port; reusing
 * Ollama avoids a second process to install, supervise and firewall,
 * and `nomic-embed-text` there is the same nomic-embed-text-v1.5 that
 * built the index (768 dimensions). The `search_query:` prefix matches
 * how the passages were embedded, and is what makes the vectors
 * comparable.
 */
export function ollamaEmbedQuery(
  endpoint: string,
  model = "nomic-embed-text",
): EmbedQuery {
  return async (text: string) => {
    assertLoopback(endpoint);
    const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input: `search_query: ${text}` }),
    });
    if (!response.ok) {
      throw new Error(
        `Embedding request failed with HTTP ${response.status}. Pull the model with \`ollama pull ${model}\`.`,
      );
    }
    const payload = (await response.json()) as { embeddings?: number[][] };
    const embedding = payload.embeddings?.[0];
    if (!Array.isArray(embedding)) {
      throw new Error("The embedding service returned no vector.");
    }
    return embedding;
  };
}

function assertLoopback(endpoint: string): void {
  const url = new URL(endpoint);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(
      "Refusing to embed a query against a non-loopback endpoint. Retrieval must stay local.",
    );
  }
}

/** Render retrieved passages for a prompt, keeping provenance attached. */
export function formatRetrievedContext(chunks: readonly RetrievedChunk[]): string {
  if (chunks.length === 0) return "";
  return chunks
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.title ? `${chunk.title} - ` : ""}${chunk.file}\n${chunk.text.trim()}`,
    )
    .join("\n\n");
}
