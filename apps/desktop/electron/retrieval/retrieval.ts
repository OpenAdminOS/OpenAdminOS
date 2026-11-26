import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { RetrievalStatus } from "@openadminos/agent-sdk";
import { isConnectionRefused, isRefusedRedirect, modelServerRedirect, redirectRefusedDetail } from "@openadminos/runtime";

import { loopbackTransport } from "./direct-fetch.js";

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
  /**
   * Index release version, e.g. "2026-08-26". Compared against the
   * published manifest to decide whether a newer index exists. Falls
   * back to the build date when the file predates versioning.
   */
  version: string;
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
        version: index.meta.version,
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
    const raw = await embedQuery(query);
    if (raw.length !== index.meta.dim) {
      throw new Error(
        `Query embedding has ${raw.length} dimensions but the index expects ${index.meta.dim}. The embedding model does not match the index.`,
      );
    }
    // Cosine similarity does not depend on scale: dividing by the largest entry keeps a huge
    // but finite vector from overflowing its norm and scoring every passage as 0.
    let largest = 0;
    for (const value of raw) largest = Math.max(largest, Math.abs(value));
    const q = largest > 0 ? raw.map((value) => value / largest) : raw;
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
  const version =
    typeof raw.version === "string" && raw.version
      ? raw.version
      : builtAt.slice(0, 10);
  return {
    dim,
    chunkCount,
    builtAt,
    embeddingModel,
    version,
    ...(sources && sources.length > 0 ? { sources } : {}),
  };
}

/** What the published index corpus was embedded with. */
export const DEFAULT_INDEX_EMBEDDING_MODEL = "nomic-embed-text";

