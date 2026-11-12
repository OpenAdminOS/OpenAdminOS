import { createHash } from "node:crypto";

import {
  DEFAULT_GRAPH_READ_SCOPE_NAMES,
  MANAGED_POLICY_SETTING_KEYS,
  grantedParts,
  qualifyScope,
  splashtopConnectionOf,
  splashtopRegion,
  type AgentSummary,
  type ManagedPolicyScope,
  type ManagedPolicySettingKey,
  type ManagedPolicyValues,
  type NovaInstructionRevision,
  type NovaProfile,
  type OrganizationRecord,
  type TenantRecord,
} from "@openadminos/agent-sdk";

/**
 * Configuration changes for the audit log: connections, organizations,
 * provider and model, public references, schedule assignments, the IT
 * policy file and Nova's settings.
 *
 * Events are derived by comparing the state before and after each write,
 * so every flow that changes these settings is recorded, including the
 * organizations that reconciliation creates and removes with a tenant.
 * They are stored apart from run history, so run retention never prunes
 * them. A recorded event holds identifiers, names and scope names, never
 * tokens, secrets or tenant content. The one text an admin writes for a
 * model is recorded in full: Nova's standing instructions, its addenda and
 * its shortcuts, and the instructions in the IT policy file, so an export
 * shows what Nova was told.
 */

/** Newest events kept. Older events are dropped first. */
export const CONFIGURATION_AUDIT_MAX_EVENTS = 10_000;

export const CONFIGURATION_AUDIT_EVENT_TYPES = [
  "microsoft365.connected",
  "microsoft365.disconnected",
  "microsoft365.access-added",
  "microsoft365.access-removed",
  "organization.created",
  "organization.renamed",
  "organization.switched",
  "organization.removed",
  "provider.changed",
  "model.changed",
  "public-reference.installed",
  "public-reference.enabled",
  "public-reference.disabled",
  "public-reference.removed",
  "schedule.assigned",
  "schedule.unassigned",
  "provider.configuration-changed",
  "organizations.migrated",
  "policy.loaded",
  "policy.changed",
  "policy.removed",
  "policy.invalid",
  "splashtop.connected",
  "splashtop.token-rotated",
  "splashtop.disconnected",
  "nova.settings-changed",
  "nova.instructions-changed",
  "nova.instructions-reverted",
  "nova.capabilities-changed",
  "nova.shortcut-saved",
  "nova.shortcut-deleted",
  "nova.memory-paused",
  "nova.memory-resumed",
] as const;

export type ConfigurationAuditEventType = (typeof CONFIGURATION_AUDIT_EVENT_TYPES)[number];

export type ConfigurationAuditDetail = string | number | boolean | string[];

export interface ConfigurationAuditEvent {
  id: string;
  timestamp: string;
  type: ConfigurationAuditEventType;
  organizationId?: string;
  organizationName?: string;
  tenantId?: string;
  details: Record<string, ConfigurationAuditDetail>;
}

/**
 * The IT policy file as last applied, kept in state so a change between
 * launches is recorded once. Problems are stored as their Settings lines.
 */
export interface ManagedPolicyRecord {
  /** Absent when the files set no valid setting. */
  fingerprint?: string;
  /** Absent when the files have no problem. */
  issuesFingerprint?: string;
  values: ManagedPolicyValues;
  sources: Partial<Record<ManagedPolicySettingKey, ManagedPolicyScope>>;
  locked: ManagedPolicySettingKey[];
  issues: string[];
  /** The problems whose one-time notice was dismissed. */
  noticeDismissedFor?: string;
  /** The policy registration last added to the saved registrations, so a removed one is not added again. */
  seededRegistration?: string;
}

/** Problems recorded per event; the count says how many there were. */
export const POLICY_AUDIT_MAX_PROBLEMS = 20;

