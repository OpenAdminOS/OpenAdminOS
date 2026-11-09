import type { ProviderId } from "./index.js";

/**
 * Managed configuration: a local policy file an IT department deploys
 * (with Intune, Jamf or any file deployment) to set and lock choices on
 * one device. Reading it is part of the free app. The host reads the file
 * at launch and enforces it in the main process; the renderer only shows
 * what is set and by whom.
 */

/** The policy file format this app reads. */
export const MANAGED_POLICY_VERSION = 1;

/** Every key a policy file may hold. Anything else is reported. */
export const MANAGED_POLICY_KEYS = [
  "$schema",
  "version",
  "allowedProviders",
  "defaultProvider",
  "defaultModel",
  "allowedPublicReferences",
  "appRegistration",
  "skipFirstRunScan",
  "lock",
] as const;

export type ManagedPolicyKey = (typeof MANAGED_POLICY_KEYS)[number];

/** The keys that carry a setting, as opposed to file metadata and `lock`. */
export const MANAGED_POLICY_SETTING_KEYS = [
  "allowedProviders",
  "defaultProvider",
  "defaultModel",
  "allowedPublicReferences",
  "appRegistration",
  "skipFirstRunScan",
] as const;

export type ManagedPolicySettingKey = (typeof MANAGED_POLICY_SETTING_KEYS)[number];

/** Which file supplied a value. The machine file wins over the user file, key by key. */
export type ManagedPolicyScope = "machine" | "user";

export interface ManagedPolicyAppRegistration {
  clientId: string;
  /** Directory (tenant) id or verified domain, for a single-tenant app. */
  tenantId?: string;
  label?: string;
}

/** The values in force after both files were read, validated and merged. */
export interface ManagedPolicyValues {
  allowedProviders?: ProviderId[];
  defaultProvider?: ProviderId;
  defaultModel?: string;
  allowedPublicReferences?: string[];
  appRegistration?: ManagedPolicyAppRegistration;
  skipFirstRunScan?: boolean;
}

/** One problem in a policy file. An invalid key is not applied; the rest of the file is. */
export interface ManagedPolicyIssue {
  scope: ManagedPolicyScope;
  /** Full path of the file. */
  path: string;
  /** 1-based line and column, when the problem has a place in the file. */
  line?: number;
  column?: number;
  /** The top-level key the problem belongs to. */
  key?: string;
  message: string;
}

export interface ManagedPolicyFileStatus {
  scope: ManagedPolicyScope;
  path: string;
  /** False when no file exists at this path. */
  found: boolean;
}

export interface ManagedPolicyStatus {
  /** Both paths checked, machine first. */
  files: ManagedPolicyFileStatus[];
  values: ManagedPolicyValues;
  /** The file each value in `values` came from. */
  sources: Partial<Record<ManagedPolicySettingKey, ManagedPolicyScope>>;
  /** Setting keys the admin cannot change in the app. */
  locked: ManagedPolicySettingKey[];
  issues: ManagedPolicyIssue[];
  /** The one-time notice about `issues` was dismissed for these exact problems. */
  noticeDismissed?: boolean;
}

/** Shown wherever a setting is controlled by policy. */
export const MANAGED_POLICY_SET_BY = "Set by your IT department";

export function isManagedSettingLocked(
  status: ManagedPolicyStatus | undefined,
  key: ManagedPolicySettingKey,
): boolean {
  return status !== undefined && status.values[key] !== undefined && status.locked.includes(key);
}

/**
 * The providers this device may use. A locked default provider is the
 * only one; otherwise the allowed list, or every provider without one.
 */
export function managedProviderAllowed(status: ManagedPolicyStatus | undefined, providerId: ProviderId): boolean {
  if (!status) return true;
  const { defaultProvider, allowedProviders } = status.values;
  if (defaultProvider && isManagedSettingLocked(status, "defaultProvider")) return providerId === defaultProvider;
  return allowedProviders === undefined || allowedProviders.includes(providerId);
}

/** Whether a public reference (MCP server) may be installed and used. An empty list allows none. */
export function managedPublicReferenceAllowed(status: ManagedPolicyStatus | undefined, serverId: string): boolean {
  const allowed = status?.values.allowedPublicReferences;
  return allowed === undefined || allowed.includes(serverId);
}

/** The model the admin cannot change for this provider, when one is locked. */
export function managedLockedModel(status: ManagedPolicyStatus | undefined, providerId: ProviderId): string | undefined {
  if (!status || !isManagedSettingLocked(status, "defaultModel")) return undefined;
  return status.values.defaultProvider === providerId ? status.values.defaultModel : undefined;
}
