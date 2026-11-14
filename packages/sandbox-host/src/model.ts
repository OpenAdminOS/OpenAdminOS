import { classifyLmStudioEndpoint, classifyOllamaEndpoint } from "@openadminos/runtime";

import type { SandboxConfig } from "./config.js";
import { describe } from "./files.js";
import { SandboxRefusal } from "./refusal.js";

const PROBE_TIMEOUT_MS = 10_000;

export interface ModelCheck {
  model: string;
  digest?: string;
}

/**
 * Checks the model on every run: the endpoint is on this machine, the
 * server answers, the model is pulled, and it is not a cloud model that
 * Ollama would forward to a remote host.
 */
export async function checkLocalModel(model: SandboxConfig["model"], fetchImpl: typeof fetch = fetch): Promise<ModelCheck> {
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
  return model.provider === "ollama" ? checkOllama(model, fetchImpl) : checkLmStudio(model, fetchImpl);
}

export function isCloudModelName(name: string): boolean {
  return /[-:]cloud$/i.test(name.trim());
}

async function checkOllama(model: SandboxConfig["model"], fetchImpl: typeof fetch): Promise<ModelCheck> {
  const base = model.endpoint.replace(/\/+$/, "");
  const tags = await probe<{ models?: Array<{ name?: string; model?: string; digest?: string; remote_host?: string; remote_model?: string }> }>(fetchImpl, `${base}/api/tags`, "Ollama", model.endpoint);
  const wanted = model.model.includes(":") ? model.model : `${model.model}:latest`;
  const entry = tags.models?.find((candidate) => candidate.name === wanted || candidate.model === wanted || candidate.name === model.model);
  if (!entry) {
    throw new SandboxRefusal("model-not-pulled", `Ollama on this machine has no model ${model.model}. Pull it with \`ollama pull ${model.model}\`, then run again.`);
  }
  if (entry.remote_host || entry.remote_model) throw cloudModel(model.model);
  const shown = await probe<{ remote_host?: string; remote_model?: string }>(fetchImpl, `${base}/api/show`, "Ollama", model.endpoint, { model: model.model });
  if (shown.remote_host || shown.remote_model) throw cloudModel(model.model);
  return { model: entry.name ?? model.model, ...(typeof entry.digest === "string" ? { digest: entry.digest } : {}) };
}

async function checkLmStudio(model: SandboxConfig["model"], fetchImpl: typeof fetch): Promise<ModelCheck> {
  const base = model.endpoint.replace(/\/+$/, "");
  const listing = await probe<{ data?: Array<{ id?: string }> }>(fetchImpl, `${base}/models`, "LM Studio", model.endpoint);
  if (!listing.data?.some((entry) => entry.id === model.model)) {
    throw new SandboxRefusal("model-not-pulled", `LM Studio on this machine has no model ${model.model} loaded. Load it in LM Studio or with \`lms load ${model.model}\`, then run again.`);
  }
  return { model: model.model };
}

async function probe<T>(fetchImpl: typeof fetch, url: string, server: string, endpoint: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new SandboxRefusal(
      timedOut ? "model-timeout" : "model-unreachable",
      timedOut
        ? `${server} at ${endpoint} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds. Check that it is not overloaded, then run again.`
        : `${server} isn't reachable at ${endpoint}: ${describe(error)} Start it${server === "Ollama" ? " with `ollama serve`" : ""}, then run again.`,
      { cause: error },
    );
  }
  if (!response.ok) {
    throw new SandboxRefusal("model-unreachable", `${server} at ${endpoint} answered HTTP ${response.status}. Check the server log, then run again.`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new SandboxRefusal("model-unreachable", `${server} at ${endpoint} answered with a response the sandbox could not read.`);
  }
}

function cloudModel(name: string): SandboxRefusal {
  return new SandboxRefusal(
    "model-cloud",
    `${name} is an Ollama cloud model, which sends prompts off this machine. Use a model that runs here, and set OLLAMA_NO_CLOUD=1 for the Ollama service.`,
  );
}
