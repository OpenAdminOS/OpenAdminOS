import {
  MANAGED_POLICY_SETTING_KEYS,
  isManagedSettingLocked,
  managedLockedModel,
  managedProviderAllowed,
  providerCatalog,
  type ManagedPolicyScope,
  type ManagedPolicySettingKey,
  type ManagedPolicyStatus,
  type ManagedPolicyValues,
  type ProviderId,
  type ProviderSummary,
  type SavedAppRegistration,
} from "@openadminos/agent-sdk";

import type { ManagedPolicyRecord } from "./configuration-audit.js";
import {
  describeManagedPolicyIssue,
  managedPolicyFingerprint,
  managedPolicyIssuesFingerprint,
} from "./managed-policy.js";
import { rememberAppRegistration } from "./state-helpers.js";

/**
 * Applies the IT policy file to persisted state and to the provider list.
 * Pure functions, so the store calls them at launch and wherever it lists
 * providers, and tests call them directly.
 */

/** The parts of persisted state the policy sets. */
export interface PolicyApplicableState {
  activeProviderId: ProviderId;
  providerChosenByUser?: boolean;
  providerAutoSelection?: { providerId: ProviderId; noticeDismissed: boolean };
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
  savedAppRegistrations?: SavedAppRegistration[];
  managedPolicy?: ManagedPolicyRecord;
}

export function registrationKey(entry: { clientId: string; directoryTenantId?: string | undefined }): string {
  return `${entry.clientId.trim().toLowerCase()}|${(entry.directoryTenantId ?? "").trim().toLowerCase()}`;
}

export function policyRegistrationKey(status: ManagedPolicyStatus | undefined): string | undefined {
  const registration = status?.values.appRegistration;
  return registration ? registrationKey({ clientId: registration.clientId, directoryTenantId: registration.tenantId }) : undefined;
}

function policyRecord(status: ManagedPolicyStatus, previous: ManagedPolicyRecord | undefined): ManagedPolicyRecord {
  const fingerprint = managedPolicyFingerprint(status);
  const issuesFingerprint = managedPolicyIssuesFingerprint(status);
  return {
    ...(fingerprint ? { fingerprint } : {}),
    ...(issuesFingerprint ? { issuesFingerprint } : {}),
    values: status.values,
    sources: status.sources,
    locked: status.locked,
    issues: status.issues.map(describeManagedPolicyIssue),
    ...(previous?.noticeDismissedFor ? { noticeDismissedFor: previous.noticeDismissedFor } : {}),
    ...(previous?.seededRegistration ? { seededRegistration: previous.seededRegistration } : {}),
  };
}

/**
 * The state the policy asks for. A locked value always applies; an
 * unlocked default applies until the admin changes it. A provider the
 * policy does not allow is replaced by the policy's provider, or the first
 * allowed one.
 */
export function applyManagedPolicy<T extends PolicyApplicableState>(state: T, status: ManagedPolicyStatus | undefined, now: string): T {
  const next: T = { ...state };
  const previous = state.managedPolicy;
  if (!status) {
    delete next.managedPolicy;
    return next;
  }
  const record = policyRecord(status, previous);
  const { defaultProvider, defaultModel, appRegistration } = status.values;

  const allowed = (id: ProviderId) => managedProviderAllowed(status, id);
  let provider: ProviderId | undefined;
  if (defaultProvider && (isManagedSettingLocked(status, "defaultProvider") || state.providerChosenByUser === false || !allowed(state.activeProviderId))) {
    provider = defaultProvider;
  } else if (!allowed(state.activeProviderId)) {
    provider = providerCatalog.find((entry) => allowed(entry.id))?.id;
  }
  if (provider && provider !== state.activeProviderId) {
    next.activeProviderId = provider;
    delete next.providerAutoSelection;
  }

  if (defaultProvider && defaultModel) {
    const current = state.activeModelByProviderId?.[defaultProvider];
    // An unlocked model replaces only the policy's own earlier default, never the admin's pick.
    const untouched = current === undefined || current === previous?.values.defaultModel;
    if (current !== defaultModel && (isManagedSettingLocked(status, "defaultModel") || untouched)) {
      next.activeModelByProviderId = { ...(state.activeModelByProviderId ?? {}), [defaultProvider]: defaultModel };
    }
  }

  const key = policyRegistrationKey(status);
  if (appRegistration && key) {
    const saved = state.savedAppRegistrations ?? [];
    const present = saved.some((entry) => registrationKey(entry) === key);
    const seed = isManagedSettingLocked(status, "appRegistration") ? !present : previous?.seededRegistration !== key;
    if (seed) {
      next.savedAppRegistrations = rememberAppRegistration(saved, {
        clientId: appRegistration.clientId,
        ...(appRegistration.tenantId ? { directoryTenantId: appRegistration.tenantId } : {}),
        ...(appRegistration.label ? { label: appRegistration.label } : {}),
        lastUsedAt: now,
      });
    }
    record.seededRegistration = key;
  }
  next.managedPolicy = record;
  return next;
}

/**
 * The providers the renderer and every main-process caller see. Providers
 * the policy does not allow are left out. A locked model is the only model
 * of its provider; when the provider does not list it, nothing can run and
 * the provider says why.
 */
