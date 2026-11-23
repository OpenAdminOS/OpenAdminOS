import { isOnDeviceModel, managedLockedModel, managedProviderAllowed, providerCatalog, resolveProviderDefaultModel } from "@openadminos/agent-sdk";
import type { ManagedPolicyStatus, ModelFitIssue, ModelFitReason, ProviderId, ProviderSummary } from "./openAdminOS.js";
import { isProviderReady } from "./provider-detection.js";

/**
 * Model fit (SPEC.md, "Model fit"): when the local model cannot do a
 * request, Chat and the run page offer the configured alternatives and send
 * nothing elsewhere until the admin chooses one and accepts. Shared by the
 * main process, which records the issue and checks an override, and the
 * renderer, which offers the choices.
 */

// "thinking-only" comes from the Chat tool loop as its typed `failureReason`
// (a reply with no answer text), read below as a bare reason; an error that
// carries the reason as `kind` or `code` is read the same way.
/**
 * How every host refusal that ends a model fit offer (expired, used, made for
 * another question, the organization or model changed) tells the admin what
 * to do. Chat shows an offer's choices again after a refused retry only when
 * the refusal does not say this.
 */
export const MODEL_FIT_RESEND = "Send the question again.";

const FIT_REASONS: readonly ModelFitReason[] = ["context-too-small", "repeated-failure", "thinking-only"];

