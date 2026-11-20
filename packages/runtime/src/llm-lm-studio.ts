import type { RunLlmApi } from "@openadminos/agent-sdk";

import {
  classifyOpenAiCompatibleEndpoint,
  createOpenAiCompatibleLlm,
  fetchLocal,
  isRefusedRedirect,
  probeOpenAiCompatibleLlm,
  resolveOpenAiCompatibleEndpoint,
  type OpenAiCompatibleEndpointTrust,
  type OpenAiCompatibleFailure,
  type OpenAiCompatibleProbeResult,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleServer,
} from "./llm-openai-compatible.js";

export { fetchLocal, isConnectionRefused, isRefusedRedirect, modelServerRedirect, redirectRefusedDetail } from "./llm-openai-compatible.js";

export type LmStudioProviderOptions = OpenAiCompatibleProviderOptions;
export type LmStudioEndpointTrust = OpenAiCompatibleEndpointTrust;
export type LmStudioProbeResult = OpenAiCompatibleProbeResult;

const LM_STUDIO: OpenAiCompatibleServer = {
  name: "LM Studio",
  defaultEndpoint: "http://127.0.0.1:1234/v1",
  endpointEnv: "OPENADMINOS_LM_STUDIO_URL",
  timeoutEnv: "OPENADMINOS_LM_STUDIO_TIMEOUT_MS",
  noModelMessage:
    "No LM Studio model available. Load a model in LM Studio and start the local server.",
  notRunningDetail:
    "LM Studio isn't running or the local server is off. Start the server from LM Studio's Developer tab, then try again.",
  noModelsDetail: "LM Studio server is running but no models are loaded.",
  contextOverflowMessage: lmStudioContextOverflowMessage,
};

/** Room left for the answer when the caller sets no token limit. */
const LM_STUDIO_ANSWER_RESERVE_TOKENS = 4096;
const LM_STUDIO_LOOKUP_TIMEOUT_MS = 3000;

/**
 * LM Studio's wording for a prompt larger than the context the model was
 * loaded with. The server is closed source; these come from its bug tracker
 * (lmstudio-ai/lmstudio-bug-tracker #237, #546, #1251, #1757, #2205, #2256):
 * "Trying to keep the first N tokens when context the overflows. However,
 * the model is loaded with context length of only M tokens, which is not
 * enough." (0.3.x), "The number of tokens to keep from the initial prompt is
 * greater than the context length" with an optional "(n_keep: N >= n_ctx: M)"
 * (0.4.x), "Context size has been exceeded." (MLX) and "Reached context
 * length of M tokens with model ... that does not currently support
 * mid-generation context overflow".
 */
const LM_STUDIO_OVERFLOW = /greater than the context length|when context the overflows|loaded with context length of only|context size has been exceeded|reached context length of \d+ tokens?/i;

/** The token counts LM Studio's overflow error names, when it names them. */
export function parseLmStudioContextOverflow(detail: string): { requested?: number; loaded?: number } | undefined {
  if (!LM_STUDIO_OVERFLOW.test(detail)) return undefined;
  const keep = /keep the first (\d+) tokens?[\s\S]*?context length of only (\d+) tokens?/i.exec(detail);
  if (keep) return { requested: Number(keep[1]), loaded: Number(keep[2]) };
  const nKeep = /n_keep:\s*(\d+)\s*>=?\s*n_ctx:\s*(\d+)/i.exec(detail);
  if (nKeep) return { requested: Number(nKeep[1]), loaded: Number(nKeep[2]) };
  const reached = /reached context length of (\d+) tokens?/i.exec(detail);
  if (reached) return { loaded: Number(reached[1]) };
  return {};
}

interface LmStudioContextInfo {
  loaded?: number;
  max?: number;
  /** The model key `lms load` takes, when the request named a loaded instance such as `qwen3-8b:2`. */
  key?: string;
}

/**
 * The model's loaded and maximum context length, from LM Studio's REST API:
 * GET /api/v1/models (0.4.0+, loaded_instances[].config.context_length and
 * max_context_length), then GET /api/v0/models/{model} (0.3.6+,
 * loaded_context_length and max_context_length). Best effort: a failed,
 * slow or redirected lookup leaves the numbers unknown, and the overflow is
 * still reported.
 */