/** The parts of persisted state that configuration events are derived from. */
export interface ConfigurationAuditSnapshot {
  activeProviderId: string;
  providerChosenByUser?: boolean;
  activeModelByProviderId?: Partial<Record<string, string>>;
  tenants: readonly TenantRecord[];
  activeTenantId?: string;
  organizations?: readonly OrganizationRecord[];
  installedAgents: readonly AgentSummary[];
  mcpServers?: Readonly<Record<string, { enabled: boolean }>>;
  /** Azure OpenAI endpoint settings; the API key is never part of state. */
  providerConfigs?: { azureOpenAI?: { endpoint: string; deployment: string; apiVersion: string } };
  managedPolicy?: ManagedPolicyRecord;
  novaProfile?: NovaProfile;
}

export interface ConfigurationAuditContext {
  timestamp: string;
  newId: () => string;
  /** Catalog name of a public reference, when the catalog has it. */
  publicReferenceName: (serverId: string) => string | undefined;
  /** The Azure OpenAI API key was set or removed with this write; the value is never recorded. */
  azureOpenAIKey?: "set" | "removed";
  /** The IT policy file made this write: provider and model changes say so. */
  policy?: boolean;
}

type EventSeed = Omit<ConfigurationAuditEvent, "id" | "timestamp">;

function organizationOfTenant(
  organizations: readonly OrganizationRecord[],
  tenantId: string | undefined,
): OrganizationRecord | undefined {
  if (!tenantId) return undefined;
  return organizations.find((entry) => entry.connections.microsoft365?.tenantId === tenantId);
}

function organizationFields(organization: OrganizationRecord | undefined): Pick<EventSeed, "organizationId" | "organizationName"> {
  return organization ? { organizationId: organization.id, organizationName: organization.name } : {};
}

/**
 * The scopes the app treats as granted, by the same rule as the runtime:
 * a connection with no recorded grants (made before grants were recorded)
 * has the default read scopes, not none.
 */
function grantedScopeNames(tenant: TenantRecord): Set<string> {
  return new Set(
    tenant.grantedScopes === undefined
      ? DEFAULT_GRAPH_READ_SCOPE_NAMES.map(qualifyScope)
      : tenant.grantedScopes.map(qualifyScope),
  );
}

function grantedPartIds(tenant: TenantRecord): Set<string> {
  return new Set(grantedParts(tenant).map((part) => part.id));
}

function sortedDifference(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((entry) => !right.has(entry)).sort();
}

/**
 * Events for what changed between two states, in the order an admin would
 * read them. Deterministic apart from the ids and timestamp in `context`.
 */
