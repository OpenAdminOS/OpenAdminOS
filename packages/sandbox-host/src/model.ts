import { classifyLmStudioEndpoint, classifyOllamaEndpoint } from "@openadminos/runtime";

import type { SandboxConfig } from "./config.js";
import { describe } from "./files.js";
import { SandboxRefusal } from "./refusal.js";

const PROBE_TIMEOUT_MS = 10_000;

export interface ModelCheck {
  model: string;
  /** The digest the server reports, or `unknown` when it reports none (LM Studio). */
  digest: string;
}

/**
 * The transport for the model client: only the checked endpoint's origin,
 * and redirects fail, so a prompt never goes anywhere else.
 */
export function pinnedModelFetch(endpoint: string, base: typeof fetch = fetch): typeof fetch {
  const origin = new URL(endpoint).origin;
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const target = new URL(href).origin;
    if (target !== origin) {
      throw new SandboxRefusal("model-endpoint-not-local", `A model request to ${target} was refused before it was sent. The sandbox sends prompts only to ${origin}.`);
    }
    return base(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}

/**
 * Checks the model on every run: the endpoint is on this machine, the
 * server answers, the model is pulled, and it is not a cloud model that
 * Ollama would forward to a remote host.
 */
export async function checkLocalModel(model: SandboxConfig["model"], fetchImpl: typeof fetch = fetch, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<ModelCheck> {
  const trust = model.provider === "ollama" ? classifyOllamaEndpoint(model.endpoint) : classifyLmStudioEndpoint(model.endpoint);
  if (!trust.isLocal) {
    throw new SandboxRefusal(
      "model-endpoint-not-local",
      `The model endpoint ${model.endpoint} is not on this machine (${trust.reason}) A sandbox sends tenant data only to a model on the same machine. Set model.endpoint to a loopback address such as http://127.0.0.1:11434.`,
    );
  }
  if (isCloudModelName(model.model)) {
    throw cloudModel(model.model);
  }
  return model.provider === "ollama" ? checkOllama(model, fetchImpl, timeoutMs) : checkLmStudio(model, fetchImpl, timeoutMs);
}

export function isCloudModelName(name: string): boolean {
  return /[-:]cloud$/i.test(name.trim());
}

async function checkOllama(model: SandboxConfig["model"], fetchImpl: typeof fetch, timeoutMs: number): Promise<ModelCheck> {
  const base = model.endpoint.replace(/\/+$/, "");
  const tags = await probe<{ models?: Array<{ name?: string; model?: string; digest?: string; remote_host?: string; remote_model?: string }> }>(fetchImpl, `${base}/api/tags`, "Ollama", model.endpoint, timeoutMs);
  const wanted = model.model.includes(":") ? model.model : `${model.model}:latest`;
  const entry = tags.models?.find((candidate) => candidate.name === wanted || candidate.model === wanted || candidate.name === model.model);
  if (!entry) {
    throw new SandboxRefusal("model-not-pulled", `Ollama on this machine has no model ${model.model}. Pull it with \`ollama pull ${model.model}\`, then run again.`);
  }
  if (entry.remote_host || entry.remote_model) throw cloudModel(model.model);
  const shown = await probe<{ remote_host?: string; remote_model?: string }>(fetchImpl, `${base}/api/show`, "Ollama", model.endpoint, timeoutMs, { model: model.model });
  if (shown.remote_host || shown.remote_model) throw cloudModel(model.model);
  return { model: entry.name ?? model.model, digest: typeof entry.digest === "string" && entry.digest.length > 0 ? entry.digest : "unknown" };
}

async function checkLmStudio(model: SandboxConfig["model"], fetchImpl: typeof fetch, timeoutMs: number): Promise<ModelCheck> {
  const base = model.endpoint.replace(/\/+$/, "");
  const listing = await probe<{ data?: Array<{ id?: string; digest?: unknown; sha256?: unknown }> }>(fetchImpl, `${base}/models`, "LM Studio", model.endpoint, timeoutMs);
  const entry = listing.data?.find((candidate) => candidate.id === model.model);
  if (!entry) {
    throw new SandboxRefusal("model-not-pulled", `LM Studio on this machine has no model ${model.model} loaded. Load it in LM Studio or with \`lms load ${model.model}\`, then run again.`);
  }
  // LM Studio's model listing names no digest today; one is recorded if it ever does.
  const digest = typeof entry.digest === "string" ? entry.digest : typeof entry.sha256 === "string" ? entry.sha256 : "unknown";
  return { model: model.model, digest };
}

async function probe<T>(fetchImpl: typeof fetch, url: string, server: string, endpoint: string, timeoutMs: number, body?: unknown): Promise<T> {
  // One signal covers the request and the body, so a server that sends
  // headers and then stalls ends as a timeout, not as an unreadable answer.
  const signal = AbortSignal.timeout(timeoutMs);
  const timeout = (cause: unknown) =>
    new SandboxRefusal(
      "model-timeout",
      `${server} at ${endpoint} did not answer within ${timeoutMs / 1000} seconds. Check that it is not overloaded, then run again.`,
      { cause },
    );
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      redirect: "error",
      signal,
    });
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
    if (timedOut) throw timeout(error);
    throw new SandboxRefusal(
      "model-unreachable",
      `${server} isn't reachable at ${endpoint}: ${describe(error)} Start it${server === "Ollama" ? " with `ollama serve`" : ""}, then run again.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new SandboxRefusal("model-unreachable", `${server} at ${endpoint} answered HTTP ${response.status}. Check the server log, then run again.`);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  try {
    return (await Promise.race([response.json(), aborted])) as T;
  } catch (error) {
    if (signal.aborted) throw timeout(error);
    throw new SandboxRefusal("model-unreachable", `${server} at ${endpoint} answered with a response the sandbox could not read.`);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function cloudModel(name: string): SandboxRefusal {
  return new SandboxRefusal(
    "model-cloud",
    `${name} is an Ollama cloud model, which sends prompts off this machine. Use a model that runs here, and set OLLAMA_NO_CLOUD=1 for the Ollama service.`,
  );
}
