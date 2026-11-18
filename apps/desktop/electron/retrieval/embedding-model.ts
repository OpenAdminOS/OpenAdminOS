import { classifyOllamaEndpoint, isConnectionRefused, isRefusedRedirect, modelServerRedirect, ollamaHostEndpoint, redirectRefusedDetail } from "@openadminos/runtime";
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
  if (process.env.OPENADMINOS_EMBEDDING_ENDPOINT) return process.env.OPENADMINOS_EMBEDDING_ENDPOINT;
  // Follow an Ollama moved with OLLAMA_HOST, but only while it stays on loopback.
  const moved = ollamaHostEndpoint(process.env.OLLAMA_HOST);
  return moved && classifyOllamaEndpoint(moved).isLocal ? moved : DEFAULT_EMBEDDING_ENDPOINT;
}

/** A network failure's code, such as UND_ERR_SOCKET, rather than undici's bare "fetch failed". */
function failureCode(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string") return cause.code;
  return error instanceof Error ? error.message : String(error);
}

function normalizeModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/** Whether Ollama answered and whether its model list contains the required model. */
export async function embeddingModelState(
  endpoint: string = embeddingEndpoint(),
  model: string = DEFAULT_INDEX_EMBEDDING_MODEL,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ollamaReachable?: boolean; installed: boolean; error?: string }> {
  assertLoopback(endpoint);
  const url = `${endpoint.replace(/\/$/, "")}/api/tags`;
  const recovery = "Check Ollama's local endpoint, then refresh the documentation index status.";
  let answered = false;
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(3000),
      redirect: modelServerRedirect(url),
    });
    answered = true;
    if (isRefusedRedirect(response, url)) {
      return { ollamaReachable: true, installed: false, error: `${redirectRefusedDetail("Ollama", url)} ${recovery}` };
    }
    if (!response.ok) {
      return { ollamaReachable: true, installed: false, error: `Ollama's model list returned HTTP ${response.status}. ${recovery}` };
    }
    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    if (!Array.isArray(payload?.models)) throw new SyntaxError("Ollama returned an invalid model list");
    const wanted = normalizeModelName(model);
    const installed = payload.models.some(
      (entry) => typeof entry?.name === "string" && normalizeModelName(entry.name) === wanted,
    );
    return { ollamaReachable: true, installed };
  } catch (error) {
    if (!answered && isConnectionRefused(error)) return { ollamaReachable: false, installed: false };
    const reason = error instanceof SyntaxError
      ? "Ollama returned an invalid model list."
      : error instanceof Error && error.name === "TimeoutError"
        ? "Ollama's model list request timed out."
        : `Could not read Ollama's model list (${failureCode(error)}).`;
    return { ...(answered ? { ollamaReachable: true } : {}), installed: false, error: `${reason} ${recovery}` };
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
  const url = `${endpoint.replace(/\/$/, "")}/api/pull`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false }),
    redirect: modelServerRedirect(url),
  });
  if (isRefusedRedirect(response, url)) throw new Error(redirectRefusedDetail("Ollama", url));
  // Ollama reports a failed download in the body, often with HTTP 500:
  // read it first, so the reason (an unreachable registry, a proxy) is kept.
  const payload = (await response.json().catch(() => undefined)) as
    | { status?: string; error?: string }
    | undefined;
  if (payload?.error) {
    throw new Error(`Ollama pull failed: ${payload.error}`);
  }
  if (!response.ok) {
    throw new Error(`Ollama pull failed with HTTP ${response.status}.`);
  }
}