export function applyManagedPolicyToProviders(
  providers: readonly ProviderSummary[],
  status: ManagedPolicyStatus | undefined,
): ProviderSummary[] {
  if (!status) return [...providers];
  return providers
    .filter((provider) => managedProviderAllowed(status, provider.id))
    .map((provider) => {
      const model = managedLockedModel(status, provider.id);
      // Not checked yet (the first-run scan is pending): nothing is known about its models.
      if (!model || provider.status === "not-checked") return provider;
      // An empty list means the CLI picks the model, so the policy model is passed to it.
      if (provider.models.length === 0 || provider.models.includes(model)) {
        return { ...provider, models: [model], defaultModel: model };
      }
      const { defaultModel: _unlisted, ...rest } = provider;
      return {
        ...rest,
        status: "error",
        models: [],
        detail: `Your IT department set the model ${model}, which ${provider.name} does not list. Install it, then refresh providers.`,
      };
    });
}

/** The status the renderer sees, with the one-time notice state. */
export function managedPolicyForRenderer(status: ManagedPolicyStatus | undefined, record: ManagedPolicyRecord | undefined): ManagedPolicyStatus | undefined {
  if (!status) return undefined;
  const issues = managedPolicyIssuesFingerprint(status);
  return { ...status, ...(issues && record?.noticeDismissedFor === issues ? { noticeDismissed: true } : {}) };
}

/** Saved registrations with the policy's registration marked. */
export function markManagedRegistrations(
  saved: readonly SavedAppRegistration[],
  status: ManagedPolicyStatus | undefined,
): SavedAppRegistration[] {
  const key = policyRegistrationKey(status);
  if (!key) return [...saved];
  const managed = saved.filter((entry) => registrationKey(entry) === key).map((entry) => ({ ...entry, managed: true }));
  return [...managed, ...saved.filter((entry) => registrationKey(entry) !== key)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SETTING_KEYS: ReadonlySet<string> = new Set(MANAGED_POLICY_SETTING_KEYS);
const PROVIDER_IDS: ReadonlySet<string> = new Set(providerCatalog.map((provider) => provider.id));

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : undefined;
}

/** The stored record, or undefined when it is not one. Values are only kept for audit comparison. */
export function sanitizeManagedPolicyRecord(value: unknown): ManagedPolicyRecord | undefined {
  if (!isRecord(value)) return undefined;
  const values: ManagedPolicyValues = {};
  const rawValues = isRecord(value.values) ? value.values : {};
  const providers = stringList(rawValues.allowedProviders);
  if (providers) values.allowedProviders = providers.filter((entry) => PROVIDER_IDS.has(entry)) as ProviderId[];
  if (typeof rawValues.defaultProvider === "string" && PROVIDER_IDS.has(rawValues.defaultProvider)) {
    values.defaultProvider = rawValues.defaultProvider as ProviderId;
  }
  if (typeof rawValues.defaultModel === "string") values.defaultModel = rawValues.defaultModel;
  const references = stringList(rawValues.allowedPublicReferences);
  if (references) values.allowedPublicReferences = references;
  if (isRecord(rawValues.appRegistration) && typeof rawValues.appRegistration.clientId === "string") {
    const registration = rawValues.appRegistration;
    values.appRegistration = {
      clientId: registration.clientId as string,
      ...(typeof registration.tenantId === "string" ? { tenantId: registration.tenantId } : {}),
      ...(typeof registration.label === "string" ? { label: registration.label } : {}),
    };
  }
  if (typeof rawValues.skipFirstRunScan === "boolean") values.skipFirstRunScan = rawValues.skipFirstRunScan;
  const voiceModes = stringList(rawValues.novaVoiceModes);
  if (voiceModes) values.novaVoiceModes = voiceModes.filter((mode): mode is "local" | "openai" => mode === "local" || mode === "openai");
  if (typeof rawValues.novaInstructions === "string") values.novaInstructions = rawValues.novaInstructions;
  if (isRecord(rawValues.novaCapabilities)) {
    const raw = rawValues.novaCapabilities;
    const capabilities: NonNullable<ManagedPolicyValues["novaCapabilities"]> = {};
    for (const field of ["webSearch", "startAgents", "navigation"] as const) {
      if (typeof raw[field] === "boolean") capabilities[field] = raw[field] as boolean;
    }
    const sends = raw.connectorSends;
    if (typeof sends === "boolean") capabilities.connectorSends = sends;
    else if (stringList(sends)) capabilities.connectorSends = stringList(sends);
    if (Object.keys(capabilities).length > 0) values.novaCapabilities = capabilities;
  }
  if (rawValues.novaMemory === "off") values.novaMemory = "off";
  const sources: ManagedPolicyRecord["sources"] = {};
  if (isRecord(value.sources)) {
    for (const [key, scope] of Object.entries(value.sources)) {
      if (SETTING_KEYS.has(key) && (scope === "machine" || scope === "user")) sources[key as ManagedPolicySettingKey] = scope as ManagedPolicyScope;
    }
  }
  return {
    ...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
    ...(typeof value.issuesFingerprint === "string" ? { issuesFingerprint: value.issuesFingerprint } : {}),
    values,
    sources,
    locked: (stringList(value.locked) ?? []).filter((key): key is ManagedPolicySettingKey => SETTING_KEYS.has(key)),
    issues: stringList(value.issues) ?? [],
    ...(typeof value.noticeDismissedFor === "string" ? { noticeDismissedFor: value.noticeDismissedFor } : {}),
    ...(typeof value.seededRegistration === "string" ? { seededRegistration: value.seededRegistration } : {}),
  };
}