function count(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const value = Number(text.replace(/,/g, ""));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * A typed failure from the runtime, read by its shape so this module does
 * not depend on one class: `kind` or `code` names the reason, with the
 * numbers as `neededTokens`/`limitTokens` or `needed`/`limit`, on the error
 * or on its `failure` record (the agent runtime's prompt fit check), and
 * through `cause` when a wrapper adds context to the message.
 */
function typedIssue(error: unknown, depth = 0): Omit<ModelFitIssue, "providerId" | "model"> | undefined {
  if (!error || typeof error !== "object" || depth > 4) return undefined;
  const outer = error as Record<string, unknown>;
  // The failure record's own code wins over a wrapper's ("agent-failed" around "context-too-small").
  // A field the record leaves out falls back to the wrapper's.
  const failure = outer.failure && typeof outer.failure === "object" ? (outer.failure as Record<string, unknown>) : undefined;
  const fitReason = (source: Record<string, unknown>) =>
    [source.kind, source.code, source.reason].find(
      (value): value is ModelFitReason => typeof value === "string" && value !== "repeated-failure" && (FIT_REASONS as readonly string[]).includes(value),
    );
  // The record's own reason is the more specific one; the wrapper's applies only when it names none.
  const reason = (failure ? fitReason(failure) : undefined) ?? fitReason(outer);
  if (!reason || reason === "repeated-failure") return typedIssue(outer.cause, depth + 1);
  // The record's counts, under either name, come first; a wrapper fills in only its explicit token
  // fields, since its short `limit` may count something else, such as tool calls.
  const neededTokens = failure
    ? positive(failure.neededTokens) ?? positive(failure.needed) ?? positive(outer.neededTokens)
    : positive(outer.neededTokens) ?? positive(outer.needed);
  const limitTokens = failure
    ? positive(failure.limitTokens) ?? positive(failure.limit) ?? positive(outer.limitTokens)
    : positive(outer.limitTokens) ?? positive(outer.limit);
  return {
    reason,
    ...(neededTokens ? { neededTokens } : {}),
    ...(limitTokens ? { limitTokens } : {}),
  };
}

/**
 * The provider's own words for a prompt larger than the model's context.
 * Each pattern is one a provider on this device is known to send; a plain
 * "context" in an unrelated error does not match.
 */
function contextIssueFromText(text: string): Omit<ModelFitIssue, "providerId" | "model"> | undefined {
  // The agent runtime's own prompt fit check, when only its message survives (a stored run error).
  const promptFit = /This request needs about ([\d,]+) tokens of context \([\d,]+ for the prompt and [\d,]+ for the answer\), but .+? accepts ([\d,]+)/i.exec(text);
  if (promptFit) {
    const neededTokens = count(promptFit[1]);
    const limitTokens = count(promptFit[2]);
    return { reason: "context-too-small", ...(neededTokens ? { neededTokens } : {}), ...(limitTokens ? { limitTokens } : {}) };
  }
  // OpenAdminOS's Ollama adapter after its own retry (PR #211).
  const adapter = /context size too small: This request needs ([\d,]+) tokens of context, but (?:.+? supports at most ([\d,]+)\.|Ollama could only give .+? ([\d,]+), usually)/i.exec(text);
  if (adapter) {
    const neededTokens = count(adapter[1]);
    const modelMax = count(adapter[2]);
    const limitTokens = modelMax ?? count(adapter[3]);
    return {
      reason: "context-too-small",
      ...(neededTokens ? { neededTokens } : {}),
      ...(limitTokens ? { limitTokens } : {}),
      ...(modelMax ? { limitIsModelMax: true as const } : {}),
    };
  }
  // The adapter could not load the model with the larger context it asked for, usually for lack of memory.
  const memory = /context size too small: This request needs ([\d,]+) tokens of context, but Ollama could not load .+? with ([\d,]+), usually/i.exec(text);
  if (memory) {
    const neededTokens = count(memory[1]);
    const limitTokens = count(memory[2]);
    return {
      reason: "context-too-small",
      ...(neededTokens ? { neededTokens } : {}),
      ...(limitTokens ? { limitTokens, limitIsMemory: true as const } : {}),
    };
  }
  // The Ollama adapter when a request did not fit the size Ollama had loaded.
  const loadedFor = /context size too small: This request needs ([\d,]+) tokens of context and did not fit in the ([\d,]+) Ollama loaded for /i.exec(text);
  if (loadedFor) {
    const neededTokens = count(loadedFor[1]);
    const limitTokens = count(loadedFor[2]);
    return { reason: "context-too-small", ...(neededTokens ? { neededTokens } : {}), ...(limitTokens ? { limitTokens } : {}) };
  }
  // The LM Studio adapter (packages/runtime/src/llm-lm-studio.ts).
  const lmStudio = /LM Studio context length too small: This request needs ([\d,]+) tokens of context, but .+? is loaded in LM Studio with a context length of ([\d,]+)\./i.exec(text);
  if (lmStudio) {
    const neededTokens = count(lmStudio[1]);
    const limitTokens = count(lmStudio[2]);
    return { reason: "context-too-small", ...(neededTokens ? { neededTokens } : {}), ...(limitTokens ? { limitTokens } : {}) };
  }
  const lmStudioLoaded = /LM Studio context length too small: This request does not fit in the ([\d,]+) tokens of context/i.exec(text);
  if (lmStudioLoaded) {
    const limitTokens = count(lmStudioLoaded[1]);
    return { reason: "context-too-small", ...(limitTokens ? { limitTokens } : {}) };
  }
  // Ollama could not run the model at a context size for lack of memory: the size kept from an
  // earlier request, or the retry's, before or partway through an answer.
  // Not anchored, so a wrapper that adds words in front (such as "Agent failed:") keeps the reason.
  const memorySize = /\bOllama (?:could not load|failed partway through an answer from) .+? (?:with the|on the retry with a) ([\d,]+) token context size(?: kept from an earlier request)?, usually because free memory ran out/i.exec(text);
  if (memorySize) {
    const limitTokens = count(memorySize[1]);
    return { reason: "context-too-small", ...(limitTokens ? { limitTokens, limitIsMemory: true as const } : {}) };
  }
  // A size this request did not fit in: one kept from an earlier request, or the retry's.
  const kept = /context size too small: This request did not fit in the ([\d,]+) token context (?:kept from an earlier request|of the retry)/i.exec(text);
  if (kept) {
    const limitTokens = count(kept[1]);
    return { reason: "context-too-small", ...(limitTokens ? { limitTokens } : {}) };
  }
  // Any other form of either adapter's context message, without numbers.
  if (/\b(?:Ollama context size too small|LM Studio context length too small):/i.test(text)) return { reason: "context-too-small" };
  // Ollama's HTTP 400 for a prompt larger than the loaded context.
  const ollama = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(text);
  if (ollama) {
    const neededTokens = count(ollama[1]);
    const limitTokens = count(ollama[2]);
    return { reason: "context-too-small", ...(neededTokens ? { neededTokens } : {}), ...(limitTokens ? { limitTokens } : {}) };
  }
  // llama.cpp server, which LM Studio and Lemonade run.
  const availableContext = /exceeds the available context size/i.test(text);
  if (/exceed_context_size_error|\b(?:request|prompt) exceeds the available context size\b/i.test(text) || (availableContext && /"n_ctx"\s*:/.test(text))) {
    const neededTokens = count(/"n_prompt_tokens"\s*:\s*(\d+)/.exec(text)?.[1]);
    const limitTokens = count(/"n_ctx"\s*:\s*(\d+)/.exec(text)?.[1]);
    return { reason: "context-too-small", ...(neededTokens ? { neededTokens } : {}), ...(limitTokens ? { limitTokens } : {}) };
  }
  // The llama.cpp server's own wording, which the Lemonade adapter passes through as it is.
  if (/context size has been exceeded/i.test(text)) return { reason: "context-too-small" };
  // Apple Foundation's helper (SPEC.md, Apple Foundation is a small-context provider). Its count is
  // the prompt alone; the helper also reserves room for the answer, so the prompt can be below the limit.
  if (/context window is too small for this prompt/i.test(text)) {
    const neededTokens = count(/The prompt (?:uses|is estimated at) (\d+) tokens/i.exec(text)?.[1]);
    const limitTokens = count(/the model supports (\d+) tokens total/i.exec(text)?.[1]);
    return {
      reason: "context-too-small",
      ...(neededTokens ? { neededTokens } : {}),
      ...(limitTokens ? { limitTokens, limitIsModelMax: true as const } : {}),
    };
  }
  return undefined;
}

/**
 * Whether a failure means the local model is a poor fit for the request.
 * Only a provider on this device gets an issue: a hosted provider's limits
 * are its own, and the offer exists to leave a local model.
 */
export function classifyModelFitFailure(
  error: unknown,
  context: { providerId: ProviderId; model?: string | undefined; isLocal: boolean },
): ModelFitIssue | undefined {
  if (!context.isLocal) return undefined;
  // A bare typed reason, such as a run's `failureReason: "context-too-small"`.
  const bare = typeof error === "string" && error !== "repeated-failure" && (FIT_REASONS as readonly string[]).includes(error) ? { reason: error as ModelFitReason } : undefined;
  const typed = bare ?? typedIssue(error);
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  const found = typed ?? (text ? contextIssueFromText(text) : undefined);
  if (!found) return undefined;
  return { ...found, providerId: context.providerId, ...(context.model ? { model: context.model } : {}) };
}

/**
 * A model name that stands for "the CLI's own default" rather than a model:
 * the Gemini adapter sends no `--model` for it (GEMINI_DEFAULT_MODEL in
 * packages/runtime/src/llm-gemini.ts), so the CLI may answer with whatever
 * it is set to when the request runs. A model fit approval names one model,
 * so such a name is never a model fit choice.
 */
export function isPlaceholderModel(model: string | undefined): boolean {
  return model === "gemini-default";
}

/**
 * A model a hosted provider can run a model fit request on: named, not a
 * placeholder, and in the list the provider reports now. Chat, the run
 * review and the run host use this one check, so they cannot disagree.
 */
export function isListedHostedModel(provider: Pick<ProviderSummary, "models" | "modelsFromPolicy">, model: string | undefined): model is string {
  // A model the managed policy put in an empty list is allowed, not reported: the CLI could still run its own.
  return Boolean(model) && !isPlaceholderModel(model) && provider.modelsFromPolicy !== true && provider.models.includes(model!);
}

/**
 * The model a hosted provider would run a model fit request on: its pinned or
 * default model when the provider lists it, else the first model it lists
 * (a CLI's configured default can be one it does not list). Undefined when it
 * lists none, so the provider is not offered.
 */
export function hostedModelFitModel(
  provider: Pick<ProviderSummary, "id" | "models" | "defaultModel" | "modelsFromPolicy">,
  activeModelByProviderId?: Partial<Record<ProviderId, string>>,
): string | undefined {
  const preferred = resolveProviderDefaultModel(provider as ProviderSummary, activeModelByProviderId).model;
  if (isListedHostedModel(provider, preferred)) return preferred;
  return provider.models.find((model) => isListedHostedModel(provider, model));
}

export { isOllamaCloudModel, isOnDeviceModel, isRemoteBackedModel } from "@openadminos/agent-sdk";

/** Resolve a rerun model from the models actually available on this device. */
export function onDeviceRerunProvider(provider: ProviderSummary): ProviderSummary {
  const models = provider.models.filter((model) => isOnDeviceModel(provider, model) && !isPlaceholderModel(model));
  return { ...provider, models, defaultModel: models.includes(provider.defaultModel ?? "") ? provider.defaultModel : models[0] };
}

/** The parameter count in a model's name, such as 8 for "openadmin-8b" or 20 for "gpt-oss:20b". */
export function modelSizeBillions(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const matches = [...model.toLowerCase().matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)];
  const value = matches.length > 0 ? Number(matches[matches.length - 1]![1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface ModelFitChoice {
  providerId: ProviderId;
  providerName: string;
  isLocal: boolean;
  /** The model the request would use, the admin's pinned one for that provider when set. */
  model?: string;
}

export interface ModelFitChoices {
  /** Configured, ready hosted providers, in the order the provider list gives. Never preselected. */
  hosted: ModelFitChoice[];
  /** Larger installed models on ready providers on this device. */
  local: ModelFitChoice[];
  /** Hosted providers exist in the catalog but none is listed: the managed policy left them out. */
  hostedBlockedByPolicy: boolean;
}

/**
 * What the admin can choose instead of the local model for this request.
 * Only providers in `providers` count, which is the list the main process
 * filtered by the managed policy, and only ready ones: a provider that
 * would fail its check is not offered.
 *
 * A larger local model is one with a larger parameter count in its name.
 * TODO(ugur): read each local model's context length (Ollama /api/show) so
 * only models that can take the request are offered for a context failure?
 */
export function modelFitChoices(input: {
  issue: ModelFitIssue;
  providers: readonly ProviderSummary[];
  activeModelByProviderId?: Partial<Record<ProviderId, string>> | undefined;
  /** The managed policy (policy.json), to say when it is why no hosted provider is offered. */
  managedPolicy?: ManagedPolicyStatus | undefined;
}): ModelFitChoices {
  const { issue, providers } = input;
  // Hosted means a hosted service (a vendor CLI or Azure OpenAI). A model server outside this device
  // that OpenAdminOS reaches directly is not offered: its location is not stated and it may redirect.
  const hosted = providers
    .filter((provider) => !provider.isLocal && HOSTED_PROVIDER_IDS.has(provider.id) && provider.id !== issue.providerId && isProviderReady(provider) && managedProviderAllowed(input.managedPolicy, provider.id))
    .flatMap((provider) => {
      // The accept step names the exact model, so a provider that reports none yet is not offered.
      const model = hostedModelFitModel(provider, input.activeModelByProviderId);
      return model ? [{ providerId: provider.id, providerName: provider.name, isLocal: false, model }] : [];
    });
  const currentSize = modelSizeBillions(issue.model);
  const local: ModelFitChoice[] = [];
  // Repeated failures and reasoning budgets are about the model, so any
  // larger model helps; a size is needed to call one larger at all. A prompt
  // that did not fit a model whose size cannot be read from its name (Apple
  // Foundation, a custom alias) is offered every sized model on this device,
  // since its row already says the context size is not checked.
  const sizeUnknownContext = currentSize === undefined && issue.reason === "context-too-small";
  if (currentSize !== undefined || sizeUnknownContext) {
    for (const provider of providers) {
      if (!provider.isLocal || !isProviderReady(provider) || !managedProviderAllowed(input.managedPolicy, provider.id)) continue;
      for (const model of provider.models) {
        if (provider.id === issue.providerId && model === issue.model) continue;
        if (!isOnDeviceModel(provider, model)) continue;
        // A model the managed policy locks this provider to is the only one it may use.
        const locked = managedLockedModel(input.managedPolicy, provider.id);
        if (locked !== undefined && model !== locked) continue;
        const size = modelSizeBillions(model);
        if (size !== undefined && (currentSize === undefined || size > currentSize)) {
          local.push({ providerId: provider.id, providerName: provider.name, isLocal: true, model });
        }
      }
    }
    // The next larger models first; with the failed size unknown, the largest first, since a small
    // one is the likeliest to have the same small context.
    local.sort((a, b) => (sizeUnknownContext ? -1 : 1) * ((modelSizeBillions(a.model) ?? 0) - (modelSizeBillions(b.model) ?? 0)));
  }
  // The main process already left out what the policy does not allow; this
  // only says so when the policy is the reason nothing hosted is offered.
  // Policy is why nothing hosted is offered when it allows no hosted provider, or when a ready hosted
  // provider's only model came from a policy lock (allowed, not reported): only IT can change either.
  const hostedBlockedByPolicy =
    hosted.length === 0 &&
    ([...HOSTED_PROVIDER_IDS].every((id) => !managedProviderAllowed(input.managedPolicy, id)) ||
      providers.some((provider) => !provider.isLocal && HOSTED_PROVIDER_IDS.has(provider.id) && provider.id !== issue.providerId && isProviderReady(provider) && provider.modelsFromPolicy === true));
  return { hosted, local: local.slice(0, 2), hostedBlockedByPolicy };
}

/** Model servers OpenAdminOS reaches directly; outside this device they are never a model fit hosted choice. */
export const SELF_HOSTED_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set<ProviderId>(["ollama", "lm-studio", "lemonade"]);

// The catalog names which providers are hosted; a new one is covered without a change here.
const HOSTED_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set(providerCatalog.filter((provider) => !provider.isLocal).map((provider) => provider.id));