export function diffConfigurationAudit(
  previous: ConfigurationAuditSnapshot,
  next: ConfigurationAuditSnapshot,
  context: ConfigurationAuditContext,
): ConfigurationAuditEvent[] {
  const seeds: EventSeed[] = [];
  const previousOrganizations = previous.organizations ?? [];
  const nextOrganizations = next.organizations ?? [];
  const previousOrganizationById = new Map(previousOrganizations.map((entry) => [entry.id, entry]));
  const nextOrganizationById = new Map(nextOrganizations.map((entry) => [entry.id, entry]));
  const previousTenantById = new Map(previous.tenants.map((entry) => [entry.id, entry]));
  const nextTenantById = new Map(next.tenants.map((entry) => [entry.id, entry]));

  // Organizations created, with the Microsoft 365 connection they hold.
  for (const organization of nextOrganizations) {
    if (previousOrganizationById.has(organization.id)) continue;
    const tenantId = organization.connections.microsoft365?.tenantId;
    seeds.push({
      type: "organization.created",
      ...organizationFields(organization),
      ...(tenantId ? { tenantId } : {}),
      details: {},
    });
  }

  for (const tenant of next.tenants) {
    const before = previousTenantById.get(tenant.id);
    const reconnected = before !== undefined && before.connectionId !== tenant.connectionId;
    const organization = organizationFields(organizationOfTenant(nextOrganizations, tenant.id));
    if (!before || reconnected) {
      seeds.push({
        type: "microsoft365.connected",
        ...organization,
        tenantId: tenant.id,
        details: {
          tenantName: tenant.displayName,
          account: tenant.username,
          registration: tenant.appRegistration?.kind ?? "openadminos",
          reconnected,
          // Counted by the runtime's rule: no recorded grants means the default read scopes.
          grantedScopeCount: grantedScopeNames(tenant).size,
        },
      });
    }
    if (!before) continue;
    const beforeScopes = grantedScopeNames(before);
    const afterScopes = grantedScopeNames(tenant);
    const addedScopes = sortedDifference(afterScopes, beforeScopes);
    const removedScopes = sortedDifference(beforeScopes, afterScopes);
    const beforeParts = grantedPartIds(before);
    const afterParts = grantedPartIds(tenant);
    if (addedScopes.length > 0) {
      seeds.push({
        type: "microsoft365.access-added",
        ...organization,
        tenantId: tenant.id,
        details: { scopes: addedScopes, partIds: sortedDifference(afterParts, beforeParts) },
      });
    }
    if (removedScopes.length > 0) {
      seeds.push({
        type: "microsoft365.access-removed",
        ...organization,
        tenantId: tenant.id,
        details: { scopes: removedScopes, partIds: sortedDifference(beforeParts, afterParts) },
      });
    }
  }

  for (const organization of nextOrganizations) {
    const before = previousOrganizationById.get(organization.id);
    if (!before || before.name === organization.name) continue;
    const tenantId = organization.connections.microsoft365?.tenantId;
    seeds.push({
      type: "organization.renamed",
      ...organizationFields(organization),
      ...(tenantId ? { tenantId } : {}),
      details: { previousName: before.name },
    });
  }

  // Disconnected tenants, then the organizations removed with them.
  for (const tenant of previous.tenants) {
    if (nextTenantById.has(tenant.id)) continue;
    seeds.push({
      type: "microsoft365.disconnected",
      ...organizationFields(organizationOfTenant(previousOrganizations, tenant.id)),
      tenantId: tenant.id,
      details: { tenantName: tenant.displayName },
    });
  }
  for (const organization of previousOrganizations) {
    if (nextOrganizationById.has(organization.id)) continue;
    const tenantId = organization.connections.microsoft365?.tenantId;
    seeds.push({
      type: "organization.removed",
      ...organizationFields(organization),
      ...(tenantId ? { tenantId } : {}),
      details: {},
    });
  }

  // Splashtop connections. The token is never part of state; its rotation
  // shows as a new tokenSetAt on the same connection.
  for (const organization of nextOrganizations) {
    const after = splashtopConnectionOf(organization);
    if (!after) continue;
    const before = splashtopConnectionOf(previousOrganizationById.get(organization.id));
    const tenantId = organization.connections.microsoft365?.tenantId;
    const where = { region: after.region, host: splashtopRegion(after.region).host, teamId: after.teamId };
    if (!before || before.connectedAt !== after.connectedAt) {
      seeds.push({
        type: "splashtop.connected",
        ...organizationFields(organization),
        ...(tenantId ? { tenantId } : {}),
        details: { ...where, ...(after.account ? { account: after.account } : {}), reconnected: before !== undefined },
      });
    } else if (before.tokenSetAt !== after.tokenSetAt) {
      seeds.push({ type: "splashtop.token-rotated", ...organizationFields(organization), ...(tenantId ? { tenantId } : {}), details: where });
    }
  }
  for (const organization of previousOrganizations) {
    const before = splashtopConnectionOf(organization);
    if (!before) continue;
    const next = nextOrganizationById.get(organization.id);
    if (next && splashtopConnectionOf(next)) continue;
    const tenantId = organization.connections.microsoft365?.tenantId;
    seeds.push({
      type: "splashtop.disconnected",
      ...organizationFields(organization),
      ...(tenantId ? { tenantId } : {}),
      details: { region: before.region, host: splashtopRegion(before.region).host, teamId: before.teamId, organizationRemoved: next === undefined },
    });
  }

  // The active organization is the one that holds the active tenant.
  const previousActive = organizationOfTenant(previousOrganizations, previous.activeTenantId);
  const nextActive = organizationOfTenant(nextOrganizations, next.activeTenantId);
  if (previousActive?.id !== nextActive?.id) {
    seeds.push({
      type: "organization.switched",
      ...organizationFields(nextActive),
      ...(nextActive && next.activeTenantId ? { tenantId: next.activeTenantId } : {}),
      details: {
        noOrganization: nextActive === undefined,
        ...(previousActive
          ? { previousOrganizationId: previousActive.id, previousOrganizationName: previousActive.name }
          : { previousNoOrganization: true }),
      },
    });
  }

  if (previous.activeProviderId !== next.activeProviderId) {
    seeds.push({
      type: "provider.changed",
      details: {
        providerId: next.activeProviderId,
        previousProviderId: previous.activeProviderId,
        // False when the host selected a ready local provider by itself.
        chosenByAdmin: next.providerChosenByUser !== false && context.policy !== true,
        ...(context.policy ? { setByPolicy: true } : {}),
      },
    });
  }

  const previousModels = previous.activeModelByProviderId ?? {};
  const nextModels = next.activeModelByProviderId ?? {};
  for (const providerId of [...new Set([...Object.keys(previousModels), ...Object.keys(nextModels)])].sort()) {
    const before = previousModels[providerId];
    const after = nextModels[providerId];
    if (before === after) continue;
    seeds.push({
      type: "model.changed",
      details: {
        providerId,
        // An absent model means the provider's own default.
        model: after ?? "provider default",
        previousModel: before ?? "provider default",
        ...(context.policy ? { setByPolicy: true } : {}),
      },
    });
  }

  const previousServers = previous.mcpServers ?? {};
  const nextServers = next.mcpServers ?? {};
  const referenceDetails = (serverId: string) => {
    const name = context.publicReferenceName(serverId);
    return { serverId, ...(name ? { serverName: name } : {}) };
  };
  for (const serverId of Object.keys(nextServers).sort()) {
    const before = previousServers[serverId];
    const after = nextServers[serverId]!;
    if (!before) {
      seeds.push({ type: "public-reference.installed", details: { ...referenceDetails(serverId), enabled: after.enabled } });
    } else if (before.enabled !== after.enabled) {
      seeds.push({ type: after.enabled ? "public-reference.enabled" : "public-reference.disabled", details: referenceDetails(serverId) });
    }
  }
  for (const serverId of Object.keys(previousServers).sort()) {
    if (!nextServers[serverId]) seeds.push({ type: "public-reference.removed", details: referenceDetails(serverId) });
  }

  // Azure OpenAI endpoint settings, and whether its key was set or removed.
  const beforeAzure = previous.providerConfigs?.azureOpenAI;
  const afterAzure = next.providerConfigs?.azureOpenAI;
  const changedFields = (["endpoint", "deployment", "apiVersion"] as const).filter(
    (field) => (beforeAzure?.[field] ?? "") !== (afterAzure?.[field] ?? ""),
  );
  if (changedFields.length > 0 || context.azureOpenAIKey) {
    seeds.push({
      type: "provider.configuration-changed",
      details: {
        providerId: "azure-openai",
        changed: [...changedFields, ...(context.azureOpenAIKey ? ["apiKey"] : [])],
        ...(afterAzure ? { endpoint: afterAzure.endpoint, deployment: afterAzure.deployment, apiVersion: afterAzure.apiVersion } : {}),
        ...(context.azureOpenAIKey ? { apiKey: context.azureOpenAIKey } : {}),
      },
    });
  }

  seeds.push(...policySeeds(previous.managedPolicy, next.managedPolicy));

  // Schedule assignments. An agent that was uninstalled is not a change of assignment.
  const previousAgents = new Map(previous.installedAgents.map((agent) => [agent.slug || agent.id, agent]));
  for (const agent of next.installedAgents) {
    const before = previousAgents.get(agent.slug || agent.id);
    if (!before) continue;
    const beforeOrganizationId = before.schedule?.organizationId;
    const afterOrganizationId = agent.schedule?.organizationId;
    if (beforeOrganizationId === afterOrganizationId) continue;
    const agentDetails = { agentSlug: agent.slug || agent.id, agentName: agent.name };
    const previousOrganization = beforeOrganizationId
      ? previousOrganizationById.get(beforeOrganizationId) ?? nextOrganizationById.get(beforeOrganizationId)
      : undefined;
    const previousFields = beforeOrganizationId
      ? {
          previousOrganizationId: beforeOrganizationId,
          ...(previousOrganization ? { previousOrganizationName: previousOrganization.name } : {}),
        }
      : {};
    if (afterOrganizationId) {
      const organization = nextOrganizationById.get(afterOrganizationId);
      const tenantId = organization?.connections.microsoft365?.tenantId;
      seeds.push({
        type: "schedule.assigned",
        organizationId: afterOrganizationId,
        ...(organization ? { organizationName: organization.name } : {}),
        ...(tenantId ? { tenantId } : {}),
        details: { ...agentDetails, ...previousFields },
      });
    } else {
      seeds.push({
        type: "schedule.unassigned",
        details: { ...agentDetails, ...previousFields, scheduleRemoved: agent.schedule === undefined },
      });
    }
  }

  seeds.push(...novaSeeds(previous.novaProfile, next.novaProfile, nextOrganizationById));

  return seeds.map((seed) => ({ id: context.newId(), timestamp: context.timestamp, ...seed }));
}

