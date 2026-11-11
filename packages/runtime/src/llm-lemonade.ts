import type { RunLlmApi } from "@openadminos/agent-sdk";

import {
  classifyOpenAiCompatibleEndpoint,
  createOpenAiCompatibleLlm,
  probeOpenAiCompatibleLlm,
  resolveOpenAiCompatibleEndpoint,
  type OpenAiCompatibleEndpointTrust,
  type OpenAiCompatibleModel,
  type OpenAiCompatibleProbeResult,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleServer,
} from "./llm-openai-compatible.js";

export type LemonadeProviderOptions = OpenAiCompatibleProviderOptions;
export type LemonadeEndpointTrust = OpenAiCompatibleEndpointTrust;
export type LemonadeProbeResult = OpenAiCompatibleProbeResult;

/**
 * Lemonade Server (lemonade-server.ai). Its OpenAI-compatible API listens on
 * localhost:13305 by default and also answers under /api/v1.
 */
const LEMONADE: OpenAiCompatibleServer = {
  name: "Lemonade",
  defaultEndpoint: "http://127.0.0.1:13305/v1",
  endpointEnv: "OPENADMINOS_LEMONADE_URL",
  timeoutEnv: "OPENADMINOS_LEMONADE_TIMEOUT_MS",
  noModelMessage:
    "No Lemonade model available. Download a chat model in Lemonade, then try again.",
  notRunningDetail: "Lemonade isn't running. Start Lemonade Server, then try again.",
  noModelsDetail: "Lemonade is running but has no chat model downloaded.",
  httpStatusDetail: (status) =>
    status === 401
      ? // TODO(ugur): send a Lemonade API key? Today the admin has to run the server without LEMONADE_API_KEY.
        "Lemonade asks for an API key because LEMONADE_API_KEY is set where it runs. OpenAdminOS does not send Lemonade API keys, so start Lemonade without it, then try again."
      : undefined,
  chatModelIds: lemonadeChatModelIds,
  unlistedModelMessage: lemonadeUnlistedModelMessage,
  streamNamesModel: false,
};

/** Why a model is not sent to Lemonade, with what to do instead. */
export function lemonadeUnlistedModelMessage(
  model: string,
  entry: OpenAiCompatibleModel | undefined,
): string {
  if (entry && isLemonadeCloudModel(entry)) {
    return `Lemonade sends ${model} to a cloud API, so OpenAdminOS does not use it as a local model. Choose a chat model that runs on this device.`;
  }
  if (entry) {
    return `${model} is not a chat model in Lemonade. Choose a chat model, then try again.`;
  }
  return `Lemonade has no downloaded chat model named ${model}. Download it in Lemonade or choose another model, then try again.`;
}

/**
 * Keeps the downloaded models that answer chat completions on this device.
 * Lemonade's /models lists only downloaded models, so a chat request never
 * starts a download. A model's deployment label is `chat` for an LLM;
 * embeddings, transcription, image and speech models carry other labels.
 * Lemonade can also route a model to a cloud API (`recipe: "cloud"`, with a
 * `cloud_provider`); those are left out, because prompts sent to them leave
 * the device even though the endpoint is on loopback. Any cloud marker
 * counts, so a cloud recipe spelled differently later is still left out.
 */
export function lemonadeChatModelIds(data: OpenAiCompatibleModel[]): string[] {
  return data
    .filter((model) => {
      const labels = Array.isArray(model.labels) ? model.labels : [];
      return labels.includes("chat") && !isLemonadeCloudModel(model);
    })
    .map((model) => model.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

function isLemonadeCloudModel(model: OpenAiCompatibleModel): boolean {
  return (
    (typeof model.recipe === "string" && model.recipe.toLowerCase().startsWith("cloud")) ||
    (model.cloud_provider !== undefined && model.cloud_provider !== null && model.cloud_provider !== "")
  );
}

export function createLemonadeLlm(options: LemonadeProviderOptions = {}): RunLlmApi {
  return createOpenAiCompatibleLlm(LEMONADE, options);
}

export function probeLemonadeLlm(
  options: LemonadeProviderOptions = {},
): Promise<LemonadeProbeResult> {
  return probeOpenAiCompatibleLlm(LEMONADE, options);
}

export function resolveLemonadeEndpoint(endpoint?: string): string {
  return resolveOpenAiCompatibleEndpoint(LEMONADE, endpoint);
}

export function classifyLemonadeEndpoint(endpoint: string): LemonadeEndpointTrust {
  return classifyOpenAiCompatibleEndpoint(LEMONADE.name, endpoint);
}
