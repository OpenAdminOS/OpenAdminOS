import type { ProviderId } from "@openadminos/agent-sdk";
import {
  classifyLemonadeEndpoint,
  classifyLmStudioEndpoint,
  readLemonadeContextWindow,
  readLmStudioLoadedContextWindow,
  readOllamaContextWindow,
} from "@openadminos/runtime";
import { ollamaModelIsOnDevice } from "./provider-detail.js";

/** Only read model metadata from on-device endpoints. */
export async function readModelFitContextWindow(providerId: ProviderId, model: string, endpoint: string | undefined): Promise<number | undefined> {
  if (!endpoint) return undefined;
  if (providerId === "ollama" && await ollamaModelIsOnDevice(model, endpoint)) {
    return readOllamaContextWindow(endpoint, model, { appRaisesNumCtx: true });
  }
  if (providerId === "lm-studio" && classifyLmStudioEndpoint(endpoint).isLocal) {
    return readLmStudioLoadedContextWindow(endpoint, model);
  }
  if (providerId === "lemonade" && classifyLemonadeEndpoint(endpoint).isLocal) {
    return readLemonadeContextWindow(endpoint, model);
  }
  return undefined;
}
