// Context window lookup for Ollama models, kept apart from llm-ollama.ts so
// the request path and this lookup can change independently.
import { modelServerRedirect } from "./llm-openai-compatible.js";
import type { ContextTooSmallFailure } from "@openadminos/agent-sdk";
import { checkPromptFit } from "./prompt-fit.js";

const LOOKUP_TIMEOUT_MS = 5000;

export interface OllamaShowContext {
  /** `num_ctx` pinned in the model's Modelfile parameters. */
  pinnedNumCtx?: number;
  /** When the model was last created or pulled; a new value is a new model. */
  revision?: string;
  /** The architecture's trained maximum, `<architecture>.context_length`. */
  modelMaxContext?: number;
}

export interface OllamaContextWindowOptions {
  /**
   * True when the app itself sends a larger `num_ctx` for a request that
   * needs it, as createOllamaLlm does on a context overflow. Then a model
   * without a pinned `num_ctx` is limited by its maximum rather than the
   * size Ollama happened to load it with. A pinned `num_ctx` wins either way.
   */
  appRaisesNumCtx?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Receives a successful /api/show reading, so the adapter can reuse it. */
  onShow?: (show: OllamaShowContext) => void;
}

/** Whether an /api/show reading carries anything (a failed lookup carries nothing). */
export function ollamaShowKnown(show: OllamaShowContext | undefined): show is OllamaShowContext {
  return show !== undefined && (show.pinnedNumCtx !== undefined || show.modelMaxContext !== undefined || show.revision !== undefined);
}

/**
 * Read `parameters` and `model_info` from an /api/show response. The
 * architecture key matters: `mistral3.rope.scaling.original_context_length`
 * also ends in `context_length` but is not the window.
 */
export function parseOllamaShow(data: unknown): OllamaShowContext {
  if (!data || typeof data !== "object") return {};
  const record = data as { parameters?: unknown; model_info?: unknown; modified_at?: unknown };
  const out: OllamaShowContext = {};
  if (typeof record.modified_at === "string" && record.modified_at.length > 0) out.revision = record.modified_at;
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

/** The model revision each kept size was kept for, per endpoint and model. */
const keptRevisions = new Map<string, string>();
const revisionKey = (endpoint: string, model: string) => `${endpoint.replace(/\/$/, "")}\0${model}`;

/** The revision a kept size belongs to, read with the size at request start. */
export function keptOllamaRevision(endpoint: string, model: string): string | undefined {
  return keptRevisions.get(revisionKey(endpoint, model));
}

/**
 * Keep a size that worked, together with the model revision the lookup that
 * chose it saw. A request that finishes after the model was created again
 * keeps its size under the revision it was sized for, never the newer one.
 */
export function keepOllamaSize(
  overrides: Map<string, number>,
  cacheKey: string,
  endpoint: string,
  model: string,
  size: number,
  revision: string | undefined,
): void {
  const key = revisionKey(endpoint, model);
  const keptFor = keptRevisions.get(key);
  if (revision !== undefined && keptFor !== undefined && keptFor !== revision) {
    // A size from another revision of the model: an older one never replaces
    // a newer one, and a newer one replaces it outright (no maximum across
    // revisions, which would carry an old size into the new model).
    if (Date.parse(revision) < Date.parse(keptFor)) return;
    overrides.set(cacheKey, size);
    keptRevisions.set(key, revision);
    return;
  }
  // The same revision (or one unknown): keep the largest size that worked.
  overrides.set(cacheKey, Math.max(overrides.get(cacheKey) ?? 0, size));
  if (revision !== undefined) keptRevisions.set(key, revision);
}

/**
 * What the adapter does before its first send: send `numCtx`, stop sending
 * a kept size (`dropKept`), or refuse (`tooLarge`).
 */
export interface OllamaRequestContext {
  numCtx?: number;
  neededTokens: number;
  /** The model revision this lookup saw, to bind a size kept from it. */
  revision?: string;
  /** The pin and maximum this lookup saw, for the overflow retry. */
  pinnedNumCtx?: number;
  modelMaxContext?: number;
  dropKept?: boolean;
  /** Send no num_ctx this time, but leave the kept size for other callers. */
  skipKept?: boolean;
  tooLarge?: ContextTooSmallFailure;
}

/** Ollama's smallest default context; a request this size needs no num_ctx. */
const SMALLEST_DEFAULT_CONTEXT = 2048;

async function readJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, {
      ...init,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: modelServerRedirect(url),
    });
    return response.ok ? await response.json() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The model's /api/show reading, asked fresh on each call: a model can be
 * created again under the same name with another num_ctx, and the size check
 * reads it fresh too, so both always agree.
 */
