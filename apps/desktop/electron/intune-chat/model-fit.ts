import { resolveProviderDefaultModel } from "@openadminos/agent-sdk";
import type {
  ChatModelOverride,
  HostedProviderChatConsent,
  IntuneChatMessage,
  ModelFitIssue,
  ProviderId,
  ProviderSummary,
} from "@openadminos/agent-sdk";
import { classifyModelFitFailure } from "../../src/shared/model-fit.js";
import { isProviderReady } from "../../src/shared/provider-detection.js";

/**
 * Model fit in Chat (SPEC.md, "Model fit"): which provider and model one
 * request runs on, and what Chat records when the local model could not do
 * it. Chat itself never switches: the renderer offers the configured
 * alternatives and sends an override only after the admin chose one and,
 * for a hosted one, accepted it for this request.
 */

/** Refused per-request override, with a reason the admin can act on. */
export class ModelOverrideError extends Error {
  override readonly name = "ModelOverrideError";
}

export interface ChatTurnProvider {
  provider: ProviderSummary;
  model: string | undefined;
  /** Set when this request runs on another provider or model than the active one. */
  switchedFrom?: NonNullable<IntuneChatMessage["switchedFrom"]>;
}

/**
 * The provider and model of one Chat request. Without an override, the
 * active ones. With an override, the chosen provider, after checking that:
 * - the active provider is the local one the request first went to, with
 *   the same model, so a stale offer cannot apply to another setup;
 * - the chosen provider is in the provider list (which the managed policy
 *   already filtered) and ready, and the model is one it lists;
 * - a hosted provider comes with an acceptance for it that is not a
 *   remembered one. Its age, model and tenant are checked later by the
 *   same consent check every hosted send passes.
 * Nova never takes an override: its provider is pinned for the session.
 */
export function resolveChatTurnProvider(input: {
  override: ChatModelOverride | undefined;
  providers: readonly ProviderSummary[];
  active: ProviderSummary;
  activeModel: string | undefined;
  activeModelByProviderId?: Partial<Record<ProviderId, string>> | undefined;
  consent: HostedProviderChatConsent | undefined;
  nova: boolean;
}): ChatTurnProvider {
  const { override, active, activeModel } = input;
  if (!override) return { provider: active, model: activeModel };
  if (input.nova) throw new ModelOverrideError("Nova answers with its own provider only. Ask this in Chat to choose another one.");
  if (!active.isLocal || active.id !== override.fromProviderId || (override.fromModel ?? undefined) !== activeModel) {
    throw new ModelOverrideError("The model in Chat changed since this request failed, so it was not sent. Send the question again.");
  }
  const chosen = input.providers.find((provider) => provider.id === override.providerId);
  if (!chosen) {
    throw new ModelOverrideError("That provider is not available on this device, so nothing was sent. It may not be set up, or your organization's policy may not allow it.");
  }
  if (!isProviderReady(chosen)) {
    throw new ModelOverrideError(`${chosen.name} is not ready, so nothing was sent. Check it in Settings, Providers, then choose it again.`);
  }
  if (override.model !== undefined && chosen.models.length > 0 && !chosen.models.includes(override.model)) {
    throw new ModelOverrideError(`${chosen.name} does not list ${override.model}, so nothing was sent. Choose it again in Chat.`);
  }
  const model = override.model ?? resolveProviderDefaultModel(chosen, input.activeModelByProviderId).model;
  if (chosen.id === active.id && model === activeModel) {
    throw new ModelOverrideError("That is the model this request already used. Choose another one, or narrow the question.");
  }
  if (!chosen.isLocal) {
    const consent = input.consent;
    if (!consent || consent.providerId !== chosen.id || consent.remember === true) {
      // A remembered "do not ask again" never covers a request the local model could not do.
      throw new ModelOverrideError(`Running this request with ${chosen.name} needs your approval for this request, so nothing was sent. Choose it again in Chat.`);
    }
  }
  return {
    provider: chosen,
    model,
    switchedFrom: { providerId: active.id, ...(activeModel ? { model: activeModel } : {}), reason: override.reason },
  };
}

/** What Chat records when the local model rejected a request for its size. */
export function chatModelFitFailure(
  error: unknown,
  provider: Pick<ProviderSummary, "id" | "isLocal">,
  model: string | undefined,
): ModelFitIssue | undefined {
  return classifyModelFitFailure(error, { providerId: provider.id, model, isLocal: provider.isLocal });
}

/**
 * The investigation failed on this local model often enough that Chat stops
 * trying it and answers from cached data: offer the alternatives with that
 * answer.
 */
export function repeatedFailureIssue(provider: Pick<ProviderSummary, "id" | "isLocal">, model: string | undefined): ModelFitIssue | undefined {
  if (!provider.isLocal) return undefined;
  return { reason: "repeated-failure", providerId: provider.id, ...(model ? { model } : {}) };
}
