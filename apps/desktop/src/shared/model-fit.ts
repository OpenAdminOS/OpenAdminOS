import { managedLockedModel, managedProviderAllowed, providerCatalog, resolveProviderDefaultModel } from "@openadminos/agent-sdk";
import type { ManagedPolicyStatus, ModelFitIssue, ModelFitReason, ProviderId, ProviderSummary } from "./openAdminOS.js";
import { isProviderReady } from "./provider-detection.js";

/**
 * Model fit (SPEC.md, "Model fit"): when the local model cannot do a
 * request, Chat and the run page offer the configured alternatives and send
 * nothing elsewhere until the admin chooses one and accepts. Shared by the
 * main process, which records the issue and checks an override, and the
 * renderer, which offers the choices.
 */

// "thinking-only" has no producer on main yet: the reasoning report work
// (runtime/gpt-oss-reasoning-report) is to raise it as a typed reason.
// TODO(ugur): confirm the shape that branch uses (`kind` or `code`).
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
 * numbers as `neededTokens`/`limitTokens` or `needed`/`limit`.
 */
function typedIssue(error: unknown): Omit<ModelFitIssue, "providerId" | "model"> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  const reason = [record.kind, record.code, record.reason].find(
    (value): value is ModelFitReason => typeof value === "string" && (FIT_REASONS as readonly string[]).includes(value),
  );
  if (!reason || reason === "repeated-failure") return undefined;
  const neededTokens = positive(record.neededTokens) ?? positive(record.needed);
  const limitTokens = positive(record.limitTokens) ?? positive(record.limit);
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
  // Ollama's HTTP 400 for a prompt larger than the loaded context.
  const ollama = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(text);
  if (ollama) {
    const neededTokens = count(ollama[1]);
    const limitTokens = count(ollama[2]);
    return { reason: "context-too-small", ...(neededTokens ? { neededTokens } : {}), ...(limitTokens ? { limitTokens } : {}) };
  }
  // llama.cpp server, which LM Studio and Lemonade run.
  if (/exceed_context_size_error|exceeds the available context size/i.test(text)) {
    const neededTokens = count(/"n_prompt_tokens"\s*:\s*(\d+)/.exec(text)?.[1]);
    const limitTokens = count(/"n_ctx"\s*:\s*(\d+)/.exec(text)?.[1]);
    return { reason: "context-too-small", ...(neededTokens ? { neededTokens } : {}), ...(limitTokens ? { limitTokens } : {}) };
  }
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
  const typed = typedIssue(error);
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : undefined;
  const found = typed ?? (text ? contextIssueFromText(text) : undefined);
  if (!found) return undefined;
  return { ...found, providerId: context.providerId, ...(context.model ? { model: context.model } : {}) };
}

/**
 * An Ollama Cloud model, such as "gpt-oss:120b-cloud" or "glm-4.6:cloud".
 * A loopback Ollama that is signed in to ollama.com lists these with its
 * local models, but their prompts are processed on Ollama's servers, so
 * they are never offered or accepted as a model on this device.
 * TODO(ugur): Ollama's /api/tags also marks them with `remote_host`; should
 * provider detection read that and label cloud models everywhere?
 */
export function isOllamaCloudModel(model: string | undefined): boolean {
  return Boolean(model && /[:-]cloud$/i.test(model.trim()));
}

/**
 * A model whose prompts leave this device although its provider runs here:
 * one the server marks as remote-backed, or an Ollama Cloud name.
 */
export function isRemoteBackedModel(provider: Pick<ProviderSummary, "id" | "remoteModels">, model: string | undefined): boolean {
  if (!model) return false;
  return Boolean(provider.remoteModels?.includes(model)) || (provider.id === "ollama" && isOllamaCloudModel(model));
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
  const hosted = providers
    .filter((provider) => !provider.isLocal && provider.id !== issue.providerId && isProviderReady(provider) && managedProviderAllowed(input.managedPolicy, provider.id))
    .map((provider) => {
      const model = resolveProviderDefaultModel(provider, input.activeModelByProviderId).model;
      return { providerId: provider.id, providerName: provider.name, isLocal: false, ...(model ? { model } : {}) };
    });
  const currentSize = modelSizeBillions(issue.model);
  const local: ModelFitChoice[] = [];
  // Repeated failures and reasoning budgets are about the model, so any
  // larger model helps; a size is needed to call one larger at all.
  if (currentSize !== undefined) {
    for (const provider of providers) {
      if (!provider.isLocal || !isProviderReady(provider) || !managedProviderAllowed(input.managedPolicy, provider.id)) continue;
      for (const model of provider.models) {
        if (provider.id === issue.providerId && model === issue.model) continue;
        if (isRemoteBackedModel(provider, model)) continue;
        // A model the managed policy locks this provider to is the only one it may use.
        const locked = managedLockedModel(input.managedPolicy, provider.id);
        if (locked !== undefined && model !== locked) continue;
        const size = modelSizeBillions(model);
        if (size !== undefined && size > currentSize) {
          local.push({ providerId: provider.id, providerName: provider.name, isLocal: true, model });
        }
      }
    }
    local.sort((a, b) => (modelSizeBillions(a.model) ?? 0) - (modelSizeBillions(b.model) ?? 0));
  }
  // The main process already left out what the policy does not allow; this
  // only says so when the policy is the reason nothing hosted is offered.
  const hostedBlockedByPolicy =
    hosted.length === 0 && [...HOSTED_PROVIDER_IDS].every((id) => !managedProviderAllowed(input.managedPolicy, id));
  return { hosted, local: local.slice(0, 2), hostedBlockedByPolicy };
}

// The catalog names which providers are hosted; a new one is covered without a change here.
const HOSTED_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set(providerCatalog.filter((provider) => !provider.isLocal).map((provider) => provider.id));
