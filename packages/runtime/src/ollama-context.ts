// Context window lookup for Ollama models, kept apart from llm-ollama.ts so
// the request path and this lookup can change independently.
import { modelServerRedirect } from "./llm-openai-compatible.js";

const LOOKUP_TIMEOUT_MS = 5000;

export interface OllamaShowContext {
  /** `num_ctx` pinned in the model's Modelfile parameters. */
  pinnedNumCtx?: number;
  /** The architecture's trained maximum, `<architecture>.context_length`. */
  modelMaxContext?: number;
}

export interface OllamaContextWindowOptions {
  /**
   * True when the app itself sends a larger `num_ctx` for a request that
   * needs it, as createOllamaLlm does on a context overflow. Then the
   * model's maximum is the limit. Without it Ollama serves the pinned
   * `num_ctx` (or its own default), so that size wins.
   */
  appRaisesNumCtx?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Read `parameters` and `model_info` from an /api/show response. The
 * architecture key matters: `mistral3.rope.scaling.original_context_length`
 * also ends in `context_length` but is not the window.
 */
export function parseOllamaShow(data: unknown): OllamaShowContext {
  if (!data || typeof data !== "object") return {};
  const record = data as { parameters?: unknown; model_info?: unknown };
  const out: OllamaShowContext = {};
  if (typeof record.parameters === "string") {
    const match = /^\s*num_ctx\s+(\d+)\s*$/m.exec(record.parameters);
    const value = match ? Number(match[1]) : NaN;
    if (Number.isInteger(value) && value > 0) out.pinnedNumCtx = value;
  }
  if (record.model_info && typeof record.model_info === "object") {
    const info = record.model_info as Record<string, unknown>;
    const architecture = typeof info["general.architecture"] === "string" ? info["general.architecture"] : undefined;
    const candidates = architecture
      ? [info[`${architecture}.context_length`]]
      : Object.entries(info).filter(([key]) => /^[^.]+\.context_length$/.test(key)).map(([, value]) => value);
    const value = candidates.find((entry) => typeof entry === "number" && Number.isInteger(entry) && entry > 0);
    if (typeof value === "number") out.modelMaxContext = value;
  }
  return out;
}

/** The context size a loaded model runs with, from an /api/ps response. */
export function parseOllamaLoadedContext(data: unknown, model: string): number | undefined {
  const models = (data as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) return undefined;
  const wanted = normalizeModelName(model);
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { name?: unknown; model?: unknown; context_length?: unknown };
    const names = [row.name, row.model].filter((name): name is string => typeof name === "string").map(normalizeModelName);
    if (!names.includes(wanted)) continue;
    const value = row.context_length;
    return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
  }
  return undefined;
}

function normalizeModelName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return /:[^/]+$/.test(trimmed) ? trimmed : `${trimmed}:latest`;
}

/**
 * The context window a request to `model` gets from this Ollama server.
 * The pinned `num_ctx` wins while the app cannot raise it; a model without
 * one runs at the size Ollama loaded it with, which /api/ps reports. The
 * trained maximum is the answer only when nothing smaller applies.
 * `undefined` when Ollama does not answer, so the request goes ahead.
 */
export async function readOllamaContextWindow(
  endpoint: string,
  model: string | undefined,
  options: OllamaContextWindowOptions = {},
): Promise<number | undefined> {
  if (!model) return undefined;
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = endpoint.replace(/\/$/, "");
  const call = async (path: string, init: RequestInit): Promise<unknown> => {
    const url = `${base}${path}`;
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs ?? LOOKUP_TIMEOUT_MS),
        redirect: modelServerRedirect(url),
      });
      return response.ok ? await response.json() : undefined;
    } catch {
      return undefined;
    }
  };
  const show = parseOllamaShow(await call("/api/show", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  }));
  if (options.appRaisesNumCtx) return show.modelMaxContext;
  if (show.pinnedNumCtx !== undefined) return Math.min(show.pinnedNumCtx, show.modelMaxContext ?? Infinity);
  const loaded = parseOllamaLoadedContext(await call("/api/ps", { method: "GET" }), model);
  return loaded ?? show.modelMaxContext;
}
