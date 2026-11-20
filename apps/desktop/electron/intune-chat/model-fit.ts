import { randomUUID } from "node:crypto";
import { resolveProviderDefaultModel } from "@openadminos/agent-sdk";
import type {
  ChatModelOverride,
  HostedProviderChatConsent,
  IntuneChatMessage,
  ModelFitIssue,
  ModelFitReason,
  ProviderId,
  ProviderSummary,
  RunLlmApi,
} from "@openadminos/agent-sdk";
import { classifyModelFitFailure, hostedModelFitModel, isListedHostedModel, isOnDeviceModel, isPlaceholderModel, isRemoteBackedModel, SELF_HOSTED_PROVIDER_IDS } from "../../src/shared/model-fit.js";
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

/** How long an offer from a failed answer can be taken up. */
export const MODEL_FIT_OFFER_TTL_MS = 15 * 60_000;
/** The renderer and the host share this device's clock; this only absorbs millisecond rounding. */
const ACKNOWLEDGED_CLOCK_SLACK_MS = 1_000;
const MAX_OFFERS = 50;

/** A request the local model could not do, which may be run again once with another provider. */
export interface ModelFitOffer {
  id: string;
  conversationId: string;
  /** Undefined for a request with no organization. */
  tenantId: string | undefined;
  /** The question, exactly as it was sent. */
  content: string;
  /** The workspace context selection it was sent with, as validated JSON; undefined without one. */
  workspaceKey: string | undefined;
  /** The active provider and model when the request failed; an override needs them still active. */
  anchor: { providerId: ProviderId; model: string | undefined };
  /** The model that could not do it: the anchor, or a larger local model tried for this request. */
  failed: { providerId: ProviderId; model: string | undefined };
  reason: ModelFitReason;
  createdAt: number;
}

/**
 * Offers the host issued with failed answers. An override must name one,
 * for the same conversation, organization and question, while the same
 * model is active, and uses it up. In memory only: after a restart the
 * question is sent again.
 */
export class ModelFitOffers {
  private readonly offers = new Map<string, ModelFitOffer>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  issue(input: Omit<ModelFitOffer, "id" | "createdAt">): string {
    this.prune();
    // The newest offer replaces earlier ones for the same conversation; the renderer holds only it.
    for (const [id, offer] of this.offers) if (offer.conversationId === input.conversationId) this.offers.delete(id);
    while (this.offers.size >= MAX_OFFERS) this.offers.delete(this.offers.keys().next().value!);
    const id = `fit_${randomUUID()}`;
    this.offers.set(id, { ...input, id, createdAt: this.now() });
    return id;
  }

  /** The offer an override names, checked against this request. Not used up yet. */
  check(id: string, request: { conversationId: string | undefined; tenantId: string | undefined; content: string; workspaceKey: string | undefined }): ModelFitOffer {
    this.prune();
    const offer = this.offers.get(id);
    if (!offer) throw new ModelOverrideError("This choice is no longer available, so nothing was sent. Send the question again.");
    if (
      offer.conversationId !== request.conversationId ||
      offer.tenantId !== request.tenantId ||
      offer.content !== request.content ||
      offer.workspaceKey !== request.workspaceKey
    ) {
      throw new ModelOverrideError("This choice belongs to another question, so nothing was sent. Send the question again.");
    }
    return offer;
  }

  /**
   * Uses up an offer once its request is cleared to send. Synchronous, so of
   * two sends that both passed `check`, only the first gets it; the other is
   * refused before any model is built.
   */
  claim(id: string): void {
    // An offer that expired since it was checked is gone too, and says so rather than "used".
    const expired = this.offers.has(id) && this.offers.get(id)!.createdAt < this.now() - MODEL_FIT_OFFER_TTL_MS;
    this.prune();
    if (expired) throw new ModelOverrideError("This choice is no longer available, so nothing was sent. Send the question again.");
    if (!this.offers.delete(id)) {
      throw new ModelOverrideError("This choice was already used, so nothing more was sent. Send the question again.");
    }
  }

  private prune(): void {
    const cutoff = this.now() - MODEL_FIT_OFFER_TTL_MS;
    for (const [id, offer] of this.offers) if (offer.createdAt < cutoff) this.offers.delete(id);
  }
}

export interface ChatTurnProvider {
  provider: ProviderSummary;
  model: string | undefined;
  /** Set when this request runs on another provider or model than the active one. */
  switchedFrom?: NonNullable<IntuneChatMessage["switchedFrom"]>;
}