async function readLmStudioContext(endpoint: string, model: string, signal?: AbortSignal): Promise<LmStudioContextInfo> {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!/\/v1$/i.test(trimmed)) return {};
  const base = trimmed.slice(0, -"/v1".length);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) return {};
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, LM_STUDIO_LOOKUP_TIMEOUT_MS);
  const getJson = async (url: string): Promise<unknown> => {
    try {
      const response = await fetchLocal(url, { signal: controller.signal });
      if (isRefusedRedirect(response, url) || !response.ok) return undefined;
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  };

  try {
    let found: LmStudioContextInfo = {};
    const v1 = await getJson(`${base}/api/v1/models`);
    const models = isRecord(v1) && Array.isArray(v1.models) ? v1.models.filter(isRecord) : [];
    for (const entry of models) {
      const instances = Array.isArray(entry.loaded_instances) ? entry.loaded_instances.filter(isRecord) : [];
      const instance = instances.find((item) => item.id === model) ?? (entry.key === model ? instances[0] : undefined);
      if (!instance) continue;
      const config = isRecord(instance.config) ? instance.config : {};
      found = {
        ...tokenCount("loaded", config.context_length),
        ...tokenCount("max", entry.max_context_length),
        ...(typeof entry.key === "string" && entry.key.length > 0 && entry.key !== model ? { key: entry.key } : {}),
      };
      break;
    }
    if (found.loaded !== undefined || controller.signal.aborted) return found;
    const v0 = await getJson(`${base}/api/v0/models/${encodeURIComponent(model)}`);
    if (!isRecord(v0)) return found;
    return { ...tokenCount("loaded", v0.loaded_context_length), ...tokenCount("max", v0.max_context_length), ...found };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

function tokenCount<K extends string>(key: K, value: unknown): Partial<Record<K, number>> {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? ({ [key]: value } as Record<K, number>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * LM Studio sets the context length when the model is loaded, and its
 * OpenAI-compatible chat endpoint cannot change it per request. Raising it
 * through the API (POST /api/v1/models/load) would unload or duplicate the
 * model the user loaded and can be stopped by LM Studio's memory guardrails,
 * so OpenAdminOS names the sizes and says how to reload the model instead.
 */
async function lmStudioContextOverflowMessage(failure: OpenAiCompatibleFailure): Promise<string | undefined> {
  const overflow = parseLmStudioContextOverflow(failure.detail);
  if (!overflow) return undefined;
  const { model } = failure;
  const info = await readLmStudioContext(failure.endpoint, model, failure.signal);
  const requested = overflow.requested;
  const loaded = overflow.loaded ?? info.loaded;
  const max = info.max;
  const n = (value: number) => value.toLocaleString("en-US");

  const parts = ["LM Studio context length too small:"];
  if (requested !== undefined && loaded !== undefined) {
    parts.push(`This request needs ${n(requested)} tokens of context, but ${model} is loaded in LM Studio with a context length of ${n(loaded)}.`);
  } else if (loaded !== undefined) {
    parts.push(`This request does not fit in the ${n(loaded)} tokens of context ${model} is loaded with in LM Studio.`);
  } else {
    parts.push(`This request does not fit in the context length ${model} is loaded with in LM Studio.`);
  }

  const atModelLimit = max !== undefined && (requested !== undefined ? requested > max : loaded !== undefined && loaded >= max);
  if (atModelLimit) {
    parts.push(`${model} supports at most ${n(max)}, so narrow the request or pick a model with a larger context window.`);
  } else {
    const wanted = requested === undefined ? undefined : roundUp(requested + (failure.maxTokens ?? LM_STUDIO_ANSWER_RESERVE_TOKENS), 1024);
    const target = wanted === undefined ? undefined : max === undefined ? wanted : Math.min(wanted, max);
    const size = target === undefined ? "" : ` to at least ${n(target)}`;
    const limit = max === undefined ? "" : ` (${model} supports up to ${n(max)})`;
    parts.push(
      `Raise Context Length${size}${limit} in the model's load settings in LM Studio and reload it, or run \`lms load ${info.key ?? model} --context-length ${target ?? "<tokens>"}\`, then re-run. OpenAdminOS does not reload the model itself, because that would replace the model you loaded.`,
    );
  }
  parts.push(`LM Studio said: ${truncate(serverMessage(failure.detail), 200)}`);
  return parts.join(" ");
}

/** The message inside a JSON error body, or the body as it is. */
function serverMessage(detail: string): string {
  try {
    const body = JSON.parse(detail) as unknown;
    if (isRecord(body)) {
      if (typeof body.error === "string") return body.error;
      if (isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
    }
  } catch {
    // Not JSON.
  }
  return detail;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

export function createLmStudioLlm(options: LmStudioProviderOptions = {}): RunLlmApi {
  return createOpenAiCompatibleLlm(LM_STUDIO, options);
}

export function probeLmStudioLlm(
  options: LmStudioProviderOptions = {},
): Promise<LmStudioProbeResult> {
  return probeOpenAiCompatibleLlm(LM_STUDIO, options);
}

export function resolveLmStudioEndpoint(endpoint?: string): string {
  return resolveOpenAiCompatibleEndpoint(LM_STUDIO, endpoint);
}

export function classifyLmStudioEndpoint(endpoint: string): LmStudioEndpointTrust {
  return classifyOpenAiCompatibleEndpoint(LM_STUDIO.name, endpoint);
}