/** Front matter at the start of a chunk. It may open with comment lines, and its closing line may carry trailing spaces. */
const FRONT_MATTER = /^\uFEFF?---[ \t]*\r?\n((?:#[^\n]*\r?\n)*[\w.-]+:[\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * Repairs chunks of an index built before front matter with a trailing
 * space on its closing line was stripped. Such a page kept its front
 * matter in the first chunk and took its title from the YAML comment
 * "# Customer intent: ...". The front matter title becomes the title of
 * every chunk of that page, and the front matter leaves the text. A page
 * without a front matter title whose title was such a comment takes its
 * first heading, or its file path. The vectors are not touched, so the
 * ranking stays as built.
 */
export function repairFrontMatter<T extends { file: string; title?: string; text: string }>(chunks: T[]): T[] {
  const titles = new Map<string, string>();
  const cleaned = chunks.map((chunk) => {
    const match = FRONT_MATTER.exec(chunk.text);
    if (!match) return chunk;
    const body = chunk.text.slice(match[0].length).trimStart();
    const title = /^title:[ \t]*(.+?)[ \t]*$/m.exec(match[1]!)?.[1]?.replace(/^(["'])(.*)\1$/, "$2");
    const fromComment = chunk.title !== undefined && match[1]!.split(/\r?\n/).some((line) => line.trim() === `# ${chunk.title!.trim()}`);
    if (title) titles.set(chunk.file, title);
    else if (fromComment) titles.set(chunk.file, /^# (.+)$/m.exec(body)?.[1]?.trim() || chunk.file);
    return { ...chunk, text: body || chunk.text };
  });
  if (titles.size === 0) return cleaned;
  return cleaned.map((chunk) => (titles.has(chunk.file) ? { ...chunk, title: titles.get(chunk.file)! } : chunk));
}

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
  const chunks = repairFrontMatter(readFileSync(join(dir, "chunks.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { file: string; title?: string; text: string }));
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

/** How long one question's embedding may take, body included: enough for a local model that starts cold. */
export const EMBEDDING_QUERY_TIMEOUT_MS = 30_000;

/** A vector of finite numbers: anything else would score as NaN and look like a match. */
function isVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** A failure this module named itself: its message quotes no response text. */
class EmbeddingQueryError extends Error {}

/**
 * Why a query embedding failed, named by the server and the kind of failure
 * only. A parse error can quote the response body, and a local server can
 * echo the question in it, so no response text reaches the message or its cause.
 */
function embeddingFailure(server: string, url: string, error: unknown): Error {
  if (isTimeout(error)) {
    return new EmbeddingQueryError(`${server} did not finish embedding the question within ${EMBEDDING_QUERY_TIMEOUT_MS / 1000} seconds. Check that it is running, then ask again.`);
  }
  const code = connectionCode(error);
  // A reset means something answered and then closed the connection: not a stopped server.
  if (code !== "ECONNRESET" && isConnectionRefused(error)) {
    return new EmbeddingQueryError(`${server} is not reachable at ${url}. Start the local server, then ask again.`);
  }
  if (error instanceof SyntaxError) {
    return new EmbeddingQueryError(`${server} answered the embedding request with something other than JSON. Check the local server, then ask again.`);
  }
  return new EmbeddingQueryError(`${server} did not complete the embedding request${code ? ` (${code})` : ""}. Check the local server, then ask again.`);
}

/**
 * Posts one question for embedding and reads the answer inside the same
 * time budget, so a body that stalls after its headers times out too.
 */
async function queryEmbedding<T>(endpoint: string, path: string, server: string, body: unknown, read: (response: Response, base: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const label = loopbackLabel(endpoint, path);
  const budget = AbortSignal.timeout(EMBEDDING_QUERY_TIMEOUT_MS);
  signal?.throwIfAborted();
  try {
    // The question is in the body. Refuse any redirect from the local service.
    const { response, url } = await fetchLoopback(endpoint, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, budget]) : budget,
    });
    if (isRefusedRedirect(response, url)) throw new EmbeddingQueryError(redirectRefusedDetail(server, url));
    // The address that answered, without the request path: a localhost name may have been answered on [::1].
    return await read(response, url.slice(0, url.length - path.length));
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof EmbeddingQueryError) throw error;
    throw embeddingFailure(server, label, error);
  }
}

/**
 * Query embedding against a loopback OpenAI-compatible embedding server
 * (the app's local model runtime on its embedding port). The
 * "search_query:" prefix matches how the index passages were embedded.
 */
export function loopbackEmbedQuery(endpoint: string): EmbedQuery {
  return async (text: string) => {
    return queryEmbedding(endpoint, "/v1/embeddings", "The embedding server", { input: [`search_query: ${text}`] }, async (response) => {
      if (!response.ok) {
        throw new EmbeddingQueryError(`Embedding server responded with HTTP ${response.status}.`);
      }
      const payload = (await response.json()) as {
        data?: Array<{ embedding?: number[] }>;
      };
      const embedding = payload?.data?.[0]?.embedding;
      if (!isVector(embedding)) {
        throw new EmbeddingQueryError("Embedding server returned no embedding vector.");
      }
      return embedding;
    });
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
  model = DEFAULT_INDEX_EMBEDDING_MODEL,
  signal?: AbortSignal,
): EmbedQuery {
  return async (text: string) => {
    return queryEmbedding(endpoint, "/api/embed", "Ollama", { model, input: `search_query: ${text}` }, async (response, base) => {
      if (!response.ok) {
        const details = response.status === 404
          ? await response.json().catch((error: unknown) => {
            if (error instanceof SyntaxError) return undefined;
            throw error;
          }) as { error?: unknown } | undefined
          : undefined;
        const missing = typeof details?.error === "string" && /model.*not found/i.test(details.error);
        const recovery = missing ? ` The embedding model ${model} is missing. ${pullAdvice(base, model)}` : "";
        throw new EmbeddingQueryError(`Ollama's embedding request returned HTTP ${response.status}.${recovery}`);
      }
      const payload = (await response.json()) as { embeddings?: number[][] };
      const embedding = payload?.embeddings?.[0];
      if (!isVector(embedding)) {
        throw new EmbeddingQueryError("The embedding service returned no vector.");
      }
      return embedding;
    }, signal);
  };
}

/**
 * How to pull a model into the Ollama that answered at `base` (the address
 * dialled, path prefix included). The Ollama CLI talks to
 * http://127.0.0.1:11434 unless OLLAMA_HOST says otherwise, so any other
 * base is named, or the pull would land in another Ollama.
 */
export function pullAdvice(base: string, model: string): string {
  return base === "http://127.0.0.1:11434" ? `Run \`ollama pull ${model}\`.` : `Run \`ollama pull ${model}\` with OLLAMA_HOST set to ${base}.`;
}

/**
 * The addresses to connect to for an endpoint, each with a loopback IP
 * literal as its host. A localhost name goes through the operating system's
 * resolver, which could answer with another machine, so it is never resolved:
 * it is tried as 127.0.0.1, then as [::1] (an Ollama listening on IPv6 only).
 * Anything else that is not 127.0.0.0/8 or ::1 over HTTP is refused. An HTTPS
 * endpoint named localhost is reached by address, so its certificate must
 * cover the address.
 */
export function loopbackEndpoints(endpoint: string): string[] {
  const refused = () => new Error("Refusing to embed a query against a non-loopback endpoint. Retrieval must stay local.");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw refused();
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw refused();
  // An IPv4-mapped loopback address ([::ffff:127.0.0.1], which URL writes as [::ffff:7f00:1]) is its IPv4 literal.
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(url.hostname.toLowerCase());
  if (mapped) {
    const [high, low] = [Number.parseInt(mapped[1]!, 16), Number.parseInt(mapped[2]!, 16)];
    url.hostname = [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  const host = url.hostname.toLowerCase();
  const text = (candidate: URL) => candidate.toString().replace(/\/$/, "");
  if (host === "localhost" || host === "localhost.") {
    return ["127.0.0.1", "[::1]"].map((literal) => {
      const candidate = new URL(url.toString());
      candidate.hostname = literal;
      return text(candidate);
    });
  }
  if (!/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) && host !== "[::1]") throw refused();
  return [text(url)];
}

/** The addresses tried for an endpoint and path, for a message: "A" or "A or B". */
export function loopbackLabel(endpoint: string, path: string): string {
  return loopbackEndpoints(endpoint).map((base) => `${base}${path}`).join(" or ");
}

/** A network failure's code, such as ECONNREFUSED or UND_ERR_SOCKET, when fetch gave one. */
export function connectionCode(error: unknown): string | undefined {
  // node:http puts the code on the error, fetch on its cause.
  for (const value of [error, error instanceof Error ? error.cause : undefined]) {
    if (value && typeof value === "object" && "code" in value && typeof value.code === "string" && value.code !== "ABORT_ERR") return value.code;
  }
  return undefined;
}

/** A request or body read stopped by an AbortSignal.timeout budget. */
function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TimeoutError" || (error.name === "AbortError" && error.cause instanceof Error && error.cause.name === "TimeoutError");
}

/**
 * Fetches a path from a loopback endpoint, trying each of its addresses in
 * turn while the connection is refused. A redirect is never followed, and an
 * answer of any kind, or any other failure, ends the attempts.
 */
export async function fetchLoopback(
  endpoint: string,
  path: string,
  init: RequestInit,
  // Never the global fetch: it can send to an environment proxy (see direct-fetch.ts).
  fetchImpl: typeof fetch = loopbackTransport.fetch,
): Promise<{ response: Response; url: string }> {
  const candidates = loopbackEndpoints(endpoint);
  // A localhost name is dialled by address, but over HTTP the server still sees the name it was given, as with fetch.
  // Not over HTTPS: Node checks the certificate against the Host header, and it must cover the address dialled.
  const named = new URL(endpoint);
  const host = named.protocol === "http:" && /^localhost\.?$/i.test(named.hostname) ? named.host : undefined;
  for (const [index, base] of candidates.entries()) {
    const url = `${base}${path}`;
    const headers = new Headers(init.headers);
    if (host) headers.set("host", host);
    try {
      return { response: await fetchImpl(url, { ...init, headers, redirect: modelServerRedirect(url) }), url };
    } catch (error) {
      const refused = connectionCode(error) !== "ECONNRESET" && isConnectionRefused(error);
      if (!refused || index === candidates.length - 1) throw error;
    }
  }
  throw new Error("No loopback address to try.");
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