/**
 * The provider and model of one Chat request. Without an override, the
 * active ones. With an override and its checked offer, the chosen provider,
 * after checking that:
 * - the active provider and model are still the ones the offer was made
 *   for, so a stale offer cannot apply to another setup;
 * - the chosen provider is in the provider list (which the managed policy
 *   already filtered) and ready, lists the model, and is not the model that
 *   failed; a model on this device is not an Ollama Cloud model;
 * - a hosted provider comes with an acceptance for it that is not a
 *   remembered one. Its age, model and tenant are checked later by the
 *   same consent check every hosted send passes.
 * Nova never takes an override: its provider is pinned for the session.
 */
export function resolveChatTurnProvider(input: {
  override: ChatModelOverride | undefined;
  offer: ModelFitOffer | undefined;
  providers: readonly ProviderSummary[];
  active: ProviderSummary;
  activeModel: string | undefined;
  activeModelByProviderId?: Partial<Record<ProviderId, string>> | undefined;
  consent: HostedProviderChatConsent | undefined;
  nova: boolean;
}): ChatTurnProvider {
  const { override, offer, active, activeModel } = input;
  if (!override) {
    // An acceptance made for a model fit offer covers that one request, never an ordinary send.
    if (input.consent?.modelFitOfferId !== undefined) {
      throw new ModelOverrideError("That approval was for one request the local model could not do, so nothing was sent. Send the question again.");
    }
    return { provider: active, model: activeModel };
  }
  if (input.nova) throw new ModelOverrideError("Nova answers with its own provider only. Ask this in Chat to choose another one.");
  if (!offer || offer.id !== override.offerId) {
    throw new ModelOverrideError("This choice is no longer available, so nothing was sent. Send the question again.");
  }
  if (active.id !== offer.anchor.providerId || activeModel !== offer.anchor.model) {
    throw new ModelOverrideError("The model in Chat changed since this request failed, so it was not sent. Send the question again.");
  }
  const chosen = input.providers.find((provider) => provider.id === override.providerId);
  if (!chosen) {
    throw new ModelOverrideError("That provider is not available on this device, so nothing was sent. It may not be set up, or your organization's policy may not allow it.");
  }
  if (!chosen.isLocal && SELF_HOSTED_PROVIDER_IDS.has(chosen.id)) {
    throw new ModelOverrideError(`${chosen.name} is set to a server outside this device, so it is not offered for one request. Choose a hosted provider.`);
  }
  if (!isProviderReady(chosen)) {
    throw new ModelOverrideError(`${chosen.name} is not ready, so nothing was sent. Check it in Settings, Providers, then choose it again.`);
  }
  if (override.model !== undefined && chosen.models.length > 0 && !chosen.models.includes(override.model)) {
    throw new ModelOverrideError(`${chosen.name} does not list ${override.model}, so nothing was sent. Choose it again in Chat.`);
  }
  const model = override.model ?? (chosen.isLocal ? resolveProviderDefaultModel(chosen, input.activeModelByProviderId).model : hostedModelFitModel(chosen, input.activeModelByProviderId));
  if ((chosen.id === offer.failed.providerId && model === offer.failed.model) || (chosen.id === active.id && model === activeModel)) {
    throw new ModelOverrideError("That model already could not do this request. Choose another one, or narrow the question.");
  }
  if (!chosen.isLocal && !isListedHostedModel(chosen, model)) {
    // The approval names one model the provider lists now; otherwise it could pick its own after it.
    throw new ModelOverrideError(
      model && !isPlaceholderModel(model) && chosen.models.length > 0 && chosen.modelsFromPolicy !== true
        ? `${chosen.name} no longer lists ${model}, so nothing was sent. Choose it again in Chat.`
        : `${chosen.name} does not report a model yet, so nothing was sent. Check it in Settings, Providers, then choose it again.`,
    );
  }
  if (chosen.isLocal && isRemoteBackedModel(chosen, model)) {
    // A cloud or remote-backed model on a loopback Ollama sends the prompt to another host.
    throw new ModelOverrideError(`${model} runs on another server, not on this device, so nothing was sent. Choose another model.`);
  }
  if (!chosen.isLocal) {
    const consent = input.consent;
    // The acknowledgement must accept this offer, after it was made, for this provider and model.
    // A remembered "do not ask again" never covers a request the local model could not do.
    const acknowledged = consent ? Date.parse(consent.acknowledgedAt) : NaN;
    if (
      !consent ||
      consent.providerId !== chosen.id ||
      consent.remember === true ||
      consent.modelFitOfferId !== offer.id ||
      consent.model !== model ||
      !(acknowledged >= offer.createdAt - ACKNOWLEDGED_CLOCK_SLACK_MS)
    ) {
      throw new ModelOverrideError(`Running this request with ${chosen.name} needs your approval for this request, so nothing was sent. Choose it again in Chat.`);
    }
  }
  return {
    provider: chosen,
    model,
    switchedFrom: { providerId: offer.anchor.providerId, ...(offer.anchor.model ? { model: offer.anchor.model } : {}), reason: offer.reason, toOnDevice: chosen.isLocal },
  };
}

