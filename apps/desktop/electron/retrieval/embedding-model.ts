import { DEFAULT_INDEX_EMBEDDING_MODEL, assertLoopback } from "./retrieval.js";

/**
 * The documentation index is only half of grounding. Retrieval also
 * needs the embedding model the index was built with, served by the
 * local Ollama. The index installs itself, so the model has to follow
 * the same rule: fetched silently in the background, never blocking,
 * never raising a dialog, and governed by the same Settings switch.
 *
 * The one thing this cannot do is install Ollama itself. When Ollama is
 * not reachable the pull is simply skipped and retried on a later
 * launch, and Settings says which prerequisite is missing.
 *
 * Everything here talks to loopback only; a question or a pull request
 * never leaves the device.
 */

export const DEFAULT_EMBEDDING_ENDPOINT = "http://127.0.0.1:11434";

export function embeddingEndpoint(): string {
  return process.env.OPENADMINOS_EMBEDDING_ENDPOINT ?? DEFAULT_EMBEDDING_ENDPOINT;
}

function normalizeModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/** Whether Ollama is reachable and, if so, whether it has the model. */
export async function embeddingModelState(
  endpoint: string = embeddingEndpoint(),
  model: string = DEFAULT_INDEX_EMBEDDING_MODEL,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ollamaReachable: boolean; installed: boolean }> {
  assertLoopback(endpoint);
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return { ollamaReachable: false, installed: false };
    const payload = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    const wanted = normalizeModelName(model);
    const installed = (payload.models ?? []).some(
      (entry) => typeof entry.name === "string" && normalizeModelName(entry.name) === wanted,
    );
    return { ollamaReachable: true, installed };
  } catch {
    return { ollamaReachable: false, installed: false };
  }
}

/**
 * Pull the model through the local Ollama. Resolves when the pull
 * completes; rejects on failure. Ollama downloads the weights itself,
 * so nothing here handles resumption or verification: Ollama's own
 * digest checks do.
 */
export async function pullEmbeddingModel(
  endpoint: string = embeddingEndpoint(),
  model: string = DEFAULT_INDEX_EMBEDDING_MODEL,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  assertLoopback(endpoint);
  const response = await fetchImpl(`${endpoint.replace(/\/$/, "")}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
  });
  if (!response.ok) {
    throw new Error(`Ollama pull failed with HTTP ${response.status}.`);
  }
  const payload = (await response.json().catch(() => undefined)) as
    | { status?: string; error?: string }
    | undefined;
  if (payload?.error) {
    throw new Error(`Ollama pull failed: ${payload.error}`);
  }
}