/** What the IT policy file sets, as audit details: ids, names, keys and the Nova instructions it sets. */
function policyDetails(record: ManagedPolicyRecord): Record<string, ConfigurationAuditDetail> {
  const keys = MANAGED_POLICY_SETTING_KEYS.filter((key) => record.values[key] !== undefined);
  const { values } = record;
  return {
    keys: [...keys],
    lockedKeys: keys.filter((key) => record.locked.includes(key)),
    machineKeys: keys.filter((key) => record.sources[key] === "machine"),
    userKeys: keys.filter((key) => record.sources[key] === "user"),
    ...(values.allowedProviders ? { allowedProviders: [...values.allowedProviders] } : {}),
    ...(values.defaultProvider ? { defaultProvider: values.defaultProvider } : {}),
    ...(values.defaultModel ? { defaultModel: values.defaultModel } : {}),
    ...(values.allowedPublicReferences ? { allowedPublicReferences: [...values.allowedPublicReferences] } : {}),
    ...(values.appRegistration ? { appRegistrationClientId: values.appRegistration.clientId } : {}),
    ...(values.skipFirstRunScan !== undefined ? { skipFirstRunScan: values.skipFirstRunScan } : {}),
    ...(values.novaVoiceModes ? { novaVoiceModes: [...values.novaVoiceModes] } : {}),
    ...(values.novaInstructions !== undefined ? { novaInstructions: values.novaInstructions } : {}),
    ...(values.novaCapabilities?.webSearch !== undefined ? { novaWebSearch: values.novaCapabilities.webSearch } : {}),
    ...(values.novaCapabilities?.startAgents !== undefined ? { novaStartAgents: values.novaCapabilities.startAgents } : {}),
    ...(values.novaCapabilities?.navigation !== undefined ? { novaNavigation: values.novaCapabilities.navigation } : {}),
    ...(values.novaCapabilities?.connectorSends !== undefined
      ? { novaConnectorSends: Array.isArray(values.novaCapabilities.connectorSends) ? [...values.novaCapabilities.connectorSends] : values.novaCapabilities.connectorSends }
      : {}),
    ...(values.novaMemory ? { novaMemory: values.novaMemory } : {}),
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The newest revision of one text, added by this write. */
function addedRevision(
  previous: NovaProfile | undefined,
  next: NovaProfile | undefined,
  scope: NovaInstructionRevision["scope"],
  organizationId?: string,
): NovaInstructionRevision | undefined {
  const known = new Set((previous?.revisions ?? []).map((entry) => entry.id));
  const matching = (next?.revisions ?? []).filter(
    (entry) => entry.scope === scope && (scope === "user" || entry.organizationId === organizationId) && !known.has(entry.id),
  );
  return matching.at(-1);
}

function instructionSeed(
  before: string,
  after: string,
  revision: NovaInstructionRevision | undefined,
  scope: NovaInstructionRevision["scope"],
  organization: Pick<EventSeed, "organizationId" | "organizationName">,
): EventSeed {
  const reverted = revision?.via === "revert";
  return {
    type: reverted ? "nova.instructions-reverted" : "nova.instructions-changed",
    ...organization,
    details: {
      scope,
      text: after,
      length: after.length,
      sha256: sha256(after),
      ...(before ? { previousSha256: sha256(before) } : {}),
      via: revision?.via ?? "settings",
      ...(revision ? { revisionId: revision.id } : {}),
    },
  };
}

/** Changes to Nova's settings. The greeting name is recorded as changed, never by value. */
function novaSeeds(
  previous: NovaProfile | undefined,
  next: NovaProfile | undefined,
  organizations: ReadonlyMap<string, OrganizationRecord>,
): EventSeed[] {
  const seeds: EventSeed[] = [];
  const changed: string[] = [];
  const migrated = !previous?.migratedFromLocalStorage && next?.migratedFromLocalStorage === true;
  // How this write was made: on a Nova card, or in Settings.
  const via = migrated ? "migration" : next?.lastChange && next.lastChange.id !== previous?.lastChange?.id ? next.lastChange.via : "settings";
  // An unset voice mode is the default; setting the default changes nothing Nova does.
  if ((previous?.voiceMode ?? "openai") !== (next?.voiceMode ?? "openai")) changed.push("voiceMode");
  if ((previous?.greetingName ?? "") !== (next?.greetingName ?? "")) changed.push("greetingName");
  if (changed.length > 0) {
    seeds.push({
      type: "nova.settings-changed",
      details: { changed, ...(next?.voiceMode ? { voiceMode: next.voiceMode } : {}), via },
    });
  }
  // Unset and empty differ: an unset text leaves an IT default in effect, an empty one clears it.
  if (previous?.instructions !== next?.instructions) {
    seeds.push(instructionSeed(previous?.instructions ?? "", next?.instructions ?? "", addedRevision(previous, next, "user"), "user", {}));
  }
  const organizationIds = new Set([...Object.keys(previous?.addenda ?? {}), ...Object.keys(next?.addenda ?? {})]);
  for (const organizationId of [...organizationIds].sort()) {
    const before = previous?.addenda?.[organizationId] ?? "";
    const after = next?.addenda?.[organizationId] ?? "";
    if (before === after) continue;
    const organization = organizations.get(organizationId);
    seeds.push(
      instructionSeed(before, after, addedRevision(previous, next, "organization", organizationId), "organization", {
        organizationId,
        ...(organization ? { organizationName: organization.name } : {}),
      }),
    );
  }
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const name of ["webSearch", "startAgents", "navigation"] as const) {
    const before = previous?.capabilities?.[name] ?? true;
    const after = next?.capabilities?.[name] ?? true;
    if (before !== after) (after ? enabled : disabled).push(name);
  }
  const connectorIds = new Set([...Object.keys(previous?.connectorSends ?? {}), ...Object.keys(next?.connectorSends ?? {})]);
  for (const connectorId of [...connectorIds].sort()) {
    const before = previous?.connectorSends?.[connectorId] ?? true;
    const after = next?.connectorSends?.[connectorId] ?? true;
    if (before !== after) (after ? enabled : disabled).push(`connectorSends:${connectorId}`);
  }
  if (enabled.length > 0 || disabled.length > 0) seeds.push({ type: "nova.capabilities-changed", details: { enabled, disabled, via } });
  const beforeShortcuts = new Map((previous?.shortcuts ?? []).map((entry) => [entry.id, entry]));
  const afterShortcuts = new Map((next?.shortcuts ?? []).map((entry) => [entry.id, entry]));
  for (const shortcut of next?.shortcuts ?? []) {
    const before = beforeShortcuts.get(shortcut.id);
    if (before && before.name === shortcut.name && before.prompt === shortcut.prompt) continue;
    seeds.push({
      type: "nova.shortcut-saved",
      details: { shortcutId: shortcut.id, name: shortcut.name, prompt: shortcut.prompt, updated: before !== undefined },
    });
  }
  for (const shortcut of previous?.shortcuts ?? []) {
    if (!afterShortcuts.has(shortcut.id)) seeds.push({ type: "nova.shortcut-deleted", details: { shortcutId: shortcut.id, name: shortcut.name } });
  }
  if ((previous?.memoryPaused ?? false) !== (next?.memoryPaused ?? false)) {
    seeds.push({ type: next?.memoryPaused ? "nova.memory-paused" : "nova.memory-resumed", details: {} });
  }
  return seeds;
}

function policySeeds(previous: ManagedPolicyRecord | undefined, next: ManagedPolicyRecord | undefined): EventSeed[] {
  const seeds: EventSeed[] = [];
  const before = previous?.fingerprint;
  const after = next?.fingerprint;
  if (!before && after && next) {
    seeds.push({ type: "policy.loaded", details: policyDetails(next) });
  } else if (before && after && before !== after && previous && next) {
    const changedKeys = MANAGED_POLICY_SETTING_KEYS.filter(
      (key) =>
        JSON.stringify(previous.values[key]) !== JSON.stringify(next.values[key]) ||
        previous.sources[key] !== next.sources[key] ||
        previous.locked.includes(key) !== next.locked.includes(key),
    );
    seeds.push({ type: "policy.changed", details: { ...policyDetails(next), changedKeys } });
  } else if (before && !after && previous) {
    seeds.push({ type: "policy.removed", details: { previousKeys: policyDetails(previous).keys as string[] } });
  }
  if (next?.issuesFingerprint && next.issuesFingerprint !== previous?.issuesFingerprint) {
    seeds.push({
      type: "policy.invalid",
      details: { problemCount: next.issues.length, problems: next.issues.slice(0, POLICY_AUDIT_MAX_PROBLEMS) },
    });
  }
  return seeds;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const EVENT_TYPES: ReadonlySet<string> = new Set(CONFIGURATION_AUDIT_EVENT_TYPES);

const POLICY_DETAIL_KEYS = [
  "keys",
  "lockedKeys",
  "machineKeys",
  "userKeys",
  "allowedProviders",
  "defaultProvider",
  "defaultModel",
  "allowedPublicReferences",
  "appRegistrationClientId",
  "skipFirstRunScan",
  "novaVoiceModes",
  "novaInstructions",
  "novaWebSearch",
  "novaStartAgents",
  "novaNavigation",
  "novaConnectorSends",
  "novaMemory",
] as const;

const NOVA_INSTRUCTION_DETAIL_KEYS = ["scope", "text", "length", "sha256", "previousSha256", "via", "revisionId"] as const;

/**
 * The detail fields each event type may carry. A stored field outside its
 * type's list is dropped, so a hand-edited or newer file cannot smuggle
 * other data into the export.
 */
const DETAIL_KEYS: Readonly<Record<ConfigurationAuditEventType, readonly string[]>> = {
  // sampleData stays readable on events recorded before pilot mode was removed.
  "microsoft365.connected": ["tenantName", "account", "registration", "reconnected", "grantedScopeCount", "sampleData"],
  "microsoft365.disconnected": ["tenantName", "sampleData"],
  "microsoft365.access-added": ["scopes", "partIds", "sampleData"],
  "microsoft365.access-removed": ["scopes", "partIds", "sampleData"],
  "organization.created": ["sampleData"],
  "organization.renamed": ["previousName", "sampleData"],
  "organization.switched": ["noOrganization", "previousOrganizationId", "previousOrganizationName", "previousNoOrganization", "sampleData"],
  "organization.removed": ["sampleData"],
  "provider.changed": ["providerId", "previousProviderId", "chosenByAdmin", "setByPolicy"],
  "model.changed": ["providerId", "model", "previousModel", "setByPolicy"],
  "public-reference.installed": ["serverId", "serverName", "enabled"],
  "public-reference.enabled": ["serverId", "serverName"],
  "public-reference.disabled": ["serverId", "serverName"],
  "public-reference.removed": ["serverId", "serverName"],
  "schedule.assigned": ["agentSlug", "agentName", "previousOrganizationId", "previousOrganizationName"],
  "schedule.unassigned": ["agentSlug", "agentName", "previousOrganizationId", "previousOrganizationName", "scheduleRemoved"],
  "provider.configuration-changed": ["providerId", "changed", "endpoint", "deployment", "apiVersion", "apiKey"],
  "organizations.migrated": ["organizationIds", "organizationNames", "schedulesAssigned", "schedulesUnassigned", "assignedOrganizationId"],
  "policy.loaded": [...POLICY_DETAIL_KEYS],
  "policy.changed": [...POLICY_DETAIL_KEYS, "changedKeys"],
  "policy.removed": ["previousKeys"],
  "policy.invalid": ["problemCount", "problems"],
  "splashtop.connected": ["region", "host", "teamId", "account", "reconnected"],
  "splashtop.token-rotated": ["region", "host", "teamId"],
  "splashtop.disconnected": ["region", "host", "teamId", "organizationRemoved"],
  "nova.settings-changed": ["changed", "voiceMode", "via"],
  "nova.instructions-changed": [...NOVA_INSTRUCTION_DETAIL_KEYS],
  "nova.instructions-reverted": [...NOVA_INSTRUCTION_DETAIL_KEYS],
  "nova.capabilities-changed": ["enabled", "disabled", "via"],
  "nova.shortcut-saved": ["shortcutId", "name", "prompt", "updated"],
  "nova.shortcut-deleted": ["shortcutId", "name"],
  "nova.memory-paused": [],
  "nova.memory-resumed": [],
};

/** Keeps the allowed detail fields of a recorded shape; a field of another shape is left out, not the event. */
function sanitizeDetails(type: ConfigurationAuditEventType, value: unknown): Record<string, ConfigurationAuditDetail> {
  const allowed = new Set(DETAIL_KEYS[type]);
  const details: Record<string, ConfigurationAuditDetail> = {};
  for (const [key, entry] of Object.entries(isRecord(value) ? value : {})) {
    if (!allowed.has(key)) continue;
    if (typeof entry === "string" || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) {
      details[key] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      details[key] = [...entry];
    }
  }
  return details;
}

/** Well-formed stored events, newest kept; undefined when there are none. */
export function sanitizeConfigurationAudit(value: unknown): ConfigurationAuditEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: ConfigurationAuditEvent[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (typeof raw.id !== "string" || raw.id.length === 0) continue;
    if (typeof raw.timestamp !== "string" || !Number.isFinite(Date.parse(raw.timestamp))) continue;
    if (typeof raw.type !== "string" || !EVENT_TYPES.has(raw.type)) continue;
    const details = sanitizeDetails(raw.type as ConfigurationAuditEventType, raw.details);
    events.push({
      id: raw.id,
      timestamp: raw.timestamp,
      type: raw.type as ConfigurationAuditEventType,
      ...(typeof raw.organizationId === "string" ? { organizationId: raw.organizationId } : {}),
      ...(typeof raw.organizationName === "string" ? { organizationName: raw.organizationName } : {}),
      ...(typeof raw.tenantId === "string" ? { tenantId: raw.tenantId } : {}),
      details,
    });
  }
  const kept = events.slice(-CONFIGURATION_AUDIT_MAX_EVENTS);
  return kept.length > 0 ? kept : undefined;
}

/** Appends new events and keeps the newest `CONFIGURATION_AUDIT_MAX_EVENTS`. */
export function appendConfigurationAudit(
  existing: readonly ConfigurationAuditEvent[] | undefined,
  recorded: readonly ConfigurationAuditEvent[],
): ConfigurationAuditEvent[] | undefined {
  const combined = [...(existing ?? []), ...recorded].slice(-CONFIGURATION_AUDIT_MAX_EVENTS);
  return combined.length > 0 ? combined : undefined;
}
