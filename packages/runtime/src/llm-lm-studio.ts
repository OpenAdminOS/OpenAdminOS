import type { RunLlmApi } from "@openadminos/agent-sdk";

import {
  classifyOpenAiCompatibleEndpoint,
  createOpenAiCompatibleLlm,
  probeOpenAiCompatibleLlm,
  resolveOpenAiCompatibleEndpoint,
  type OpenAiCompatibleEndpointTrust,
  type OpenAiCompatibleProbeResult,
  type OpenAiCompatibleProviderOptions,
  type OpenAiCompatibleServer,
} from "./llm-openai-compatible.js";

export { fetchLocal, isConnectionRefused } from "./llm-openai-compatible.js";

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
};

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