/**
 * Wraps a model so every call first passes `before` (a fresh on-device
 * check for a retry on a model on this device) and then reports that a
 * request was dispatched. Calls the adapter makes inside one request (such
 * as Ollama's own context retry) go to the same address and model name and
 * are not checked again.
 * TODO(ugur): the Ollama adapter (packages/runtime/src/llm-ollama.ts, owned
 * by another workstream) could take a hook before its internal context
 * retry, so an alias that turns remote-backed within one request is refused
 * there too. This PR does not edit that file.
 */
export function guardModelFitLlm(llm: RunLlmApi, guard: { before: () => Promise<void>; dispatched: () => void; model?: string | undefined }): RunLlmApi {
  // A call that names another model than the reviewed one is refused before any check or I/O:
  // the adapter would honour it, and the approval named one model.
  const sameModel = (options: { model?: string | undefined }) => {
    if (guard.model !== undefined && options.model !== undefined && options.model !== guard.model) {
      throw new ModelOverrideError(`This request was approved for ${guard.model} only, so a call for ${options.model} was not sent.`);
    }
  };
  return {
    ...llm,
    // A call that is already stopped reaches the adapter with an aborted signal and sends nothing,
    // and an adapter that is not available sends nothing either, so neither is counted as dispatched.
    // An adapter that throws while building its request is still counted; the answer then says
    // "Attempted through", not that it was sent.
    complete: async (options) => {
      sameModel(options);
      await guard.before();
      if (!options.signal?.aborted && llm.available) guard.dispatched();
      return llm.complete(options);
    },
    stream: async function* (options) {
      sameModel(options);
      await guard.before();
      if (!options.signal?.aborted && llm.available) guard.dispatched();
      yield* llm.stream(options);
    },
  };
}

/** What Chat records when the local model rejected a request for its size. */
export function chatModelFitFailure(
  error: unknown,
  provider: Pick<ProviderSummary, "id" | "isLocal" | "remoteModels">,
  model: string | undefined,
): ModelFitIssue | undefined {
  // A remote-backed model on a local server already sent its prompt elsewhere: no on-device offer.
  return classifyModelFitFailure(error, { providerId: provider.id, model, isLocal: isOnDeviceModel(provider, model) });
}

/**
 * A finer reason the investigation loop reports when it falls back to cached
 * data (`failureReason`, from the local model accuracy work): a prompt that
 * did not fit, or a reply that was reasoning only. Read by its shape, so it
 * applies once that loop reports it.
 */
export function loopFailureIssue(
  result: object,
  provider: Pick<ProviderSummary, "id" | "isLocal" | "remoteModels">,
  model: string | undefined,
): ModelFitIssue | undefined {
  if (!isOnDeviceModel(provider, model)) return undefined;
  const failureReason = (result as { failureReason?: unknown }).failureReason;
  const reason = failureReason === "context-too-small" || failureReason === "thinking-only" ? failureReason : undefined;
  if (!reason) return undefined;
  // The loop keeps the provider's error as `failureDetail`; its numbers go into the notice.
  const detail = (result as { failureDetail?: unknown }).failureDetail;
  const fromDetail = reason === "context-too-small" && detail !== undefined
    ? classifyModelFitFailure(detail, { providerId: provider.id, model, isLocal: true })
    : undefined;
  const counts = fromDetail?.reason === "context-too-small" ? fromDetail : undefined;
  return {
    reason,
    providerId: provider.id,
    ...(model ? { model } : {}),
    ...(counts?.neededTokens ? { neededTokens: counts.neededTokens } : {}),
    ...(counts?.limitTokens ? { limitTokens: counts.limitTokens } : {}),
    ...(counts?.limitIsModelMax ? { limitIsModelMax: true as const } : {}),
    ...(counts?.limitIsMemory ? { limitIsMemory: true as const } : {}),
  };
}

/**
 * The investigation failed on this local model often enough that Chat stops
 * trying it and answers from cached data: offer the alternatives with that
 * answer.
 */
export function repeatedFailureIssue(provider: Pick<ProviderSummary, "id" | "isLocal" | "remoteModels">, model: string | undefined): ModelFitIssue | undefined {
  if (!isOnDeviceModel(provider, model)) return undefined;
  return { reason: "repeated-failure", providerId: provider.id, ...(model ? { model } : {}) };
}