async function readShow(
  fetchImpl: typeof fetch,
  base: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<OllamaShowContext> {
  return parseOllamaShow(await readJson(fetchImpl, `${base}/api/show`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model }),
  }, timeoutMs, signal));
}

export interface OllamaRequestContextInput {
  endpoint: string;
  model: string;
  system?: string;
  prompt: string;
  /** The answer budget; unset reserves what the run's size check reserves. */
  maxTokens?: number;
  /** num_ctx this app already sends for the model, if any. */
  currentNumCtx?: number;
  /**
   * The revision that kept size belongs to, read together with it when the
   * request started, so a size kept since by a concurrent request is not
   * mistaken for this one.
   */
  currentRevision?: string;
  /**
   * The reading the run's size check got. It stands in when this lookup
   * fails (Ollama briefly unavailable), so a pin the check saw still holds;
   * a successful lookup replaces it.
   */
  fallbackShow?: OllamaShowContext;
  /** Refuse a request larger than a pin this lookup finds (agent runs). */
  enforce?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * The num_ctx to send with a request to a model that has no pinned
 * num_ctx, and the tokens it needs, so the first send already has room for
 * the prompt and the answer. Ollama loads such a model at its own default (a
 * few thousand tokens), reloads it there after an eviction, and an older
 * Ollama shortens a longer prompt without an error, so the size is always
 * sent rather than inferred from what happens to be loaded. Never below the
 * loaded size, so a loaded model is not reloaded smaller, and in powers of
 * two, so it is reloaded rarely. Undefined for a pinned model (the size check
 * holds it to its pin), a request no larger than the smallest default, or a
 * size this app already sends that is large enough.
 */
export async function ollamaRequestNumCtx(
  input: OllamaRequestContextInput,
): Promise<OllamaRequestContext | undefined> {
  // The same count as the run's size check, chat template tokens included.
  const fitInput = {
    ...(input.system ? { system: input.system } : {}),
    prompt: input.prompt,
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    model: input.model,
  };
  const { neededTokens } = checkPromptFit(fitInput);
  // A short request with no kept size runs at Ollama's default untouched. A
  // kept size is always checked against the loaded one, whatever the
  // request's size: a larger one loaded since (by another client) must not
  // be reloaded smaller.
  // An agent run still checks the model's limit, which can be below 2,048.
  if (neededTokens <= SMALLEST_DEFAULT_CONTEXT && input.currentNumCtx === undefined && !input.enforce) return undefined;
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  const base = input.endpoint.replace(/\/$/, "");
  const fresh = await readShow(fetchImpl, base, input.model, timeoutMs, input.signal);
  const fallback = input.fallbackShow;
  let show = ollamaShowKnown(fresh) || !fallback ? fresh : fallback;
  // A partial answer for the same model keeps the pin and maximum the size
  // check saw; a different revision is a new model and does not.
  if (fallback && (show.revision === undefined || show.revision === fallback.revision)) {
    if (fallback.pinnedNumCtx !== undefined && show.pinnedNumCtx === undefined) show = { ...show, pinnedNumCtx: fallback.pinnedNumCtx };
    if (fallback.modelMaxContext !== undefined && show.modelMaxContext === undefined) show = { ...show, modelMaxContext: fallback.modelMaxContext };
  }
  const seen = {
    ...(show.revision !== undefined ? { revision: show.revision } : {}),
    ...(show.pinnedNumCtx !== undefined ? { pinnedNumCtx: show.pinnedNumCtx } : {}),
    ...(show.modelMaxContext !== undefined ? { modelMaxContext: show.modelMaxContext } : {}),
  };
  // The fresh limit comes before anything kept: the pin, else the
  // architecture maximum. If the run's own lookup could not see it (Ollama
  // briefly unavailable, or the model created again since), refuse here with
  // the same typed reason rather than send a request that overflows.
  const limit = show.pinnedNumCtx !== undefined
    ? Math.min(show.pinnedNumCtx, show.modelMaxContext ?? Infinity)
    : show.modelMaxContext;
  if (input.enforce && limit !== undefined) {
    const fit = checkPromptFit({ ...fitInput, contextWindow: limit });
    if (fit.failure) return { tooLarge: fit.failure, neededTokens, ...seen };
  }
  // An agent run whose lookups saw neither a pin nor a maximum cannot tell
  // whether the model is pinned, and any num_ctx it sent would override a
  // pin. It sends none (nor a kept size), so Ollama applies the Modelfile.
  if (input.enforce && show.pinnedNumCtx === undefined && show.modelMaxContext === undefined) {
    return { neededTokens, ...seen, ...(input.currentNumCtx !== undefined ? { skipKept: true } : {}) };
  }
  // A kept size belongs to the model revision it was kept for. A model
  // created again under the same name starts from its own settings.
  // The kept size and its revision are checked as one: a size kept for
  // another revision, or larger than this model's maximum, is not reused.
  let current = input.currentNumCtx;
  let dropKept = false;
  if (current !== undefined && (input.currentRevision !== show.revision ||
    (show.modelMaxContext !== undefined && current > show.modelMaxContext))) {
    dropKept = true;
    current = undefined;
  }
  if (show.pinnedNumCtx !== undefined) {
    // A kept size below the pin would override it: Ollama applies a
    // request's num_ctx over the Modelfile. Drop it so the pin applies. A
    // kept size at or above the pin, raised for an earlier overflow, stays.
    if (current !== undefined && current < show.pinnedNumCtx) dropKept = true;
    // An agent run is held to the pin, so it does not send a larger size
    // that Chat kept for this model (Chat may raise past the pin). The kept
    // size stays for Chat.
    const skipKept = !dropKept && input.enforce === true && current !== undefined && current > show.pinnedNumCtx;
    return { neededTokens, ...seen, ...(dropKept ? { dropKept: true } : {}), ...(skipKept ? { skipKept: true } : {}) };
  }
  // An unpinned model whose kept size was dropped is still sized, so it is
  // never served at Ollama's own default.
  if (current === undefined && neededTokens <= SMALLEST_DEFAULT_CONTEXT) return { neededTokens, ...seen, ...(dropKept ? { dropKept: true } : {}) };
  const loaded = parseOllamaLoadedContext(await readJson(fetchImpl, `${base}/api/ps`, { method: "GET" }, timeoutMs, input.signal), input.model) ?? 0;
  if (current !== undefined && current >= neededTokens && loaded <= current) return { neededTokens, ...seen };
  let target = 4096;
  while (target < neededTokens) target *= 2;
  target = Math.max(target, loaded, current ?? 0);
  return {
    numCtx: show.modelMaxContext !== undefined ? Math.min(target, show.modelMaxContext) : target,
    neededTokens,
    ...seen,
    ...(dropKept ? { dropKept: true } : {}),
  };
}

/**
 * The context window a request to `model` gets from this Ollama server.
 * A pinned `num_ctx` wins. A model without one is limited by its maximum
 * when the app raises `num_ctx`, else by the size Ollama loaded it with,
 * which /api/ps reports, else by its maximum.
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
  // A pinned num_ctx is the model author's choice (OpenAdmin 8B pins the
  // 16,384 its rope scaling was trained at) and is what the first request
  // gets, so it is the limit even where the app could raise num_ctx.
  if (ollamaShowKnown(show)) options.onShow?.(show);
  if (show.pinnedNumCtx !== undefined) return Math.min(show.pinnedNumCtx, show.modelMaxContext ?? Infinity);
  if (options.appRaisesNumCtx) return show.modelMaxContext;
  const loaded = parseOllamaLoadedContext(await call("/api/ps", { method: "GET" }), model);
  return loaded ?? show.modelMaxContext;
}
