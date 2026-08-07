import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acquireTokenSilent,
  compareSemver,
  createGraphAdapter,
  createClaudeCodeLlm,
  createAzureOpenAiLlm,
  createCodexLlm,
  createAppleFoundationLlm,
  createLmStudioLlm,
  createMsalClient,
  createOllamaLlm,
  createRegistryInstallCountPayload,
  createTenantSession,
  DEFAULT_SCOPE_METADATA,
  probeSubscribedSkus,
  findConnectorFactory,
  findRegistryAgentById,
  listAllRegistryAgents,
  listRegisteredConnectors,
  loadAgentManifestPreview,
  noSecrets,
  noopLlm,
  parseAgentTemplate,
  probeAzureOpenAi,
  removeAccount,
  runInteractiveFlow,
  setAgentUpdatesDir,
  toInstalledAgent,
  type TokenCacheStorage,
} from "@openadminos/runtime";
import type {
  AgentDraft,
  AgentCommunitySubmissionMetadata,
  AgentCommunitySubmissionReview,
  AgentCommunitySubmissionResult,
  AgentDraftPreflightResult,
  AuditLogExportResult,
  ConnectorAuditEntry,
  ExportAgentBundleResult,
  ExportAuditLogInput,
  AgentManifestPreview,
  AgentUpdateReview,
  ChatInvestigationMode,
  ChatInvestigationSettings,
  ConnectorSummary,
  DriftHistoryPruneResult,
  DriftPruneTrigger,
  DriftRetentionSettings,
  RequestedScope,
  RunGraphApi,
  RunLlmApi,
  RunLogLevel,
  RunHistoryPruneResult,
  RunHistoryPruneTrigger,
  RunHistoryRetentionSettings,
  ProviderTestResult,
  StartRunOptions,
  TenantRecord,
  TenantSession,
  AzureOpenAIProviderConfig,
  GraphCacheRefreshResult,
  GraphCacheRefreshScheduleSettings,
  GraphCacheStatus,
  DriftEntryDetail,
  DriftEntryDetailInput,
  DriftObjectHistoryInput,
  DriftObjectHistoryResult,
  DriftStatus,
  DriftTimelineInput,
  DriftTimelineResult,
  ImportMultiTenantResultToWorkspacesInput,
  ImportMultiTenantResultToWorkspacesResult,
  CreateWorkspaceInput,
  IntuneChatConversation,
  IntuneChatMessage,
  IntuneChatStreamEvent,
  LocalDataSummary,
  MultiTenantAgentBatch,
  MultiTenantChatJob,
  MultiTenantChatRunResult,
  MultiTenantChatStreamEvent,
  PinWorkspaceEvidenceInput,
  PreflightMultiTenantChatInput,
  QueueMultiTenantAgentBatchInput,
  QueueMultiTenantAgentBatchResult,
  RefreshGraphCacheOptions,
  ResetSelfTrainingInput,
  RunMultiTenantChatInput,
  SavedMultiTenantQuery,
  SetAzureOpenAIProviderConfigInput,
  SetDriftRetentionSettingsInput,
  SetGraphCacheRefreshScheduleInput,
  SetRunHistoryRetentionSettingsInput,
  SelfTrainingSettings,
  SelfTrainingSuggestion,
  SelfTrainingSuggestionStatus,
  SendIntuneChatMessageInput,
  SendIntuneChatMessageResult,
  SecretAccessor,
  TenantGroup,
  TenantScopePreflight,
  UpdateWorkspaceInput,
  WorkspaceDetail,
  WorkspaceEvidence,
  WorkspaceLink,
  WorkspaceNote,
  WorkspaceSummary,
} from "@openadminos/agent-sdk";
import {
  deriveTrustState,
  DEFAULT_AZURE_OPENAI_API_VERSION,
  DEFAULT_DRIFT_RETENTION_SETTINGS,
  DEFAULT_RUN_HISTORY_RETENTION_SETTINGS,
  providerCatalog,
  resolveProviderDefaultModel,
  type AgentDiscordDelivery,
  type AgentOutlookDelivery,
  type AgentSchedule,
  type AgentSignalDelivery,
  type AgentSlackDelivery,
  type AgentSummary,
  type AgentTeamsDelivery,
  type AgentWhatsAppWebDelivery,
  type AppState,
  type ProviderId,
  type ProviderSummary,
  type RegistryAgentSummary,
  type RunRecord,
  type WhatsAppWebGroupRef,
  type WhatsAppWebSendResult,
  type WhatsAppWebStatus,
} from "@openadminos/agent-sdk";
import type { PublicClientApplication } from "@azure/msal-node";
import {
  WHATSAPP_WEB_CONNECTOR_ID,
  getWhatsAppWebClient,
  type WhatsAppWebClient,
} from "@openadminos/connector-whatsapp-web";

import { SafeStorageTokenCacheStore } from "./secret-store.js";
import { SafeStorageConnectorSecretStore } from "./connector-secret-store.js";
import { SafeStorageProviderSecretStore } from "./provider-secret-store.js";
import { searchEndpoints } from "./graph-catalog.js";

import {
  DEFAULT_REGISTRY_SOURCE,
  refreshRegistry,
  validateRegistrySource,
} from "./registry-client.js";
import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import { IntuneChatService } from "./intune-chat/service.js";
import { definitionForResource } from "./intune-chat/planner.js";
import { DriftService } from "./intune-chat/drift/service.js";
import { RunService } from "./runs.js";
import { RunDeliveryService } from "./run-delivery.js";
import {
  OUTLOOK_CONNECTOR_ID,
  SLACK_CONNECTOR_ID,
  DISCORD_CONNECTOR_ID,
  SIGNAL_CONNECTOR_ID,
  whatsappWebStatusToConnectorStatus,
  type RunDeliveryQueueItem,
} from "./run-delivery-format.js";
import {
  assertAgentCompatible,
  assertValidAgentSlug,
  buildAgentBundleMetadata,
  buildAgentCommunitySubmissionReview,
  buildAgentProvenance,
  buildAgentReadme,
  buildAgentUpdateReview,
  buildNl2AgentRepairPrompt,
  buildNl2AgentSystemPrompt,
  collectManifestScopes,
  preflightConnectorRequirements,
  promptLooksWritey,
  safeUserAgentDirectory,
  sanitizeSettingsAgainstSchema,
  sha256,
  stripCodeFences,
  validateAgentDraftSource,
  withAgentCompatibility,
} from "./agent-draft-helpers.js";
import {
  checkAppleFoundation,
  checkAzureOpenAI,
  checkClaudeCode,
  checkCodex,
  checkLmStudio,
  checkOllama,
  isProviderId,
} from "./provider-detail.js";
import {
  DEFAULT_STATS_API_URL,
  createLocalOnlyTenantSession,
  entryToRegistrySummary,
  humanizeMsalError,
  humanizeScheduledRunError,
  isNodeError,
  normalizeWorkspaceInstructions,
  normalizeWorkspaceTitle,
  tenantNamesById,
} from "./state-helpers.js";
export { __agentDraftTestUtils } from "./agent-draft-helpers.js";


interface PersistedState {
  activeProviderId: ProviderId;
  /**
   * User-picked model override per provider. When the provider exposes
   * multiple installed models, the user can pick which one is "active"
   * for that provider. Absent → fall back to the provider's first
   * reported model. Stamped onto each new run at queue time.
   */
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
  installedAgents: AgentSummary[];
  runs: RunRecord[];
  tenants: TenantRecord[];
  activeTenantId?: string;
  /**
   * Stable per-installation UUID, generated on first agent install and
   * persisted thereafter. Sent to the stats aggregator alongside each
   * install event so the same machine never counts twice for the same
   * agent. Carries no PII — it's a random v4 UUID, not derived from
   * any hardware identifier.
   */
  installId?: string;
  /**
   * Whether packaged builds report aggregate public registry install counts.
   * Defaults to true; users can disable it from Settings -> Privacy.
   */
  registryInstallCountsEnabled?: boolean;
  /**
   * Enables experimental MXC-backed code execution for preview script
   * agents. Undefined means "no saved preference yet" so the host may
   * honor a launch-time developer env override.
   */
  sandboxedCodeEnabled?: boolean;
  /**
   * Per-connector persisted state. Keyed by connector id. Stores the
   * user-supplied config (validated against the connector's
   * `configSchema`) plus the last health-check outcome so the
   * Connectors page can render status without re-testing on every load.
   */
  connectors?: Record<
    string,
    {
      config: Record<string, unknown>;
      status?: ConnectorSummary["status"];
      lastTestedAt?: string;
      lastTestMessage?: string;
    }
  >;
  /**
   * Per-provider persisted configuration. Secret values are never stored here;
   * Azure OpenAI's API key lives in provider safeStorage under userData.
   */
  providerConfigs?: {
    azureOpenAI?: {
      endpoint: string;
      deployment: string;
      apiVersion: string;
    };
  };
  /**
   * Durable, local queue for post-run connector delivery. Items are
   * enqueued when a run first reaches a terminal state and retried on
   * app startup / scheduler ticks if the previous process exited or a
   * transient connector failure occurred.
   */
  runDeliveryQueue?: RunDeliveryQueueItem[];
  /**
   * Local run-history retention. Defaults are intentionally generous:
   * keep the newest 500 runs and anything queued in the last 180 days.
   */
  runHistoryRetention?: RunHistoryRetentionSettings;
  /**
   * Last persisted prune result. Scheduler/startup only write this when
   * records were actually deleted; manual "Prune now" writes even when
   * the result is zero so the admin gets an honest result.
   */
  lastRunHistoryPrune?: RunHistoryPruneResult;
  /**
   * Local tenant drift retention. Defaults to 180 days; current object
   * versions are preserved by the SQLite drift pruner.
   */
  driftRetentionDays?: DriftRetentionSettings;
  /**
   * Last persisted drift prune result. Follows the same startup/scheduler
   * vs. manual persistence rule as run-history pruning.
   */
  lastDriftHistoryPrune?: DriftHistoryPruneResult;
  /** User-overridable registry source URL. */
  registrySource?: string;
}

type WhatsAppWebClientLike = Pick<
  WhatsAppWebClient,
  | "getStatus"
  | "restoreSession"
  | "startLogin"
  | "disconnect"
  | "listGroups"
  | "sendMessage"
  | "dispose"
>;

const defaultState: PersistedState = {
  activeProviderId: "ollama",
  installedAgents: [],
  runs: [],
  tenants: [],
};

function sanitizeRunHistoryRetentionInteger(
  value: unknown,
  min: number,
  max: number,
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    return undefined;
  }
  return Math.round(value);
}

function nullableRetentionInteger(
  value: number | null | undefined,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return Math.round(value);
}

function sanitizeDriftRetentionDays(value: unknown): number | undefined {
  return sanitizeRunHistoryRetentionInteger(value, 30, 730);
}

function nullableDriftRetentionDays(
  value: number | null | undefined,
): number | undefined {
  return nullableRetentionInteger(value, "Change history retention", 30, 730);
}

function isStateRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeNonNegativeInteger(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    return undefined;
  }
  return Math.round(value);
}

function scheduleFallbackAnchor(installedAt: string, nowMs: number): number {
  const installedMs = Date.parse(installedAt);
  return Number.isFinite(installedMs) ? installedMs : nowMs;
}

function runHistorySortMs(run: RunRecord): number {
  const parsed = Date.parse(run.queuedAt || run.startedAt || run.finishedAt || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function runHistoryPruneReason(
  count: number,
  policy: RunHistoryRetentionSettings,
): string {
  const noun = count === 1 ? "run" : "runs";
  if (policy.keepLastRuns !== undefined && policy.keepDays !== undefined) {
    return `Pruned ${count.toLocaleString()} ${noun} outside the newest ${policy.keepLastRuns.toLocaleString()} runs and older than ${policy.keepDays.toLocaleString()} days.`;
  }
  if (policy.keepLastRuns !== undefined) {
    return `Pruned ${count.toLocaleString()} ${noun} beyond the newest ${policy.keepLastRuns.toLocaleString()} runs.`;
  }
  if (policy.keepDays !== undefined) {
    return `Pruned ${count.toLocaleString()} ${noun} older than ${policy.keepDays.toLocaleString()} days.`;
  }
  return `Pruned ${count.toLocaleString()} ${noun}.`;
}

function driftPruneReason(
  result: { snapshotsDeleted: number; versionsDeleted: number },
  policy: DriftRetentionSettings,
): string {
  const snapshots =
    result.snapshotsDeleted === 1 ? "1 snapshot" : `${result.snapshotsDeleted.toLocaleString()} snapshots`;
  const versions =
    result.versionsDeleted === 1 ? "1 object version" : `${result.versionsDeleted.toLocaleString()} object versions`;
  const days = policy.keepDays ?? DEFAULT_DRIFT_RETENTION_SETTINGS.keepDays ?? 180;
  return `Pruned ${snapshots} and ${versions} older than ${days.toLocaleString()} days. Current object state was kept.`;
}

const AUDIT_LOG_SCHEMA_VERSION = 1;
const AUDIT_CHAIN_START_HASH = "0".repeat(64);

type AuditLogEventSource =
  | "run-history"
  | "connector-audit"
  | "hosted-provider-consent";

interface AuditLogActor {
  kind: "connected-admin" | "local-admin";
  tenantId?: string;
  tenantName?: string;
  username?: string;
  homeAccountId?: string;
}

interface AuditLogEventSeed {
  id: string;
  timestamp: string;
  type: string;
  source: AuditLogEventSource;
  runId?: string;
  tenantId?: string;
  agentSlug?: string;
  actor?: AuditLogActor;
  details: Record<string, unknown>;
}

type AuditLogEvent = AuditLogEventSeed & { sha256: string };

interface AuditLogBuildInput {
  runs: RunRecord[];
  tenants: TenantRecord[];
  installedAgents: AgentSummary[];
  hostedProviderConsentEvents: Array<{
    id: string;
    tenantId: string;
    source: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

function buildAuditLogEvents(input: AuditLogBuildInput): AuditLogEventSeed[] {
  const tenantById = new Map(input.tenants.map((tenant) => [tenant.id, tenant]));
  const agentBySlug = new Map(
    input.installedAgents.map((agent) => [agent.slug || agent.id, agent]),
  );
  const events: AuditLogEventSeed[] = [];

  for (const run of input.runs) {
    const tenant = run.tenantId ? tenantById.get(run.tenantId) : undefined;
    const agent = agentBySlug.get(run.agentSlug);
    const runDetails = runAuditDetails(run, agent, tenant);
    events.push({
      id: `run:${run.id}:queued`,
      timestamp: run.queuedAt,
      type: "run.queued",
      source: "run-history",
      runId: run.id,
      ...(run.tenantId ? { tenantId: run.tenantId } : {}),
      agentSlug: run.agentSlug,
      details: runDetails,
    });
    if (run.startedAt) {
      events.push({
        id: `run:${run.id}:started`,
        timestamp: run.startedAt,
        type: "run.started",
        source: "run-history",
        runId: run.id,
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
        agentSlug: run.agentSlug,
        details: runDetails,
      });
    }
    const confirmationRequestedAt = findConfirmationRequestedAt(run);
    if (run.plan && run.plan.actions.length > 0 && confirmationRequestedAt) {
      events.push({
        id: `run:${run.id}:write-confirmation-requested`,
        timestamp: confirmationRequestedAt,
        type: "write.confirmation.requested",
        source: "run-history",
        runId: run.id,
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
        agentSlug: run.agentSlug,
        details: writeConfirmationDetails(run, "requested"),
      });
    }
    if (run.confirmedAt) {
      events.push({
        id: `run:${run.id}:write-confirmation-accepted`,
        timestamp: run.confirmedAt,
        type: "write.confirmation.accepted",
        source: "run-history",
        runId: run.id,
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
        agentSlug: run.agentSlug,
        actor: actorForRun(run, tenant),
        details: writeConfirmationDetails(run, "accepted"),
      });
    }
    if (run.rejectedAt) {
      events.push({
        id: `run:${run.id}:write-confirmation-rejected`,
        timestamp: run.rejectedAt,
        type: "write.confirmation.rejected",
        source: "run-history",
        runId: run.id,
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
        agentSlug: run.agentSlug,
        actor: actorForRun(run, tenant),
        details: writeConfirmationDetails(run, "rejected"),
      });
    }
    if (run.finishedAt) {
      events.push({
        id: `run:${run.id}:finished`,
        timestamp: run.finishedAt,
        type: `run.${run.status}`,
        source: "run-history",
        runId: run.id,
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
        agentSlug: run.agentSlug,
        details: {
          ...runDetails,
          status: run.status,
          durationMs: runDurationMs(run),
          ...(run.error ? { error: run.error } : {}),
          resultPresent: run.result !== undefined,
          ...(run.result !== undefined
            ? { resultDigest: digestUnknown(run.result) }
            : {}),
        },
      });
    }
    for (const log of run.logs) {
      const connectorAudit = readConnectorAuditEntry(log.metadata?.connectorAudit);
      if (!connectorAudit) continue;
      events.push({
        id: `connector:${run.id}:${log.id}`,
        timestamp: log.timestamp,
        type: "connector.delivery",
        source: "connector-audit",
        runId: run.id,
        ...(run.tenantId ? { tenantId: run.tenantId } : {}),
        agentSlug: run.agentSlug,
        details: {
          logId: log.id,
          logLevel: log.level,
          logMessage: log.message,
          ...connectorAudit,
        },
      });
    }
  }

  for (const consent of input.hostedProviderConsentEvents) {
    events.push({
      id: `hosted-provider-consent:${consent.id}`,
      timestamp: consent.createdAt,
      type: "hosted-provider.consent",
      source: "hosted-provider-consent",
      tenantId: consent.tenantId,
      actor: actorForTenant(tenantById.get(consent.tenantId)),
      details: {
        source: consent.source,
        ...consent.payload,
      },
    });
  }

  return events.sort(compareAuditEvents);
}

function runAuditDetails(
  run: RunRecord,
  agent: AgentSummary | undefined,
  tenant: TenantRecord | undefined,
): Record<string, unknown> {
  return {
    statusAtExport: run.status,
    agentSlug: run.agentSlug,
    ...(agent?.name ? { agentName: agent.name } : {}),
    ...(agent?.mode ? { agentMode: agent.mode } : {}),
    ...(run.tenantId ? { tenantId: run.tenantId } : {}),
    ...(tenant?.displayName ? { tenantName: tenant.displayName } : {}),
    ...(run.providerId ? { providerId: run.providerId } : {}),
    ...(run.model ? { model: run.model } : {}),
    ...(run.trigger ? { trigger: run.trigger } : {}),
    ...(run.changeState ? { changeState: run.changeState } : {}),
    stepCount: run.steps.length,
    logCount: run.logs.length,
    resultPresent: run.result !== undefined,
    errorPresent: run.error !== undefined,
    ...(run.summary ? { summaryDigest: digestText(run.summary) } : {}),
    ...(run.tokens ? { tokens: run.tokens } : {}),
  };
}

function writeConfirmationDetails(
  run: RunRecord,
  outcome: "requested" | "accepted" | "rejected",
): Record<string, unknown> {
  const actions = run.plan?.actions ?? [];
  return {
    outcome,
    actionCount: actions.length,
    actionKinds: [...new Set(actions.map((action) => action.kind))].sort(),
    severityCounts: actions.reduce<Record<string, number>>((counts, action) => {
      const severity = action.severity ?? "unknown";
      counts[severity] = (counts[severity] ?? 0) + 1;
      return counts;
    }, {}),
    expectedPhraseStoredInRunPlan: typeof run.plan?.confirmationPhrase === "string",
    expectedPhraseExported: false,
    typedPhraseContentStored: false,
    typedPhraseContentExported: false,
  };
}

function findConfirmationRequestedAt(run: RunRecord): string | undefined {
  const log = run.logs.find((entry) =>
    /awaiting typed confirmation/i.test(entry.message),
  );
  return log?.timestamp ?? run.startedAt ?? run.queuedAt;
}

function actorForRun(
  run: RunRecord,
  tenant: TenantRecord | undefined,
): AuditLogActor {
  return actorForTenant(tenant, run.tenantId);
}

function actorForTenant(
  tenant: TenantRecord | undefined,
  fallbackTenantId?: string,
): AuditLogActor {
  if (!tenant) {
    return {
      kind: "local-admin",
      ...(fallbackTenantId ? { tenantId: fallbackTenantId } : {}),
    };
  }
  return {
    kind: "connected-admin",
    tenantId: tenant.id,
    tenantName: tenant.displayName,
    username: tenant.username,
    homeAccountId: tenant.homeAccountId,
  };
}

function runDurationMs(run: RunRecord): number | undefined {
  if (!run.startedAt || !run.finishedAt) return undefined;
  const started = Date.parse(run.startedAt);
  const finished = Date.parse(run.finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return undefined;
  return Math.max(0, finished - started);
}

function readConnectorAuditEntry(value: unknown): ConnectorAuditEntry | undefined {
  if (!isStateRecord(value)) return undefined;
  const requiredStrings = [
    "runId",
    "stepId",
    "connector",
    "capability",
    "kind",
    "idempotencyKey",
    "egressTarget",
    "argsDigest",
    "status",
  ];
  if (requiredStrings.some((key) => typeof value[key] !== "string")) {
    return undefined;
  }
  if (typeof value.durationMs !== "number" || !Number.isFinite(value.durationMs)) {
    return undefined;
  }
  return {
    runId: value.runId as string,
    stepId: value.stepId as string,
    connector: value.connector as string,
    capability: value.capability as string,
    kind: value.kind as ConnectorAuditEntry["kind"],
    idempotencyKey: value.idempotencyKey as string,
    egressTarget: value.egressTarget as string,
    argsDigest: value.argsDigest as string,
    status: value.status as ConnectorAuditEntry["status"],
    durationMs: Math.max(0, Math.round(value.durationMs)),
    ...(typeof value.externalId === "string" ? { externalId: value.externalId } : {}),
    ...(typeof value.externalUrl === "string" ? { externalUrl: value.externalUrl } : {}),
    ...(typeof value.errorClass === "string" ? { errorClass: value.errorClass } : {}),
    ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}),
  };
}

function compareAuditEvents(left: AuditLogEventSeed, right: AuditLogEventSeed): number {
  const leftMs = Date.parse(left.timestamp);
  const rightMs = Date.parse(right.timestamp);
  const timeDiff =
    (Number.isFinite(leftMs) ? leftMs : 0) -
    (Number.isFinite(rightMs) ? rightMs : 0);
  if (timeDiff !== 0) return timeDiff;
  const sourceOrder: Record<AuditLogEventSource, number> = {
    "run-history": 0,
    "connector-audit": 1,
    "hosted-provider-consent": 2,
  };
  const sourceDiff = sourceOrder[left.source] - sourceOrder[right.source];
  if (sourceDiff !== 0) return sourceDiff;
  return left.id.localeCompare(right.id);
}

function applyAuditHashChain(events: AuditLogEventSeed[]): {
  events: AuditLogEvent[];
  finalHash: string;
} {
  let previousHash = AUDIT_CHAIN_START_HASH;
  const hashed = events.map((event) => {
    const sha256 = createHash("sha256")
      .update(previousHash)
      .update(canonicalJson(event))
      .digest("hex");
    previousHash = sha256;
    return { ...event, sha256 };
  });
  return { events: hashed, finalHash: previousHash };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestUnknown(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function auditEventWithinRange(
  event: AuditLogEventSeed,
  fromMs: number | undefined,
  toMs: number | undefined,
): boolean {
  const timestampMs = Date.parse(event.timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (fromMs !== undefined && timestampMs < fromMs) return false;
  if (toMs !== undefined && timestampMs > toMs) return false;
  return true;
}

function parseAuditExportBoundary(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return timestamp;
}

function auditLogSuggestedName(format: ExportAuditLogInput["format"], generatedAt: string): string {
  const stamp = generatedAt.replace(/[:.]/g, "-");
  return `openadminos-audit-log-${stamp}.${format}`;
}

function serializeAuditLogJson(input: {
  generatedAt: string;
  from?: string;
  to?: string;
  retentionPolicy: RunHistoryRetentionSettings;
  lastPruneResult?: RunHistoryPruneResult;
  events: AuditLogEvent[];
  finalHash: string;
}): string {
  // TODO(ugur): Add signed timestamp/counter-signature support for compliance exports.
  return `${JSON.stringify(
    {
      schemaVersion: AUDIT_LOG_SCHEMA_VERSION,
      generatedAt: input.generatedAt,
      filters: {
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
      },
      retention: {
        policy: input.retentionPolicy,
        ...(input.lastPruneResult ? { lastPruneResult: input.lastPruneResult } : {}),
        note:
          "Run history may omit records removed by the local retention policy.",
      },
      hashChain: {
        algorithm: "sha256",
        startHash: AUDIT_CHAIN_START_HASH,
        finalHash: input.finalHash,
        entryHashInput:
          "previous entry sha256 hex + canonical JSON event without sha256",
        signedTimestamps: "not implemented",
      },
      eventCount: input.events.length,
      events: input.events,
    },
    null,
    2,
  )}\n`;
}

function serializeAuditLogCsv(input: {
  generatedAt: string;
  from?: string;
  to?: string;
  retentionPolicy: RunHistoryRetentionSettings;
  lastPruneResult?: RunHistoryPruneResult;
  events: AuditLogEvent[];
  finalHash: string;
}): string {
  const columns = [
    "schemaVersion",
    "generatedAt",
    "filterFrom",
    "filterTo",
    "retentionPolicyJson",
    "lastPruneResultJson",
    "chainAlgorithm",
    "chainStartHash",
    "chainFinalHash",
    "sha256",
    "timestamp",
    "type",
    "source",
    "runId",
    "tenantId",
    "agentSlug",
    "actorJson",
    "detailsJson",
  ];
  const rows = input.events.map((event) =>
    [
      AUDIT_LOG_SCHEMA_VERSION,
      input.generatedAt,
      input.from ?? "",
      input.to ?? "",
      canonicalJson(input.retentionPolicy),
      input.lastPruneResult ? canonicalJson(input.lastPruneResult) : "",
      "sha256",
      AUDIT_CHAIN_START_HASH,
      input.finalHash,
      event.sha256,
      event.timestamp,
      event.type,
      event.source,
      event.runId ?? "",
      event.tenantId ?? "",
      event.agentSlug ?? "",
      event.actor ? canonicalJson(event.actor) : "",
      canonicalJson(event.details),
    ].map(csvCell).join(","),
  );
  return `${columns.join(",")}\n${rows.join("\n")}${rows.length > 0 ? "\n" : ""}`;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

export interface AppStateStoreOptions {
  filePath: string;
  tokenStore: TokenCacheStorage;
  openBrowser?(url: string): Promise<void>;
  /**
   * Writable directory where user-authored agents (NL2Agent output)
   * live. Each child is `<slug>/manifest.yaml`.
   * When omitted, only bundled agents are visible to the registry.
   */
  userAgentsDir?: string;
  /**
   * Fired when a run transitions from a non-terminal status to a
   * terminal one (`completed`, `failed`, `cancelled`, `rejected`).
   * The host hooks this to surface an OS notification.
   */
  onRunFinished?(run: RunRecord): void;
  /**
   * Fired after host-side state changes that happen outside a direct
   * renderer request/response cycle, such as asynchronous connector
   * delivery activity appended after a terminal run snapshot.
   */
  onStateChanged?(info: { reason: string; runId?: string }): void;
  /**
   * Base URL for the install-stats aggregator. Pass `""` to disable
   * the POST entirely (the recommended setting for dev builds so we
   * don't pollute production counters). Defaults to the official
   * deployment URL.
   */
  statsApiUrl?: string;
  /** Version string POSTed alongside install events, e.g. `0.1.5`. */
  appVersion?: string;
  /** Initial MXC setting used when state.json has no saved preference. */
  sandboxedCodeDefault?: boolean;
  /** Writable userData directory used for the registry cache. */
  userDataPath?: string;
  /**
   * Test hook for host-level chat/cache smoke tests. Production code
   * leaves this unset so Graph always flows through MSAL + Graph adapter.
   */
  graphFactory?(input: {
    tenantId: string;
    scopes: string[];
    log: (
      level: RunLogLevel,
      message: string,
      metadata?: Record<string, unknown>,
    ) => void;
  }): RunGraphApi;
  /**
   * Test hook for deterministic provider detection in host-level smoke tests.
   * Production leaves this unset so provider readiness always comes from the
   * real local and hosted provider adapters.
   */
  providerListFactory?(): Promise<ProviderSummary[]> | ProviderSummary[];
  /**
   * Test hook for host-level chat/cache smoke tests. Production code
   * leaves this unset so provider availability and trust messaging still
   * come from the configured provider adapters.
   */
  llmFactory?(
    providerId: ProviderId,
    model: string | undefined,
  ): Promise<RunLlmApi> | RunLlmApi;
  /**
   * Test hook for WhatsApp delivery/session tests. Production leaves
   * this unset so all WhatsApp Web calls use the Baileys client.
   */
  whatsAppWebClientFactory?(input: { authDir: string }): WhatsAppWebClientLike;
  /**
   * Test hook for external connector secrets. Production stores these
   * under Electron safeStorage, outside persisted JSON state.
   */
  connectorSecretsFor?(connectorId: string): SecretAccessor;
  /**
   * Test hook for hosted provider secrets. Production stores these
   * under Electron safeStorage, outside persisted JSON state.
   */
  providerSecretsFor?(providerId: ProviderId): SecretAccessor;
  /**
   * Allows localhost/private registry sources for tests and explicit
   * development workflows. Packaged builds must leave this false.
   */
  allowDevRegistrySource?: boolean;
}

export class AppStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;
  private readonly tokenStore: TokenCacheStorage;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly userAgentsDir: string | undefined;
  private readonly onRunFinished: ((run: RunRecord) => void) | undefined;
  private readonly onStateChanged:
    | ((info: { reason: string; runId?: string }) => void)
    | undefined;
  private readonly statsApiUrl: string;
  private readonly appVersion: string;
  private readonly sandboxedCodeDefault: boolean;
  private readonly userDataPath: string | undefined;
  private readonly intelligenceStore: IntelligenceSqliteStore | undefined;
  private readonly chatService: IntuneChatService;
  private readonly driftService: DriftService;
  private readonly runService: RunService;
  private readonly runDeliveryService: RunDeliveryService;
  private readonly graphFactory: AppStateStoreOptions["graphFactory"] | undefined;
  private readonly providerListFactory:
    | AppStateStoreOptions["providerListFactory"]
    | undefined;
  private readonly llmFactory: AppStateStoreOptions["llmFactory"] | undefined;
  private readonly whatsAppWebClientFactory:
    | AppStateStoreOptions["whatsAppWebClientFactory"]
    | undefined;
  private readonly connectorSecretsForOverride:
    | AppStateStoreOptions["connectorSecretsFor"]
    | undefined;
  private readonly connectorSecretStore: SafeStorageConnectorSecretStore | undefined;
  private readonly providerSecretsForOverride:
    | AppStateStoreOptions["providerSecretsFor"]
    | undefined;
  private readonly providerSecretStore: SafeStorageProviderSecretStore | undefined;
  private readonly allowDevRegistrySource: boolean;
  private msalClient: PublicClientApplication | undefined;
  private tenantConnectController: AbortController | undefined;
  private whatsappWebClientInstance: WhatsAppWebClientLike | undefined;

  // Registry cache — populated by initRegistry(), falls back to
  // filesystem agents until the first successful HTTP fetch.
  private registryCacheEntries: RegistryAgentSummary[] | null = null;
  private lastRegistryRefresh: string | null = null;
  private registryRefreshError: string | null = null;

  constructor(options: AppStateStoreOptions | string, legacyTokenStore?: TokenCacheStorage) {
    if (typeof options === "string") {
      this.filePath = options;
      this.tokenStore =
        legacyTokenStore ?? new SafeStorageTokenCacheStore(`${options}.tokens.bin`);
      this.openBrowser = async () => undefined;
      this.userAgentsDir = undefined;
      this.onRunFinished = undefined;
      this.onStateChanged = undefined;
      this.statsApiUrl = "";
      this.appVersion = "0.0.0";
      this.sandboxedCodeDefault = false;
      this.userDataPath = undefined;
      this.intelligenceStore = undefined;
      this.graphFactory = undefined;
      this.providerListFactory = undefined;
      this.llmFactory = undefined;
      this.whatsAppWebClientFactory = undefined;
      this.connectorSecretsForOverride = undefined;
      this.connectorSecretStore = undefined;
      this.providerSecretsForOverride = undefined;
      this.providerSecretStore = undefined;
      this.allowDevRegistrySource = false;
    } else {
      this.filePath = options.filePath;
      this.tokenStore = options.tokenStore;
      this.openBrowser = options.openBrowser ?? (async () => undefined);
      this.userAgentsDir = options.userAgentsDir;
      this.onRunFinished = options.onRunFinished;
      this.onStateChanged = options.onStateChanged;
      this.statsApiUrl =
        typeof options.statsApiUrl === "string"
          ? options.statsApiUrl
          : DEFAULT_STATS_API_URL;
      this.appVersion = options.appVersion ?? "0.0.0";
      this.sandboxedCodeDefault = options.sandboxedCodeDefault === true;
      this.userDataPath = options.userDataPath;
      this.intelligenceStore = options.userDataPath
        ? new IntelligenceSqliteStore(join(options.userDataPath, "openadminos.db"))
        : undefined;
      this.graphFactory = options.graphFactory;
      this.providerListFactory = options.providerListFactory;
      this.llmFactory = options.llmFactory;
      this.whatsAppWebClientFactory = options.whatsAppWebClientFactory;
      this.connectorSecretsForOverride = options.connectorSecretsFor;
      this.connectorSecretStore = options.userDataPath
        ? new SafeStorageConnectorSecretStore(
            join(options.userDataPath, "connectors", "secrets"),
          )
        : undefined;
      this.providerSecretsForOverride = options.providerSecretsFor;
      this.providerSecretStore = options.userDataPath
        ? new SafeStorageProviderSecretStore(
            join(options.userDataPath, "providers", "secrets"),
          )
        : undefined;
      this.allowDevRegistrySource = options.allowDevRegistrySource === true;
    }
    const host = this;
    this.chatService = new IntuneChatService({
      read: () => host.read(),
      requireIntelligenceStore: () => host.requireIntelligenceStore(),
      resolveTenant: (persisted, tenantId) =>
        host.resolveTenant(persisted as PersistedState, tenantId),
      listProviders: () => host.listProviders(),
      buildLlm: (providerId, model) => host.buildLlm(providerId, model),
      buildGraph: (pinnedTenantId, agentScopes) =>
        host.buildGraph(pinnedTenantId, agentScopes),
      startRun: (agentSlug, options) => host.startRun(agentSlug, options),
      getDriftTimeline: (input) => host.getDriftTimeline(input),
      appVersion: this.appVersion,
      get userDataPath() {
        return host.userDataPath;
      },
      get intelligenceStore() {
        return host.intelligenceStore;
      },
      get graphFactory() {
        return host.graphFactory;
      },
    });
    this.driftService = new DriftService({
      read: () => host.read(),
      resolveTenant: (persisted, tenantId) =>
        host.resolveTenant(persisted as PersistedState, tenantId),
      listDriftSnapshots: (tenantId, options) =>
        host.requireIntelligenceStore().listDriftSnapshots(tenantId, options),
      getDriftSnapshot: (tenantId, snapshotId) =>
        host.requireIntelligenceStore().getDriftSnapshot(tenantId, snapshotId),
      listDriftChangesForSnapshot: (tenantId, snapshotId) =>
        host.requireIntelligenceStore().listDriftChangesForSnapshot(
          tenantId,
          snapshotId,
        ),
      getDriftObjectHistory: (tenantId, resource, graphId, options) =>
        host.requireIntelligenceStore().getDriftObjectHistory(
          tenantId,
          resource,
          graphId,
          options,
        ),
      listCachedGraphResourceRows: (input) =>
        host.requireIntelligenceStore().listCachedGraphResourceRows(input),
      getGraphCacheStatus: (tenantId, resources) =>
        host.requireIntelligenceStore().getGraphCacheStatus(
          tenantId,
          resources.map((resource) => definitionForResource(resource)),
        ),
      getDriftResourceStats: (tenantId, resources) =>
        host.requireIntelligenceStore().getDriftResourceStats(tenantId, resources),
    });
    this.runService = new RunService({
      read: () => host.read(),
      write: (state) => host.write(state as PersistedState),
      serialize: (task) => host.serialize(task),
      listProviders: () => host.listProviders(),
      providerCanRun: (provider) => host.providerCanRun(provider),
      buildLlm: (providerId, model) => host.buildLlm(providerId, model),
      buildGraph: (pinnedTenantId, agentScopes) =>
        host.buildGraph(pinnedTenantId, agentScopes),
      readConnectorConfigs: () => host.readConnectorConfigs(),
      connectorSecretsFor: (connectorId) => host.connectorSecretsFor(connectorId),
      selfTrainingPromptOverlay: (tenantId, agentSlug) =>
        host.selfTrainingPromptOverlay(tenantId, agentSlug),
      recordLearningEventSafely: (input) => host.recordLearningEventSafely(input),
      notifyRunFinished: (run) => host.notifyRunFinished(run),
      emitStateChanged: (reason, runId) => host.emitStateChanged(reason, runId),
      enqueueRunDeliveries: (run) => host.enqueueRunDeliveries(run),
      processPendingRunDeliveries: () => host.processPendingRunDeliveries(),
      appVersion: this.appVersion,
      get intelligenceStore() {
        return host.intelligenceStore;
      },
    });
    this.runDeliveryService = new RunDeliveryService({
      read: () => host.read(),
      write: (state) => host.write(state as PersistedState),
      serialize: (task) => host.serialize(task),
      getAppState: () => host.getAppState(),
      getMsalClient: () => host.getMsalClient(),
      openBrowser: (url) => host.openBrowser(url),
      connectorSecretsFor: (connectorId) => host.connectorSecretsFor(connectorId),
      whatsAppWebClient: () => host.whatsAppWebClient(),
      appendRunLog: (runId, level, message, metadata) =>
        host.runService.appendRunLog(runId, level, message, metadata),
      appendRunStep: (runId, input) => host.runService.appendRunStep(runId, input),
      finishRunStep: (runId, stepId, status, detail) =>
        host.runService.finishRunStep(runId, stepId, status, detail),
    });
    // Point the runtime at the OTA-updated manifest tree (if userData is
    // configured). When an agent has been updated via `updateAgent`, the
    // runtime resolves its manifest from here instead of the bundled tree.
    if (this.userDataPath) {
      setAgentUpdatesDir(join(this.userDataPath, "agent-updates"));
    }
    // Warm the connector-config cache so the confirm-bridge can resolve
    // human-readable target labels without an async disk read inside
    // a capability invocation. Updated on every `setConnectorConfig`.
    void this.primeConnectorConfigCache().catch(() => undefined);
  }

  close(): void {
    this.whatsappWebClientInstance?.dispose();
    this.intelligenceStore?.close();
  }

  private agentUpdatesRoot(): string | undefined {
    return this.userDataPath ? join(this.userDataPath, "agent-updates") : undefined;
  }

  private whatsAppWebAuthDir(): string {
    return join(
      this.userDataPath ?? dirname(this.filePath),
      "connectors",
      WHATSAPP_WEB_CONNECTOR_ID,
      "auth",
    );
  }

  private whatsAppWebClient(): WhatsAppWebClientLike {
    if (!this.whatsappWebClientInstance) {
      const authDir = this.whatsAppWebAuthDir();
      this.whatsappWebClientInstance = this.whatsAppWebClientFactory
        ? this.whatsAppWebClientFactory({ authDir })
        : getWhatsAppWebClient({ authDir });
    }
    return this.whatsappWebClientInstance;
  }

  private connectorRuntimeConfig(
    connectorId: string,
    config: Record<string, unknown>,
  ): Record<string, unknown> {
    if (connectorId !== WHATSAPP_WEB_CONNECTOR_ID) return config;
    return {
      ...config,
      authDir: this.whatsAppWebAuthDir(),
    };
  }

  private connectorSecretsFor(connectorId: string): SecretAccessor {
    return (
      this.connectorSecretsForOverride?.(connectorId) ??
      this.connectorSecretStore?.forConnector(connectorId) ??
      noSecrets
    );
  }

  private providerSecretsFor(providerId: ProviderId): SecretAccessor {
    return (
      this.providerSecretsForOverride?.(providerId) ??
      this.providerSecretStore?.forProvider(providerId) ??
      noSecrets
    );
  }

  private emptyAzureOpenAIConfig(): AzureOpenAIProviderConfig {
    return {
      endpoint: "",
      deployment: "",
      apiVersion: DEFAULT_AZURE_OPENAI_API_VERSION,
      hasKey: false,
    };
  }

  private azureOpenAIConfigFromState(
    persisted: PersistedState,
  ): Omit<AzureOpenAIProviderConfig, "hasKey"> {
    const config = persisted.providerConfigs?.azureOpenAI;
    return {
      endpoint: config?.endpoint ?? "",
      deployment: config?.deployment ?? "",
      apiVersion: config?.apiVersion ?? DEFAULT_AZURE_OPENAI_API_VERSION,
    };
  }

  private providerCanRun(
    provider: ProviderSummary | undefined,
  ): provider is ProviderSummary & { status: "connected" | "available" } {
    return (
      provider?.status === "connected" ||
      (provider?.id === "azure-openai" && provider.status === "available")
    );
  }

  private createTenantSessionForRecord(tenant: TenantRecord): TenantSession {
    const client = this.getMsalClient();
    const openBrowser = this.openBrowser;
    return createTenantSession({
      client,
      tenantId: tenant.id,
      username: tenant.username,
      homeAccountId: tenant.homeAccountId,
      acquireInteractive: async (scopes) =>
        runInteractiveFlow({ client, scopes, openBrowser }),
    });
  }

  /**
   * Fetches the registry index from the configured source, updates the
   * in-memory cache and persisted last-refresh timestamp.
   *
   * Source priority (first available wins):
   *   1. Live HTTP fetch from `registrySource/index.json`
   *   2. On-disk cache from a previous successful fetch
   *   3. Filesystem scan of the bundled `agents/` directory (Electron
   *      extraResources in packaged builds, repo root in dev)
   *
   * (3) is only reached when both (1) and (2) failed — in that case
   * we leave `registryCacheEntries` null so `listRegistryAgents()`
   * walks the filesystem. The bundled agents are the same set the
     * remote registry serves in public preview; this dual-source
     * approach keeps the app usable when the network registry is
     * temporarily unavailable.
   *
   * Safe to call multiple times (e.g., on manual refresh).
   */
  async initRegistry(): Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }> {
    if (!this.userDataPath) {
      // No userData path — fall back to filesystem only (tests / legacy ctor).
      return { error: null, fromCache: false, cachedAt: null };
    }
    const persisted = await this.read().catch(() => defaultState);
    const registrySource = persisted.registrySource ?? DEFAULT_REGISTRY_SOURCE;
    const result = await refreshRegistry(this.userDataPath, registrySource, {
      allowDevSource: this.allowDevRegistrySource,
    });

    const bothSourcesFailed = result.error !== null && !result.fromCache;
    if (bothSourcesFailed) {
      // Keep `registryCacheEntries` null so listRegistryAgents() walks
      // the bundled filesystem fallback. Surface the error to the UI
      // so the user knows why the remote source isn't being used.
      this.registryCacheEntries = null;
    } else {
      this.registryCacheEntries = result.entries.map((entry) =>
        entryToRegistrySummary(entry, this.appVersion),
      );
    }
    this.lastRegistryRefresh = result.fromCache || bothSourcesFailed ? null : (result.cachedAt ?? null);
    this.registryRefreshError = result.error;
    return { error: result.error, fromCache: result.fromCache, cachedAt: result.cachedAt };
  }

  async setRegistrySource(
    url: string,
    options: { confirmExternalSource?: boolean } = {},
  ): Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }> {
    const validation = validateRegistrySource(url, {
      allowDevSource: this.allowDevRegistrySource,
    });
    if (validation.requiresTrustReview && options.confirmExternalSource !== true) {
      throw new Error(
        "Changing registry source away from the official OpenAdminOS registry requires trust review confirmation.",
      );
    }
    await this.serialize(async () => {
      const current = await this.read();
      const next = { ...current, registrySource: validation.sourceUrl };
      await this.write(next);
    });
    // Trigger an immediate refresh against the new source so the
    // renderer doesn't show stale cached agents from the old URL.
    return this.initRegistry();
  }

  async setRegistryInstallCountsEnabled(enabled: boolean): Promise<AppState> {
    await this.serialize(async () => {
      const current = await this.read();
      const next: PersistedState = {
        ...current,
        registryInstallCountsEnabled: enabled,
      };
      if (!enabled) {
        delete next.installId;
      }
      await this.write(next);
    });
    return this.getAppState();
  }

  async getSandboxedCodeEnabled(): Promise<boolean> {
    const persisted = await this.read();
    return persisted.sandboxedCodeEnabled ?? this.sandboxedCodeDefault;
  }

  async setSandboxedCodeEnabled(enabled: boolean): Promise<boolean> {
    await this.serialize(async () => {
      const current = await this.read();
      await this.write({
        ...current,
        sandboxedCodeEnabled: enabled,
      });
    });
    return enabled;
  }

  private getMsalClient(): PublicClientApplication {
    if (this.msalClient) return this.msalClient;
    const cacheStorage: TokenCacheStorage = {
      read: () => this.tokenStore.read(),
      write: (serialized) => this.tokenStore.write(serialized),
    };
    this.msalClient = createMsalClient({ storage: cacheStorage });
    return this.msalClient;
  }

  private requireIntelligenceStore(): IntelligenceSqliteStore {
    if (!this.intelligenceStore) {
      throw new Error("Intune Chat requires a configured userData directory.");
    }
    return this.intelligenceStore;
  }

  private resolveTenant(
    persisted: PersistedState,
    tenantId?: string,
  ): TenantRecord {
    const resolvedId = tenantId ?? persisted.activeTenantId;
    const tenant = resolvedId
      ? persisted.tenants.find((entry) => entry.id === resolvedId)
      : undefined;
    if (!tenant) {
      throw new Error(
        "No tenant connected. Connect a Microsoft 365 tenant before using Intune Chat.",
      );
    }
    return tenant;
  }

  private selfTrainingPromptOverlay(tenantId: string, agentSlug: string): string | undefined {
    return this.chatService.selfTrainingPromptOverlay(tenantId, agentSlug);
  }

  private recordLearningEventSafely(input: {
    tenantId?: string;
    agentSlug?: string;
    eventType: string;
    source: string;
    payload: unknown;
  }): void {
    this.chatService.recordLearningEventSafely(input);
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  private withRunHistorySummary(
    summary: LocalDataSummary,
    persisted: PersistedState,
  ): LocalDataSummary {
    return {
      ...summary,
      runHistoryCount: persisted.runs.length,
      runHistoryRetention: this.normalizeRunHistoryRetentionSettings(
        persisted.runHistoryRetention,
      ),
      ...(persisted.lastRunHistoryPrune
        ? { lastRunHistoryPrune: persisted.lastRunHistoryPrune }
        : {}),
      driftRetention: this.normalizeDriftRetentionSettings(
        persisted.driftRetentionDays,
      ),
      ...(persisted.lastDriftHistoryPrune
        ? { lastDriftHistoryPrune: persisted.lastDriftHistoryPrune }
        : {}),
    };
  }

  private normalizeRunHistoryRetentionSettings(
    settings?: RunHistoryRetentionSettings,
  ): RunHistoryRetentionSettings {
    if (!settings) {
      return { ...DEFAULT_RUN_HISTORY_RETENTION_SETTINGS };
    }
    const next: RunHistoryRetentionSettings = {
      neverPrune: settings.neverPrune === true,
    };
    const keepLastRuns = sanitizeRunHistoryRetentionInteger(
      settings.keepLastRuns,
      1,
      100_000,
    );
    if (keepLastRuns !== undefined) {
      next.keepLastRuns = keepLastRuns;
    }
    const keepDays = sanitizeRunHistoryRetentionInteger(
      settings.keepDays,
      1,
      3_650,
    );
    if (keepDays !== undefined) {
      next.keepDays = keepDays;
    }
    if (typeof settings.updatedAt === "string" && settings.updatedAt.trim()) {
      next.updatedAt = settings.updatedAt;
    }
    if (
      !next.neverPrune &&
      next.keepLastRuns === undefined &&
      next.keepDays === undefined
    ) {
      return { ...DEFAULT_RUN_HISTORY_RETENTION_SETTINGS };
    }
    return next;
  }

  private normalizeRunHistoryRetentionInput(
    input: SetRunHistoryRetentionSettingsInput,
    updatedAt: string,
  ): RunHistoryRetentionSettings {
    const neverPrune = input.neverPrune === true;
    const next: RunHistoryRetentionSettings = { neverPrune, updatedAt };
    const keepLastRuns = nullableRetentionInteger(
      input.keepLastRuns,
      "Run count retention",
      1,
      100_000,
    );
    if (keepLastRuns !== undefined) {
      next.keepLastRuns = keepLastRuns;
    }
    const keepDays = nullableRetentionInteger(
      input.keepDays,
      "Run age retention",
      1,
      3_650,
    );
    if (keepDays !== undefined) {
      next.keepDays = keepDays;
    }
    if (
      !neverPrune &&
      next.keepLastRuns === undefined &&
      next.keepDays === undefined
    ) {
      throw new Error("Enable at least one run-history retention rule, or choose never prune.");
    }
    return next;
  }

  private normalizeDriftRetentionSettings(
    settings?: DriftRetentionSettings | number | "never",
  ): DriftRetentionSettings {
    if (settings === "never") {
      return { neverPrune: true };
    }
    if (typeof settings === "number") {
      const keepDays = sanitizeDriftRetentionDays(settings);
      return keepDays !== undefined
        ? { neverPrune: false, keepDays }
        : { ...DEFAULT_DRIFT_RETENTION_SETTINGS };
    }
    if (!settings) {
      return { ...DEFAULT_DRIFT_RETENTION_SETTINGS };
    }
    const next: DriftRetentionSettings = {
      neverPrune: settings.neverPrune === true,
    };
    const keepDays = sanitizeDriftRetentionDays(settings.keepDays);
    if (keepDays !== undefined) {
      next.keepDays = keepDays;
    }
    if (typeof settings.updatedAt === "string" && settings.updatedAt.trim()) {
      next.updatedAt = settings.updatedAt;
    }
    if (!next.neverPrune && next.keepDays === undefined) {
      return { ...DEFAULT_DRIFT_RETENTION_SETTINGS };
    }
    return next;
  }

  private normalizeDriftRetentionInput(
    input: SetDriftRetentionSettingsInput,
    updatedAt: string,
  ): DriftRetentionSettings {
    const neverPrune = input.neverPrune === true;
    const next: DriftRetentionSettings = { neverPrune, updatedAt };
    const keepDays = nullableDriftRetentionDays(input.keepDays);
    if (keepDays !== undefined) {
      next.keepDays = keepDays;
    }
    if (!neverPrune && next.keepDays === undefined) {
      throw new Error("Set change-history retention days, or choose never prune.");
    }
    return next;
  }

  private getRunHistoryPruneProtectedRunIds(runs: RunRecord[]): {
    all: Set<string>;
    workspace: Set<string>;
    active: Set<string>;
    awaitingConfirmation: Set<string>;
  } {
    const knownRunIds = new Set(runs.map((run) => run.id));
    const workspace = new Set(
      (this.intelligenceStore?.listWorkspaceReferencedRunIds() ?? []).filter(
        (runId) => knownRunIds.has(runId),
      ),
    );
    const active = new Set<string>();
    const awaitingConfirmation = new Set<string>();

    for (const run of runs) {
      // Exclusion: queued/running runs are live runtime state and may still
      // receive progress snapshots, logs, connector audit entries, or results.
      if (run.status === "queued" || run.status === "running") {
        active.add(run.id);
      }
      // Exclusion: awaiting-confirmation runs are the human-in-the-loop write
      // safety gate. Pruning must never erase a pending approval decision.
      if (run.status === "awaiting-confirmation") {
        awaitingConfirmation.add(run.id);
      }
    }

    const all = new Set<string>();
    for (const runId of workspace) {
      // Exclusion: workspace-linked or workspace-pinned runs are investigation
      // evidence. Workspace deletion intentionally leaves underlying run
      // history intact; retention follows the same boundary.
      all.add(runId);
    }
    for (const runId of active) all.add(runId);
    for (const runId of awaitingConfirmation) all.add(runId);
    return { all, workspace, active, awaitingConfirmation };
  }

  async getAppState(): Promise<AppState> {
    const persisted = await this.read();
    const providers = await this.listProviders();
    const activeProvider =
      providers.find((provider) => provider.id === persisted.activeProviderId) ??
      providers[0];
    const activeTenant = persisted.activeTenantId
      ? persisted.tenants.find((tenant) => tenant.id === persisted.activeTenantId)
      : undefined;
    const activeModel = resolveProviderDefaultModel(
      activeProvider,
      persisted.activeModelByProviderId,
    ).model;

    const registryAgents = this.listRegistryAgents();
    const installedAgents = this.decorateInstalledWithUpdateInfo(
      persisted.installedAgents,
      registryAgents,
    );

    const state: AppState = {
      activeProviderId: activeProvider?.id ?? "ollama",
      appVersion: this.appVersion,
      providers,
      registryAgents,
      installedAgents,
      runs: persisted.runs,
      trust: deriveTrustState({
        provider: activeProvider,
        activeTenant,
        model: activeModel,
      }),
      tenants: persisted.tenants,
      lastRegistryRefresh: this.lastRegistryRefresh,
      registryRefreshError: this.registryRefreshError,
      registrySource: persisted.registrySource ?? DEFAULT_REGISTRY_SOURCE,
      registryInstallCountsEnabled: persisted.registryInstallCountsEnabled !== false,
      schedulerStatus: this.deriveSchedulerStatus(persisted),
    };
    if (persisted.activeModelByProviderId) {
      state.activeModelByProviderId = persisted.activeModelByProviderId;
    }
    if (persisted.activeTenantId) {
      state.activeTenantId = persisted.activeTenantId;
    }
    return state;
  }

  listRegistryAgents(): RegistryAgentSummary[] {
    if (!this.registryCacheEntries) {
      // Before first HTTP fetch: fall back to filesystem scan (dev + cold start).
      return listAllRegistryAgents(this.userAgentsDir).map((agent) =>
        withAgentCompatibility(agent, this.appVersion),
      );
    }
    // HTTP cache populated: use it as base and overlay user-authored agents.
    const dir = this.userAgentsDir;
    const userAgents = dir
      ? listAllRegistryAgents(dir).filter((a) => a.registryPath?.startsWith(dir))
      : [];
    const bySlug = new Map<string, RegistryAgentSummary>();
    for (const a of this.registryCacheEntries) bySlug.set(a.slug, a);
    for (const a of userAgents) bySlug.set(a.slug, withAgentCompatibility(a, this.appVersion));
    return [...bySlug.values()].sort((l, r) => l.name.localeCompare(r.name));
  }

  async getAgentManifest(slug: string): Promise<AgentManifestPreview | undefined> {
    // Prefer the on-disk metadata from the registry (it has the correct
    // registryPath) so the preview can label the source location.
    const registryAgent = this.listRegistryAgents().find(
      (agent) => agent.slug === slug || agent.id === slug,
    );
    if (registryAgent) {
      const preview = loadAgentManifestPreview(registryAgent);
      if (!preview) return undefined;
      return {
        ...preview,
        isUserAuthored: this.isUserAuthoredRegistryPath(preview.registryPath),
      };
    }
    // Fall back to an installed agent for the rare case where it's no
    // longer in the registry but still in user state.
    const persisted = await this.read();
    const installed = persisted.installedAgents.find(
      (agent) => agent.slug === slug || agent.id === slug,
    );
    if (!installed) return undefined;
    const preview = loadAgentManifestPreview(installed);
    if (!preview) return undefined;
    return {
      ...preview,
      isUserAuthored: this.isUserAuthoredRegistryPath(preview.registryPath),
    };
  }

  async listAgents(): Promise<AgentSummary[]> {
    const persisted = await this.read();
    return persisted.installedAgents;
  }

  async getAzureOpenAIConfig(): Promise<AzureOpenAIProviderConfig> {
    const persisted = await this.read();
    const config = this.azureOpenAIConfigFromState(persisted);
    const apiKey = await this.providerSecretsFor("azure-openai").get("api-key");
    return {
      ...config,
      hasKey: Boolean(apiKey),
    };
  }

  async setAzureOpenAIConfig(
    input: SetAzureOpenAIProviderConfigInput,
  ): Promise<AzureOpenAIProviderConfig> {
    const endpoint = input.endpoint.trim();
    const deployment = input.deployment.trim();
    const apiVersion =
      input.apiVersion.trim() || DEFAULT_AZURE_OPENAI_API_VERSION;
    const hasApiKeyInput = Object.prototype.hasOwnProperty.call(input, "apiKey");
    if (hasApiKeyInput) {
      const normalized =
        typeof input.apiKey === "string" ? input.apiKey.trim() : null;
      const accessor = this.providerSecretsFor("azure-openai");
      if (normalized && normalized.length > 0) {
        await accessor.set("api-key", normalized);
      } else {
        await accessor.remove("api-key");
      }
    }

    await this.serialize(async () => {
      const current = await this.read();
      await this.write({
        ...current,
        providerConfigs: {
          ...(current.providerConfigs ?? {}),
          azureOpenAI: {
            endpoint,
            deployment,
            apiVersion,
          },
        },
      });
    });

    return this.getAzureOpenAIConfig();
  }

  async listProviders(): Promise<ProviderSummary[]> {
    if (this.providerListFactory) {
      return this.providerListFactory();
    }

    let azureOpenAIConfig: AzureOpenAIProviderConfig | undefined;
    let azureOpenAIConfigError: string | undefined;
    try {
      azureOpenAIConfig = await this.getAzureOpenAIConfig();
    } catch (error) {
      azureOpenAIConfigError = error instanceof Error ? error.message : String(error);
    }

    return Promise.all(
      providerCatalog.map(async (provider) => {
        if (provider.id === "ollama") return checkOllama(provider);
        if (provider.id === "apple-foundation") return checkAppleFoundation(provider);
        if (provider.id === "lm-studio") return checkLmStudio(provider);
        if (provider.id === "anthropic") return checkClaudeCode(provider);
        if (provider.id === "openai") return checkCodex(provider);
        if (provider.id === "azure-openai") {
          if (azureOpenAIConfigError) {
            return {
              ...provider,
              status: "error",
              detail: azureOpenAIConfigError,
              models: [],
            };
          }
          return checkAzureOpenAI(
            provider,
            azureOpenAIConfig ?? this.emptyAzureOpenAIConfig(),
          );
        }
        return provider;
      }),
    );
  }

  async testProvider(
    providerId: ProviderId,
    model?: string,
  ): Promise<ProviderTestResult> {
    if (!isProviderId(providerId)) {
      throw new Error(`Unknown provider: ${String(providerId)}`);
    }
    const providers = await this.listProviders();
    const provider = providers.find((entry) => entry.id === providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }
    const providerReady =
      provider.status === "connected" ||
      (provider.id === "azure-openai" && provider.status === "available");
    if (!providerReady) {
      return {
        providerId,
        ok: false,
        message: provider.detail ?? `${provider.name} is not connected.`,
      };
    }
    const selectedModel = model ?? provider.defaultModel ?? provider.models[0];
    if (selectedModel && provider.models.length > 0 && !provider.models.includes(selectedModel)) {
      throw new Error(
        `Model "${selectedModel}" is not available for ${provider.name}.`,
      );
    }

    const startedAt = Date.now();
    if (providerId === "azure-openai") {
      try {
        const probe = await probeAzureOpenAi(
          await this.azureOpenAIRuntimeOptions(selectedModel),
        );
        return {
          providerId,
          ok: probe.ready,
          model: probe.model,
          durationMs: probe.durationMs,
          message: probe.ready
            ? `${provider.name} returned a minimal chat completion.`
            : probe.detail,
        };
      } catch (error) {
        return {
          providerId,
          ok: false,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const llm = await this.buildLlm(providerId, selectedModel);
    if (!llm.available) {
      return {
        providerId,
        ok: false,
        message: `${provider.name} is not available to the runtime.`,
      };
    }
    try {
      const completion = await llm.complete({
        ...(selectedModel ? { model: selectedModel } : {}),
        system:
          "Connectivity smoke test. Reply with exactly: OPENADMINOS_PROVIDER_OK",
        prompt: "Reply with exactly: OPENADMINOS_PROVIDER_OK",
        maxTokens: 24,
      });
      const normalized = completion.text.trim();
      const ok = normalized.includes("OPENADMINOS_PROVIDER_OK");
      return {
        providerId,
        ok,
        model: completion.model,
        durationMs: Date.now() - startedAt,
        message: ok
          ? `${provider.name} returned a valid smoke-test response.`
          : `${provider.name} responded, but not with the expected smoke-test text.`,
      };
    } catch (error) {
      return {
        providerId,
        ok: false,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listIntuneChatConversations(): Promise<IntuneChatConversation[]> {
    return this.chatService.listIntuneChatConversations();
  }

  async searchIntuneChatConversations(query: string): Promise<IntuneChatConversation[]> {
    return this.chatService.searchIntuneChatConversations(query);
  }

  async renameIntuneChatConversation(
    conversationId: string,
    title: string,
  ): Promise<IntuneChatConversation> {
    return this.chatService.renameIntuneChatConversation(conversationId, title);
  }

  async setIntuneChatConversationPinned(
    conversationId: string,
    pinned: boolean,
  ): Promise<IntuneChatConversation> {
    return this.chatService.setIntuneChatConversationPinned(conversationId, pinned);
  }

  async deleteIntuneChatConversation(conversationId: string): Promise<void> {
    return this.chatService.deleteIntuneChatConversation(conversationId);
  }

  async getIntuneChatMessages(conversationId: string): Promise<IntuneChatMessage[]> {
    return this.chatService.getIntuneChatMessages(conversationId);
  }

  async listTenantGroups(): Promise<TenantGroup[]> {
    return this.chatService.listTenantGroups();
  }

  async saveTenantGroup(input: {
    id?: string;
    name: string;
    tenantIds: string[];
  }): Promise<TenantGroup> {
    return this.chatService.saveTenantGroup(input);
  }

  async deleteTenantGroup(id: string): Promise<void> {
    return this.chatService.deleteTenantGroup(id);
  }

  async listSavedMultiTenantQueries(): Promise<SavedMultiTenantQuery[]> {
    return this.chatService.listSavedMultiTenantQueries();
  }

  async preflightMultiTenantIntuneChat(
    input: PreflightMultiTenantChatInput,
  ): Promise<TenantScopePreflight> {
    return this.chatService.preflightMultiTenantIntuneChat(input);
  }

  async runMultiTenantIntuneChat(
    input: RunMultiTenantChatInput,
    onEvent?: (event: MultiTenantChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<MultiTenantChatRunResult> {
    return this.chatService.runMultiTenantIntuneChat(input, onEvent, options);
  }

  async streamMultiTenantIntuneChat(
    input: RunMultiTenantChatInput,
    onEvent: (event: MultiTenantChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<MultiTenantChatRunResult> {
    return this.chatService.streamMultiTenantIntuneChat(input, onEvent, options);
  }

  async listMultiTenantChatJobs(): Promise<MultiTenantChatJob[]> {
    return this.chatService.listMultiTenantChatJobs();
  }

  async getMultiTenantChatJob(id: string): Promise<MultiTenantChatJob | undefined> {
    return this.chatService.getMultiTenantChatJob(id);
  }

  async queueMultiTenantAgentBatch(
    input: QueueMultiTenantAgentBatchInput,
  ): Promise<QueueMultiTenantAgentBatchResult> {
    return this.chatService.queueMultiTenantAgentBatch(input);
  }

  async listMultiTenantAgentBatches(): Promise<MultiTenantAgentBatch[]> {
    return this.chatService.listMultiTenantAgentBatches();
  }

  async getMultiTenantAgentBatch(
    id: string,
  ): Promise<MultiTenantAgentBatch | undefined> {
    return this.chatService.getMultiTenantAgentBatch(id);
  }

  async getGraphCacheStatus(tenantId?: string): Promise<GraphCacheStatus> {
    return this.chatService.getGraphCacheStatus(tenantId);
  }

  async getDriftTimeline(input: DriftTimelineInput): Promise<DriftTimelineResult> {
    return this.driftService.getDriftTimeline(input);
  }

  async getDriftEntryDetail(
    input: DriftEntryDetailInput,
  ): Promise<DriftEntryDetail> {
    return this.driftService.getDriftEntryDetail(input);
  }

  async getDriftObjectHistory(
    input: DriftObjectHistoryInput,
  ): Promise<DriftObjectHistoryResult> {
    return this.driftService.getDriftObjectHistory(input);
  }

  async getDriftStatus(tenantId: string): Promise<DriftStatus> {
    return this.driftService.getDriftStatus(tenantId);
  }

  async getGraphCacheRefreshSchedule(
    tenantId?: string,
  ): Promise<GraphCacheRefreshScheduleSettings> {
    return this.chatService.getGraphCacheRefreshSchedule(tenantId);
  }

  async setGraphCacheRefreshSchedule(
    input: SetGraphCacheRefreshScheduleInput,
  ): Promise<GraphCacheRefreshScheduleSettings> {
    return this.chatService.setGraphCacheRefreshSchedule(input);
  }

  async getLocalDataSummary(tenantId?: string): Promise<LocalDataSummary> {
    const [summary, persisted] = await Promise.all([
      this.chatService.getLocalDataSummary(tenantId),
      this.read(),
    ]);
    return this.withRunHistorySummary(summary, persisted);
  }

  async clearIntuneChatHistory(): Promise<LocalDataSummary> {
    const summary = await this.chatService.clearIntuneChatHistory();
    const persisted = await this.read();
    return this.withRunHistorySummary(summary, persisted);
  }

  async clearGraphCache(tenantId?: string): Promise<LocalDataSummary> {
    const summary = await this.chatService.clearGraphCache(tenantId);
    const persisted = await this.read();
    return this.withRunHistorySummary(summary, persisted);
  }

  async getRunHistoryRetentionSettings(): Promise<RunHistoryRetentionSettings> {
    const persisted = await this.read();
    return this.normalizeRunHistoryRetentionSettings(persisted.runHistoryRetention);
  }

  async setRunHistoryRetentionSettings(
    input: SetRunHistoryRetentionSettingsInput,
  ): Promise<RunHistoryRetentionSettings> {
    const settings = this.normalizeRunHistoryRetentionInput(input, new Date().toISOString());
    await this.serialize(async () => {
      const persisted = await this.read();
      await this.write({
        ...persisted,
        runHistoryRetention: settings,
      });
    });
    return settings;
  }

  async pruneRunHistoryNow(): Promise<RunHistoryPruneResult> {
    return this.pruneRunHistory("manual");
  }

  async getDriftRetentionSettings(): Promise<DriftRetentionSettings> {
    const persisted = await this.read();
    return this.normalizeDriftRetentionSettings(persisted.driftRetentionDays);
  }

  async setDriftRetentionSettings(
    input: SetDriftRetentionSettingsInput,
  ): Promise<DriftRetentionSettings> {
    const settings = this.normalizeDriftRetentionInput(input, new Date().toISOString());
    await this.serialize(async () => {
      const persisted = await this.read();
      await this.write({
        ...persisted,
        driftRetentionDays: settings,
      });
    });
    return settings;
  }

  async pruneDriftHistoryNow(): Promise<DriftHistoryPruneResult> {
    return this.pruneDriftHistory("manual");
  }

  async exportAuditLog(input: ExportAuditLogInput): Promise<AuditLogExportResult> {
    if (input.format !== "json" && input.format !== "csv") {
      throw new Error("Audit log export format must be json or csv.");
    }
    const fromMs = parseAuditExportBoundary(input.from, "from");
    const toMs = parseAuditExportBoundary(input.to, "to");
    if (fromMs !== undefined && toMs !== undefined && fromMs > toMs) {
      throw new Error("Audit log export from date must be before the to date.");
    }

    const persisted = await this.read();
    const retentionPolicy = this.normalizeRunHistoryRetentionSettings(
      persisted.runHistoryRetention,
    );
    const generatedAt = new Date().toISOString();
    const allEvents = buildAuditLogEvents({
      runs: persisted.runs,
      tenants: persisted.tenants,
      installedAgents: persisted.installedAgents,
      hostedProviderConsentEvents:
        this.intelligenceStore?.listHostedProviderConsentAuditEvents() ?? [],
    });
    const filteredEvents = allEvents.filter((event) =>
      auditEventWithinRange(event, fromMs, toMs),
    );
    const { events, finalHash } = applyAuditHashChain(filteredEvents);
    const common = {
      generatedAt,
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      retentionPolicy,
      ...(persisted.lastRunHistoryPrune
        ? { lastPruneResult: persisted.lastRunHistoryPrune }
        : {}),
      events,
      finalHash,
    };
    const content =
      input.format === "json"
        ? serializeAuditLogJson(common)
        : serializeAuditLogCsv(common);
    return {
      format: input.format,
      suggestedName: auditLogSuggestedName(input.format, generatedAt),
      mimeType: input.format === "json" ? "application/json" : "text/csv",
      content,
      generatedAt,
      eventCount: events.length,
      hashChain: {
        algorithm: "sha256",
        startHash: AUDIT_CHAIN_START_HASH,
        finalHash,
      },
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
    };
  }

  async pruneRunHistory(
    trigger: RunHistoryPruneTrigger,
  ): Promise<RunHistoryPruneResult> {
    return this.serialize(async () => {
      const persisted = await this.read();
      const policy = this.normalizeRunHistoryRetentionSettings(
        persisted.runHistoryRetention,
      );
      const protectedSets = this.getRunHistoryPruneProtectedRunIds(persisted.runs);
      const prunedAt = new Date().toISOString();
      const base = {
        prunedAt,
        trigger,
        policy,
        beforeCount: persisted.runs.length,
        eligibleCount: Math.max(0, persisted.runs.length - protectedSets.all.size),
        protectedCount: protectedSets.all.size,
        protectedWorkspaceCount: protectedSets.workspace.size,
        protectedActiveCount: protectedSets.active.size,
        protectedAwaitingConfirmationCount: protectedSets.awaitingConfirmation.size,
      };

      if (policy.neverPrune) {
        const result: RunHistoryPruneResult = {
          ...base,
          afterCount: persisted.runs.length,
          prunedCount: 0,
          reason: "Never prune is enabled.",
        };
        if (trigger === "manual") {
          await this.write({ ...persisted, lastRunHistoryPrune: result });
        }
        return result;
      }

      const newestKeptIds =
        policy.keepLastRuns !== undefined
          ? new Set(
              [...persisted.runs]
                .sort((a, b) => runHistorySortMs(b) - runHistorySortMs(a))
                .slice(0, policy.keepLastRuns)
                .map((run) => run.id),
            )
          : undefined;
      const cutoffMs =
        policy.keepDays !== undefined
          ? Date.now() - policy.keepDays * 24 * 60 * 60 * 1000
          : undefined;

      const pruneCandidates = persisted.runs
        .filter((run) => {
          if (protectedSets.all.has(run.id)) return false;
          const keptByCount = newestKeptIds?.has(run.id) === true;
          const keptByAge =
            cutoffMs !== undefined && runHistorySortMs(run) >= cutoffMs;
          return !keptByCount && !keptByAge;
        })
        .sort((a, b) => runHistorySortMs(a) - runHistorySortMs(b));
      const prunedIds = new Set(pruneCandidates.map((run) => run.id));
      const nextRuns =
        prunedIds.size > 0
          ? persisted.runs.filter((run) => !prunedIds.has(run.id))
          : persisted.runs;
      const result: RunHistoryPruneResult = {
        ...base,
        afterCount: nextRuns.length,
        prunedCount: pruneCandidates.length,
        reason:
          pruneCandidates.length > 0
            ? runHistoryPruneReason(pruneCandidates.length, policy)
            : "No eligible runs exceeded the retention policy.",
        ...(pruneCandidates[0]?.queuedAt
          ? { oldestPrunedQueuedAt: pruneCandidates[0].queuedAt }
          : {}),
        ...(pruneCandidates.at(-1)?.queuedAt
          ? { newestPrunedQueuedAt: pruneCandidates.at(-1)!.queuedAt }
          : {}),
      };

      if (pruneCandidates.length > 0 || trigger === "manual") {
        await this.write({
          ...persisted,
          runs: nextRuns,
          lastRunHistoryPrune: result,
        });
        if (pruneCandidates.length > 0) {
          this.emitStateChanged("run-history-pruned");
        }
      }
      return result;
    });
  }

  async pruneDriftHistory(
    trigger: DriftPruneTrigger,
  ): Promise<DriftHistoryPruneResult> {
    return this.serialize(async () => {
      const persisted = await this.read();
      const policy = this.normalizeDriftRetentionSettings(persisted.driftRetentionDays);
      const prunedAt = new Date().toISOString();
      if (policy.neverPrune) {
        const result: DriftHistoryPruneResult = {
          prunedAt,
          trigger,
          policy,
          snapshotsDeleted: 0,
          versionsDeleted: 0,
          reason: "Never prune is enabled.",
        };
        if (trigger === "manual") {
          await this.write({ ...persisted, lastDriftHistoryPrune: result });
        }
        return result;
      }

      const keepDays = policy.keepDays ?? DEFAULT_DRIFT_RETENTION_SETTINGS.keepDays;
      if (keepDays === undefined) {
        throw new Error("Change-history retention days are not configured.");
      }
      const pruned = this.requireIntelligenceStore().pruneDriftHistory(null, keepDays);
      const deleted = pruned.snapshotsDeleted + pruned.versionsDeleted;
      const result: DriftHistoryPruneResult = {
        prunedAt,
        trigger,
        policy,
        snapshotsDeleted: pruned.snapshotsDeleted,
        versionsDeleted: pruned.versionsDeleted,
        reason:
          deleted > 0
            ? driftPruneReason(pruned, policy)
            : "No change history exceeded the retention policy.",
      };
      if (deleted > 0 || trigger === "manual") {
        await this.write({
          ...persisted,
          lastDriftHistoryPrune: result,
        });
      }
      return result;
    });
  }

  async refreshGraphCache(
    options: RefreshGraphCacheOptions = {},
  ): Promise<GraphCacheRefreshResult> {
    return this.chatService.refreshGraphCache(options);
  }

  async sendIntuneChatMessage(
    input: SendIntuneChatMessageInput,
  ): Promise<SendIntuneChatMessageResult> {
    return this.chatService.sendIntuneChatMessage(input);
  }

  async streamIntuneChatMessage(
    input: SendIntuneChatMessageInput,
    onEvent: (event: IntuneChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<SendIntuneChatMessageResult> {
    return this.chatService.streamIntuneChatMessage(input, onEvent, options);
  }

  async getSelfTrainingSettings(): Promise<SelfTrainingSettings> {
    return this.chatService.getSelfTrainingSettings();
  }

  async getChatInvestigationSettings(): Promise<ChatInvestigationSettings> {
    return this.chatService.getChatInvestigationSettings();
  }

  async setChatInvestigationMode(
    mode: ChatInvestigationMode,
  ): Promise<ChatInvestigationSettings> {
    return this.chatService.setChatInvestigationMode(mode);
  }

  async setSelfTrainingEnabled(enabled: boolean): Promise<SelfTrainingSettings> {
    return this.chatService.setSelfTrainingEnabled(enabled);
  }

  async listSelfTrainingSuggestions(
    status?: SelfTrainingSuggestionStatus,
  ): Promise<SelfTrainingSuggestion[]> {
    return this.chatService.listSelfTrainingSuggestions(status);
  }

  async approveSelfTrainingSuggestion(id: string): Promise<SelfTrainingSuggestion> {
    return this.chatService.approveSelfTrainingSuggestion(id);
  }

  async rejectSelfTrainingSuggestion(id: string): Promise<SelfTrainingSuggestion> {
    return this.chatService.rejectSelfTrainingSuggestion(id);
  }

  async resetSelfTrainingSuggestions(
    input: ResetSelfTrainingInput,
  ): Promise<SelfTrainingSuggestion[]> {
    return this.chatService.resetSelfTrainingSuggestions(input);
  }

  async listWorkspaces(tenantId?: string): Promise<WorkspaceSummary[]> {
    const persisted = await this.read();
    const resolvedTenant = tenantId ? this.resolveTenant(persisted, tenantId) : undefined;
    return this.requireIntelligenceStore().listWorkspaces(
      tenantNamesById(persisted.tenants),
      resolvedTenant?.id,
    );
  }

  async getWorkspace(id: string): Promise<WorkspaceDetail | undefined> {
    if (!id.trim()) throw new Error("Workspace id is required.");
    const persisted = await this.read();
    return this.requireIntelligenceStore().getWorkspace(
      id,
      tenantNamesById(persisted.tenants),
    );
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceDetail> {
    const persisted = await this.read();
    const tenant = this.resolveTenant(persisted, input.tenantId);
    return this.requireIntelligenceStore().createWorkspace({
      id: `wksp_${randomUUID()}`,
      tenantId: tenant.id,
      tenantName: tenant.displayName,
      title: normalizeWorkspaceTitle(input.title),
      ...(input.instructions ? { instructions: normalizeWorkspaceInstructions(input.instructions) } : {}),
      now: new Date().toISOString(),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });
  }

  async updateWorkspace(
    id: string,
    input: UpdateWorkspaceInput,
  ): Promise<WorkspaceDetail> {
    if (!id.trim()) throw new Error("Workspace id is required.");
    const persisted = await this.read();
    return this.requireIntelligenceStore().updateWorkspace({
      id,
      ...(input.title !== undefined ? { title: normalizeWorkspaceTitle(input.title) } : {}),
      ...(input.instructions !== undefined
        ? { instructions: normalizeWorkspaceInstructions(input.instructions) }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      now: new Date().toISOString(),
      tenantNames: tenantNamesById(persisted.tenants),
    });
  }

  async archiveWorkspace(id: string): Promise<WorkspaceSummary> {
    if (!id.trim()) throw new Error("Workspace id is required.");
    const persisted = await this.read();
    return this.requireIntelligenceStore().archiveWorkspace(
      id,
      new Date().toISOString(),
      tenantNamesById(persisted.tenants),
    );
  }

  async deleteWorkspace(id: string): Promise<void> {
    if (!id.trim()) throw new Error("Workspace id is required.");
    this.requireIntelligenceStore().deleteWorkspace(id);
  }

  async addWorkspaceNote(workspaceId: string, content: string): Promise<WorkspaceNote> {
    if (!workspaceId.trim()) throw new Error("Workspace id is required.");
    const trimmed = content.trim();
    if (!trimmed) throw new Error("Workspace note content is required.");
    return this.requireIntelligenceStore().addWorkspaceNote({
      id: `wnote_${randomUUID()}`,
      workspaceId,
      content: trimmed,
      now: new Date().toISOString(),
    });
  }

  async updateWorkspaceNote(noteId: string, content: string): Promise<WorkspaceNote> {
    if (!noteId.trim()) throw new Error("Workspace note id is required.");
    const trimmed = content.trim();
    if (!trimmed) throw new Error("Workspace note content is required.");
    return this.requireIntelligenceStore().updateWorkspaceNote(
      noteId,
      trimmed,
      new Date().toISOString(),
    );
  }

  async pinWorkspaceEvidence(
    input: PinWorkspaceEvidenceInput,
  ): Promise<WorkspaceEvidence> {
    const persisted = await this.read();
    const tenant = this.resolveTenant(persisted, input.tenantId);
    return this.requireIntelligenceStore().pinWorkspaceEvidence({
      id: `wev_${randomUUID()}`,
      workspaceId: input.workspaceId,
      tenantId: tenant.id,
      title: normalizeWorkspaceTitle(input.title),
      sourceType: input.sourceType,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      content: input.content,
      ...(input.freshness ? { freshness: input.freshness } : {}),
      now: new Date().toISOString(),
    });
  }

  async linkWorkspaceConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<WorkspaceLink> {
    const persisted = await this.read();
    const store = this.requireIntelligenceStore();
    const workspace = store.getWorkspace(workspaceId, tenantNamesById(persisted.tenants));
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const conversation = store.getConversation(conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
    if (conversation.scopeKind === "multi-tenant") {
      throw new Error("Multi-tenant conversations cannot be linked directly to one workspace. Split the result into tenant-specific evidence instead.");
    }
    if (conversation.tenantId && conversation.tenantId !== workspace.tenantId) {
      throw new Error("Conversation tenant does not match the workspace tenant.");
    }
    return store.linkWorkspaceConversation({
      id: `wlink_${randomUUID()}`,
      workspaceId,
      tenantId: workspace.tenantId,
      conversationId,
      title: conversation.title,
      now: new Date().toISOString(),
    });
  }

  async linkWorkspaceRun(workspaceId: string, runId: string): Promise<WorkspaceLink> {
    const persisted = await this.read();
    const store = this.requireIntelligenceStore();
    const workspace = store.getWorkspace(workspaceId, tenantNamesById(persisted.tenants));
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    const run = persisted.runs.find((entry) => entry.id === runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (run.tenantId && run.tenantId !== workspace.tenantId) {
      throw new Error("Run tenant does not match the workspace tenant.");
    }
    return store.linkWorkspaceRun({
      id: `wlink_${randomUUID()}`,
      workspaceId,
      tenantId: workspace.tenantId,
      runId,
      title: run.summary ?? run.agentSlug,
      now: new Date().toISOString(),
    });
  }

  async importMultiTenantResultToWorkspaces(
    input: ImportMultiTenantResultToWorkspacesInput,
  ): Promise<ImportMultiTenantResultToWorkspacesResult> {
    const persisted = await this.read();
    const store = this.requireIntelligenceStore();
    const job = store.getMultiTenantJob(input.jobId);
    if (!job) throw new Error(`Multi-tenant job not found: ${input.jobId}`);
    const resolvedTenantIds = new Set(job.resolvedTenantIds);
    for (const mapping of input.tenantMappings) {
      if (!resolvedTenantIds.has(mapping.tenantId)) {
        throw new Error(`Tenant ${mapping.tenantId} is not part of this multi-tenant result.`);
      }
      if (mapping.workspaceId) {
        const workspace = store.getWorkspace(
          mapping.workspaceId,
          tenantNamesById(persisted.tenants),
        );
        if (!workspace) throw new Error(`Workspace not found: ${mapping.workspaceId}`);
        if (workspace.tenantId !== mapping.tenantId) {
          throw new Error("Target workspace tenant does not match the imported tenant.");
        }
      }
    }
    return store.importMultiTenantResultToWorkspaces({
      job,
      tenantNames: tenantNamesById(persisted.tenants),
      mappings: input.tenantMappings,
      createWorkspaceId: () => `wksp_${randomUUID()}`,
      createEvidenceId: () => `wev_${randomUUID()}`,
      now: new Date().toISOString(),
    });
  }

  async exportWorkspaceDossier(id: string): Promise<string> {
    if (!id.trim()) throw new Error("Workspace id is required.");
    const persisted = await this.read();
    return this.requireIntelligenceStore().exportWorkspaceDossier(
      id,
      tenantNamesById(persisted.tenants),
    );
  }

  async listConnectors(): Promise<ConnectorSummary[]> {
    const persisted = await this.read();
    const stored = persisted.connectors ?? {};
    return listRegisteredConnectors().map((descriptor) => {
      const entry = stored[descriptor.id];
      const summary: ConnectorSummary = {
        descriptor,
        config: entry?.config ?? {},
        status: entry?.status ?? "unknown",
      };
      if (entry?.lastTestedAt) summary.lastTestedAt = entry.lastTestedAt;
      if (entry?.lastTestMessage) summary.lastTestMessage = entry.lastTestMessage;
      if (descriptor.id === WHATSAPP_WEB_CONNECTOR_ID) {
        const live = this.whatsAppWebClient().getStatus();
        summary.status = whatsappWebStatusToConnectorStatus(live);
        summary.lastTestMessage = live.message;
      }
      return summary;
    });
  }

  /**
   * Builds the connector with the active tenant session and calls
   * `healthCheck`. Persists the outcome so the Connectors page can
   * surface the last status without re-running the test on every
   * render.
   */
  async testConnector(connectorId: string): Promise<ConnectorSummary> {
    const factory = findConnectorFactory(connectorId);
    if (!factory) {
      throw new Error(`Unknown connector '${connectorId}'.`);
    }
    const persisted = await this.read();
    const activeTenantId = persisted.activeTenantId;
    const tenant = activeTenantId
      ? persisted.tenants.find((t) => t.id === activeTenantId)
      : undefined;
    if (!tenant && factory.descriptor.authSource !== "external") {
      throw new Error(
        "No tenant connected. Connect a Microsoft 365 tenant before testing connectors.",
      );
    }
    const tenantSession = tenant
      ? this.createTenantSessionForRecord(tenant)
      : createLocalOnlyTenantSession();

    const storedConfig =
      persisted.connectors?.[connectorId]?.config ?? {};
    const runtimeConfig = this.connectorRuntimeConfig(connectorId, storedConfig);

    const buildContext = {
      tenant: tenantSession,
      config: runtimeConfig,
      secrets: this.connectorSecretsFor(connectorId),
      log: () => undefined,
      idempotencyKeyFor: (stepId: string, iteration: number) =>
        `test:${connectorId}:${stepId}:${iteration}`,
    };

    let status: ConnectorSummary["status"] = "error";
    let message: string | undefined;
    try {
      const instance = await factory.build(buildContext);
      try {
        const health = await instance.healthCheck();
        status = health.healthy
          ? "connected"
          : connectorId === WHATSAPP_WEB_CONNECTOR_ID
            ? "needs-setup"
            : "error";
        message = health.message;
      } finally {
        await instance.dispose().catch(() => undefined);
      }
    } catch (error) {
      status = "error";
      message = error instanceof Error ? error.message : String(error);
    }

    const lastTestedAt = new Date().toISOString();
    await this.serialize(async () => {
      const current = await this.read();
      const next: PersistedState = {
        ...current,
        connectors: {
          ...(current.connectors ?? {}),
          [connectorId]: {
            config: storedConfig,
            status,
            lastTestedAt,
            ...(message !== undefined ? { lastTestMessage: message } : {}),
          },
        },
      };
      await this.write(next);
    });

    const summary: ConnectorSummary = {
      descriptor: factory.descriptor,
      config: storedConfig,
      status,
      lastTestedAt,
    };
    if (message !== undefined) summary.lastTestMessage = message;
    return summary;
  }

  /**
   * Synchronous accessor for the most-recently-persisted connector
   * config snapshot. Used by the confirm-bridge when it needs to
   * decorate a confirmation request with human-readable names — the
   * bridge fires in-process during a run and can't afford the
   * file-read latency of `readConnectorConfigs`. Stays in sync via
   * `setConnectorConfig` (which updates the cache after every save).
   */
  getConnectorConfigCached(connectorId: string): Record<string, unknown> {
    return this.connectorConfigCache.get(connectorId) ?? {};
  }

  private connectorConfigCache = new Map<string, Record<string, unknown>>();

  private async primeConnectorConfigCache(): Promise<void> {
    const persisted = await this.read();
    this.connectorConfigCache.clear();
    for (const [id, entry] of Object.entries(persisted.connectors ?? {})) {
      this.connectorConfigCache.set(id, entry.config ?? {});
    }
  }

  /**
   * Build the `connectorConfigs` map the runtime passes to
   * `ExecuteRunInput`. Reads from `PersistedState.connectors[id].config`
   * for every registered connector so a run picks up the latest
   * defaults the user saved on the Connectors page — no agent
   * reinstall required when a connector default changes.
   */
  private async readConnectorConfigs(): Promise<
    Record<string, Record<string, unknown>>
  > {
    const persisted = await this.read();
    const stored = persisted.connectors ?? {};
    const map: Record<string, Record<string, unknown>> = {};
    for (const [id, entry] of Object.entries(stored)) {
      map[id] = this.connectorRuntimeConfig(id, entry.config ?? {});
    }
    if (!map[WHATSAPP_WEB_CONNECTOR_ID]) {
      map[WHATSAPP_WEB_CONNECTOR_ID] = this.connectorRuntimeConfig(
        WHATSAPP_WEB_CONNECTOR_ID,
        {},
      );
    }
    return map;
  }

  async setConnectorConfig(
    connectorId: string,
    config: Record<string, unknown>,
  ): Promise<ConnectorSummary> {
    const factory = findConnectorFactory(connectorId);
    if (!factory) {
      throw new Error(`Unknown connector '${connectorId}'.`);
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw new Error("setConnectorConfig: config must be a plain object.");
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string" && value.length > 0) {
        sanitized[key] = value;
      }
    }
    await this.serialize(async () => {
      const current = await this.read();
      const existing = current.connectors?.[connectorId];
      const merged: PersistedState["connectors"] = {
        ...(current.connectors ?? {}),
        [connectorId]: {
          ...existing,
          config: sanitized,
        },
      };
      await this.write({ ...current, connectors: merged });
    });
    this.connectorConfigCache.set(connectorId, sanitized);
    const persisted = await this.read();
    const entry = persisted.connectors?.[connectorId];
    const summary: ConnectorSummary = {
      descriptor: factory.descriptor,
      config: entry?.config ?? {},
      status: entry?.status ?? "unknown",
    };
    if (entry?.lastTestedAt) summary.lastTestedAt = entry.lastTestedAt;
    if (entry?.lastTestMessage) summary.lastTestMessage = entry.lastTestMessage;
    return summary;
  }

  async setConnectorSecret(
    connectorId: string,
    key: string,
    value: string | null,
  ): Promise<ConnectorSummary> {
    const factory = findConnectorFactory(connectorId);
    if (!factory) {
      throw new Error(`Unknown connector '${connectorId}'.`);
    }
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(key)) {
      throw new Error("setConnectorSecret: key contains unsupported characters.");
    }
    const accessor = this.connectorSecretsFor(connectorId);
    const normalized = typeof value === "string" ? value.trim() : null;
    if (normalized && normalized.length > 0) {
      await accessor.set(key, normalized);
    } else {
      await accessor.remove(key);
    }

    await this.serialize(async () => {
      const current = await this.read();
      const existing = current.connectors?.[connectorId];
      const nextEntry: NonNullable<PersistedState["connectors"]>[string] = {
        config: existing?.config ?? {},
        status: "unknown",
      };
      const nextConnectors = {
        ...(current.connectors ?? {}),
        [connectorId]: nextEntry,
      };
      await this.write({ ...current, connectors: nextConnectors });
    });
    const persisted = await this.read();
    const entry = persisted.connectors?.[connectorId];
    return {
      descriptor: factory.descriptor,
      config: entry?.config ?? {},
      status: entry?.status ?? "unknown",
    };
  }

  /**
   * Build the named connector in a one-shot read mode, invoke the
   * supplied read-kind capability, dispose, and return the result.
   * Shared by `listConnectorTeams` and `listConnectorChannels` —
   * neither needs the run-time confirmation wrapper because both
   * are `kind: read`.
   */
  private async invokeConnectorRead<T>(
    connectorId: string,
    invoke: (capabilities: unknown) => Promise<T>,
  ): Promise<T> {
    const factory = findConnectorFactory(connectorId);
    if (!factory) throw new Error(`Unknown connector '${connectorId}'.`);
    const persisted = await this.read();
    const activeTenantId = persisted.activeTenantId;
    const tenant = activeTenantId
      ? persisted.tenants.find((t) => t.id === activeTenantId)
      : undefined;
    if (!tenant && factory.descriptor.authSource !== "external") {
      throw new Error(
        "No tenant connected. Connect a Microsoft 365 tenant before invoking connectors.",
      );
    }
    const tenantSession = tenant
      ? this.createTenantSessionForRecord(tenant)
      : createLocalOnlyTenantSession();
    const config = this.connectorRuntimeConfig(
      connectorId,
      persisted.connectors?.[connectorId]?.config ?? {},
    );
    const instance = await factory.build({
      tenant: tenantSession,
      config,
      secrets: this.connectorSecretsFor(connectorId),
      log: () => undefined,
      idempotencyKeyFor: (stepId, iteration) =>
        `picker:${connectorId}:${stepId}:${iteration}`,
    });
    try {
      return await invoke(instance.capabilities);
    } finally {
      await instance.dispose().catch(() => undefined);
    }
  }

  async listConnectorTeams(connectorId: string): Promise<unknown[]> {
    return this.invokeConnectorRead(connectorId, async (capabilities) => {
      const caps = capabilities as { listTeams?: () => Promise<unknown[]> };
      if (typeof caps.listTeams !== "function") {
        throw new Error(
          `Connector '${connectorId}' does not expose a listTeams capability.`,
        );
      }
      return caps.listTeams();
    });
  }

  async listConnectorChannels(
    connectorId: string,
    teamId: string,
  ): Promise<unknown[]> {
    if (!teamId || typeof teamId !== "string") {
      throw new Error("listConnectorChannels requires a non-empty teamId.");
    }
    return this.invokeConnectorRead(connectorId, async (capabilities) => {
      const caps = capabilities as {
        listChannels?: (teamId: string) => Promise<unknown[]>;
      };
      if (typeof caps.listChannels !== "function") {
        throw new Error(
          `Connector '${connectorId}' does not expose a listChannels capability.`,
        );
      }
      return caps.listChannels(teamId);
    });
  }

  async getWhatsAppWebStatus(): Promise<WhatsAppWebStatus> {
    return this.whatsAppWebClient().restoreSession(1_500);
  }

  async startWhatsAppWebLogin(): Promise<WhatsAppWebStatus> {
    const status = await this.whatsAppWebClient().startLogin();
    await this.persistConnectorTestStatus(
      WHATSAPP_WEB_CONNECTOR_ID,
      whatsappWebStatusToConnectorStatus(status),
      status.message,
    );
    return status;
  }

  async disconnectWhatsAppWeb(): Promise<WhatsAppWebStatus> {
    const status = await this.whatsAppWebClient().disconnect();
    await this.persistConnectorTestStatus(
      WHATSAPP_WEB_CONNECTOR_ID,
      whatsappWebStatusToConnectorStatus(status),
      status.message,
    );
    await this.clearWhatsAppTargetsAfterDisconnect();
    return status;
  }

  async listWhatsAppWebGroups(): Promise<WhatsAppWebGroupRef[]> {
    return this.whatsAppWebClient().listGroups();
  }

  async sendWhatsAppWebTestMessage(to: string): Promise<WhatsAppWebSendResult> {
    const result = await this.whatsAppWebClient().sendMessage({
      to,
      text: `OpenAdminOS test notification\n\nSent ${new Date().toISOString()}.`,
    });
    await this.persistConnectorTestStatus(
      WHATSAPP_WEB_CONNECTOR_ID,
      "connected",
      "Test WhatsApp message sent.",
    );
    return { messageId: result.messageId };
  }

  private async persistConnectorTestStatus(
    connectorId: string,
    status: ConnectorSummary["status"],
    message?: string,
  ): Promise<void> {
    const lastTestedAt = new Date().toISOString();
    await this.serialize(async () => {
      const current = await this.read();
      const existing = current.connectors?.[connectorId];
      await this.write({
        ...current,
        connectors: {
          ...(current.connectors ?? {}),
          [connectorId]: {
            config: existing?.config ?? {},
            status,
            lastTestedAt,
            ...(message !== undefined ? { lastTestMessage: message } : {}),
          },
        },
      });
    });
  }

  private async clearWhatsAppTargetsAfterDisconnect(): Promise<void> {
    const defaultConfig = {
      defaultRecipientType: "self",
      defaultRecipient: "self",
      defaultRecipientLabel: "My WhatsApp",
    };
    await this.serialize(async () => {
      const current = await this.read();
      const existing = current.connectors?.[WHATSAPP_WEB_CONNECTOR_ID];
      const nextAgents = current.installedAgents.map((agent) => {
        const delivery = agent.delivery?.whatsappWeb;
        if (!delivery || delivery.useDefaultRecipient !== false) return agent;
        const restDelivery: AgentWhatsAppWebDelivery = { ...delivery };
        delete restDelivery.recipientType;
        delete restDelivery.recipient;
        delete restDelivery.recipientLabel;
        return {
          ...agent,
          delivery: {
            ...agent.delivery,
            whatsappWeb: {
              ...restDelivery,
              useDefaultRecipient: true,
            },
          },
        };
      });
      const nextState: PersistedState = {
        ...current,
        installedAgents: nextAgents,
        connectors: {
          ...(current.connectors ?? {}),
          [WHATSAPP_WEB_CONNECTOR_ID]: {
            ...existing,
            config: defaultConfig,
          },
        },
        runDeliveryQueue: (current.runDeliveryQueue ?? []).filter(
          (item) => item.connectorId !== WHATSAPP_WEB_CONNECTOR_ID,
        ),
      };
      if (nextState.runDeliveryQueue?.length === 0) {
        delete nextState.runDeliveryQueue;
      }
      await this.write(nextState);
    });
    this.connectorConfigCache.set(WHATSAPP_WEB_CONNECTOR_ID, defaultConfig);
  }

  /**
   * Persist per-install overrides for an agent's `definition.settings[]`.
   * The manifest is the source of truth for the legal key set and type
   * for each value: unknown keys are silently dropped, ill-typed values
   * throw before any persist.
   */
  async updateAgentSettings(
    slug: string,
    values: Record<string, unknown>,
  ): Promise<AppState> {
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new Error(`updateAgentSettings: values must be an object.`);
    }

    // Manifest read, validation, and persist all live inside the same
    // serialize() slot so a concurrent install or re-install of the same
    // agent can't slip a different manifest version between the read and
    // the write. The cost is one extra ipc-bound read inside the chain;
    // the prize is atomicity.
    await this.serialize(async () => {
      const preview = await this.getAgentManifest(slug);
      if (!preview) {
        throw new Error(`updateAgentSettings: unknown agent "${slug}".`);
      }

      const declared = preview.manifest.definition.settings ?? [];
      const sanitized = sanitizeSettingsAgainstSchema(declared, values, slug);

      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentSettings: agent "${slug}" is not installed.`);
      }
      const next = [...persisted.installedAgents];
      next[idx] = { ...next[idx], settings: sanitized };
      await this.write({
        ...persisted,
        installedAgents: next,
      });
      this.recordLearningEventSafely({
        tenantId: persisted.activeTenantId,
        agentSlug: next[idx]?.slug ?? slug,
        eventType: "agent.settings-updated",
        source: "settings",
        payload: { settings: sanitized },
      });
    });

    return this.getAppState();
  }

  async updateAgentSchedule(
    slug: string,
    schedule: AgentSchedule | null,
  ): Promise<AppState> {
    const updatedAt = new Date().toISOString();
    if (schedule !== null) {
      if (typeof schedule !== "object") {
        throw new Error("updateAgentSchedule: schedule must be an object or null.");
      }
      if (
        typeof schedule.intervalSeconds !== "number" ||
        !Number.isFinite(schedule.intervalSeconds) ||
        schedule.intervalSeconds < 60
      ) {
        throw new Error(
          "updateAgentSchedule: intervalSeconds must be a number >= 60.",
        );
      }
      if (typeof schedule.enabled !== "boolean") {
        throw new Error("updateAgentSchedule: enabled must be a boolean.");
      }
      for (const key of ["notifyOnSuccess", "notifyOnFailure", "notifyOnChangeOnly"] as const) {
        if (schedule[key] !== undefined && typeof schedule[key] !== "boolean") {
          throw new Error(`updateAgentSchedule: ${key} must be a boolean when provided.`);
        }
      }
    }

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentSchedule: agent "${slug}" is not installed.`);
      }
      const next = [...persisted.installedAgents];
      const existing = next[idx];
      if (schedule === null) {
        const { schedule: _, ...rest } = existing;
        next[idx] = rest;
      } else {
        const activationAnchor =
          schedule.enabled && existing.schedule?.enabled !== true
            ? updatedAt
            : undefined;
        next[idx] = {
          ...existing,
          schedule: {
            enabled: schedule.enabled,
            intervalSeconds: Math.floor(schedule.intervalSeconds),
            notifyOnSuccess: schedule.notifyOnSuccess ?? existing.schedule?.notifyOnSuccess ?? true,
            notifyOnFailure: schedule.notifyOnFailure ?? existing.schedule?.notifyOnFailure ?? true,
            notifyOnChangeOnly:
              schedule.notifyOnChangeOnly ?? existing.schedule?.notifyOnChangeOnly ?? false,
            ...(activationAnchor
              ? { lastScheduledRunAt: activationAnchor }
              : schedule.lastScheduledRunAt
                ? { lastScheduledRunAt: schedule.lastScheduledRunAt }
                : existing.schedule?.lastScheduledRunAt
                  ? { lastScheduledRunAt: existing.schedule.lastScheduledRunAt }
                  : {}),
          },
        };
      }
      await this.write({ ...persisted, installedAgents: next });
    });

    return this.getAppState();
  }

  async updateAgentTeamsDelivery(
    slug: string,
    delivery: AgentTeamsDelivery | null,
  ): Promise<AppState> {
    return this.runDeliveryService.updateAgentTeamsDelivery(slug, delivery);
  }

  async updateAgentWhatsAppWebDelivery(
    slug: string,
    delivery: AgentWhatsAppWebDelivery | null,
  ): Promise<AppState> {
    return this.runDeliveryService.updateAgentWhatsAppWebDelivery(slug, delivery);
  }

  async updateAgentOutlookDelivery(
    slug: string,
    delivery: AgentOutlookDelivery | null,
  ): Promise<AppState> {
    return this.runDeliveryService.updateAgentOutlookDelivery(slug, delivery);
  }

  async updateAgentSlackDelivery(
    slug: string,
    delivery: AgentSlackDelivery | null,
  ): Promise<AppState> {
    return this.runDeliveryService.updateAgentSlackDelivery(slug, delivery);
  }

  async updateAgentDiscordDelivery(
    slug: string,
    delivery: AgentDiscordDelivery | null,
  ): Promise<AppState> {
    return this.runDeliveryService.updateAgentDiscordDelivery(slug, delivery);
  }

  async updateAgentSignalDelivery(
    slug: string,
    delivery: AgentSignalDelivery | null,
  ): Promise<AppState> {
    return this.runDeliveryService.updateAgentSignalDelivery(slug, delivery);
  }

  /**
   * Walk all installed agents and fire any whose schedule is enabled +
   * due. Runs against the agent's active-tenant default; in-flight runs
   * for the same agent are skipped to avoid stampedes. Visible app
   * sessions call this on a timer; OS scheduler registrations launch the
   * same app entrypoint in hidden mode while the user is signed in.
   */
  async fireDueSchedules(): Promise<void> {
    const persisted = await this.read();
    const nowMs = Date.now();

    for (const agent of persisted.installedAgents) {
      const schedule = agent.schedule;
      if (!schedule?.enabled) continue;
      const lastFired = schedule.lastScheduledRunAt
        ? new Date(schedule.lastScheduledRunAt).getTime()
        : scheduleFallbackAnchor(agent.installedAt, nowMs);
      const dueAtMs = lastFired + schedule.intervalSeconds * 1000;
      if (nowMs < dueAtMs) continue;

      // Skip if there's already an in-flight run for this agent — we
      // don't want a long-running agent to queue more copies of itself.
      const inFlight = persisted.runs.some(
        (run) =>
          run.agentSlug === agent.slug &&
          (run.status === "queued" ||
            run.status === "running" ||
            run.status === "awaiting-confirmation"),
      );
      if (inFlight) continue;

      try {
        await this.startRun(agent.slug, { trigger: "schedule" });
        await this.updateAgentSchedule(agent.slug, {
          enabled: true,
          intervalSeconds: schedule.intervalSeconds,
          notifyOnSuccess: schedule.notifyOnSuccess,
          notifyOnFailure: schedule.notifyOnFailure,
          notifyOnChangeOnly: schedule.notifyOnChangeOnly,
          lastScheduledRunAt: new Date(nowMs).toISOString(),
        });
      } catch (error) {
        await this.persistScheduledRunFailure(agent, schedule, error, nowMs);
        console.error(
          `[scheduler] agent "${agent.slug}" failed to start:`,
          error,
        );
      }
    }
  }

  async refreshDueGraphCaches(): Promise<void> {
    return this.chatService.refreshDueGraphCaches();
  }

  private async persistScheduledRunFailure(
    agent: AgentSummary,
    schedule: AgentSchedule,
    error: unknown,
    nowMs: number,
  ): Promise<void> {
    const now = new Date(nowMs).toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const summary = humanizeScheduledRunError(message);
    const runId = `run_${nowMs.toString(36)}_${randomUUID().slice(0, 8)}`;
    const failedRun: RunRecord = {
      id: runId,
      agentSlug: agent.slug,
      status: "failed",
      queuedAt: now,
      startedAt: now,
      finishedAt: now,
      trigger: "schedule",
      summary,
      error: message,
      steps: [],
      logs: [
        {
          id: randomUUID(),
          runId,
          timestamp: now,
          level: "error",
          message,
        },
      ],
    };
    await this.persistRunSnapshot(failedRun);
    await this.updateAgentSchedule(agent.slug, {
      enabled: true,
      intervalSeconds: schedule.intervalSeconds,
      notifyOnSuccess: schedule.notifyOnSuccess,
      notifyOnFailure: schedule.notifyOnFailure,
      notifyOnChangeOnly: schedule.notifyOnChangeOnly,
      lastScheduledRunAt: now,
    });
  }

  /**
   * NL2Agent — draft a `manifest.yaml` from a plain-English description.
   *
   * Builds a structured prompt that includes the canonical JSON Schema
   * inline, calls the active LLM provider for a one-shot completion,
   * strips any ``` fences, parses the YAML, and validates it against
   * the schema. Returns both the raw YAML (so the renderer can show
   * the user exactly what came back) and the parsed manifest when
   * valid, or a list of structured validation errors when not.
   *
   * Throws when no LLM provider is connected — the renderer surfaces
   * the message and points the user at the provider settings.
   */
  async draftAgentManifest(prompt: string): Promise<AgentDraft> {
    const trimmed = typeof prompt === "string" ? prompt.trim() : "";
    if (trimmed.length === 0) {
      throw new Error("draftAgentManifest: prompt must be a non-empty string.");
    }

    const persisted = await this.read();
    const llm = await this.buildLlm(persisted.activeProviderId, undefined);
    if (!llm.available) {
      throw new Error(
        "No LLM provider is available. Start Ollama (or your configured provider) and try again.",
      );
    }

    // Pull a shortlist of real Graph endpoints relevant to the user's
    // prompt and inject them into the system prompt. Keeps the model
    // grounded in real paths instead of inventing them, and gives it
    // the matching delegated scope to declare. For prompts that look
    // write-y, also surface POST/PATCH/PUT/DELETE candidates so the
    // model can wire up a `graph-write` step.
    const readCandidates = searchEndpoints(trimmed, { limit: 10, method: "GET" });
    const writeCandidates = promptLooksWritey(trimmed)
      ? [
          ...searchEndpoints(trimmed, { limit: 3, method: "POST" }),
          ...searchEndpoints(trimmed, { limit: 3, method: "PATCH" }),
          ...searchEndpoints(trimmed, { limit: 2, method: "DELETE" }),
        ]
      : [];
    const reservedSlugs = this.getReservedAgentSlugs();
    const system = buildNl2AgentSystemPrompt(
      readCandidates,
      writeCandidates,
      reservedSlugs,
    );
    const userTurn = `Draft a manifest.yaml for the following OpenAdminOS agent description.

Description from the user:
"""
${trimmed}
"""

Return ONLY the YAML manifest. Do not include any commentary, headings, or markdown fences.`;

    const completion = await llm.complete({
      system,
      prompt: userTurn,
      temperature: 0.2,
      maxTokens: 1400,
    });

    let draft = validateAgentDraftSource(
      stripCodeFences(completion.text).trim(),
      reservedSlugs,
    );

    // Repair once with the exact host validation errors. This keeps the
    // builder useful when the first pass is close but misses a schema
    // detail or Graph catalogue requirement.
    if (draft.validationErrors.length > 0) {
      const repaired = await llm.complete({
        system,
        prompt: buildNl2AgentRepairPrompt(trimmed, draft),
        temperature: 0.1,
        maxTokens: 1600,
      });
      draft = validateAgentDraftSource(
        stripCodeFences(repaired.text).trim(),
        reservedSlugs,
      );
    }

    return draft;
  }

  /**
   * Validate an edited `manifest.yaml` without saving it. This mirrors
   * `saveAgentDraft`'s hard gates but returns structured errors so the
   * renderer can keep the user in the review pane.
   */
  async validateAgentDraft(
    yamlSource: string,
    allowedSlug?: string,
  ): Promise<AgentDraft> {
    return validateAgentDraftSource(
      yamlSource,
      this.getReservedAgentSlugs(allowedSlug),
    );
  }

  async preflightAgentDraft(
    yamlSource: string,
    allowedSlug?: string,
  ): Promise<AgentDraftPreflightResult> {
    const checks: AgentDraftPreflightResult["checks"] = [];
    const persisted = await this.read();
    const activeTenant = persisted.activeTenantId
      ? persisted.tenants.find((tenant) => tenant.id === persisted.activeTenantId)
      : undefined;

    checks.push(
      activeTenant
        ? {
            id: "tenant",
            label: "Tenant",
            status: "pass",
            detail: `Will run against ${activeTenant.displayName}.`,
          }
        : {
            id: "tenant",
            label: "Tenant",
            status: "fail",
            detail: "Connect or select a Microsoft 365 tenant before installing.",
          },
    );

    const provider = (await this.listProviders()).find(
      (candidate) => candidate.id === persisted.activeProviderId,
    );
    checks.push(
      this.providerCanRun(provider)
        ? {
            id: "provider",
            label: "LLM provider",
            status: "pass",
            detail: `${provider.name} is connected (${provider.isLocal ? "local" : "hosted"}).`,
          }
        : {
            id: "provider",
            label: "LLM provider",
            status: "fail",
            detail: "Connect a local or hosted LLM provider before installing.",
          },
    );

    const draft = validateAgentDraftSource(
      yamlSource,
      this.getReservedAgentSlugs(allowedSlug),
    );
    if (!draft.manifest) {
      checks.push({
        id: "manifest",
        label: "Manifest",
        status: "fail",
        detail: draft.validationErrors.join("; "),
      });
      return { ok: false, checks };
    }

    const manifest = draft.manifest;
    checks.push({
      id: "manifest",
      label: "Manifest",
      status: "pass",
      detail: "Schema, Graph catalogue, LLM-step, slug, and connector declarations pass.",
    });

    const scopes = collectManifestScopes(manifest);
    checks.push({
      id: "scopes",
      label: "Graph scopes",
      status: manifest.descriptor.mode === "write" ? "warn" : "pass",
      detail:
        manifest.descriptor.mode === "write"
          ? `${scopes.length} scope(s) declared. Microsoft may prompt for incremental consent.`
          : `${scopes.length} scope(s) declared.`,
    });

    checks.push(...preflightConnectorRequirements(manifest));

    const writeSteps = manifest.skills.filter((skill) => skill.format === "write");
    checks.push({
      id: "writes",
      label: "Write gate",
      status: writeSteps.length > 0 ? "warn" : "pass",
      detail:
        writeSteps.length > 0
          ? `${writeSteps.length} write step(s) will pause for typed confirmation. This preflight does not apply Graph changes.`
          : "No write steps declared.",
    });

    return {
      ok: !checks.some((check) => check.status === "fail"),
      checks,
    };
  }

  /**
   * Persist a user-authored agent under `userAgentsDir/<slug>/`. The
   * slug comes from the manifest's `descriptor.id`. Writes the
   * `manifest.yaml` — the only file an agent needs to exist.
   *
   * Refuses to overwrite an existing user agent or to shadow a bundled
   * agent (the user gets a clear error and can rename their draft).
   */
  async saveAgentDraft(yamlSource: string): Promise<AppState> {
    if (typeof yamlSource !== "string" || yamlSource.trim().length === 0) {
      throw new Error("saveAgentDraft: yamlSource must be a non-empty string.");
    }
    if (!this.userAgentsDir) {
      throw new Error("saveAgentDraft: user-agents directory is not configured.");
    }

    const draft = validateAgentDraftSource(yamlSource, this.getReservedAgentSlugs());
    if (!draft.manifest || draft.validationErrors.length > 0) {
      throw new Error(
        `saveAgentDraft: manifest failed validation: ${draft.validationErrors.join("; ")}`,
      );
    }

    const manifest = draft.manifest;
    const slug = manifest.descriptor.id;
    const agentDir = safeUserAgentDirectory(this.userAgentsDir, slug);
    if (existsSync(agentDir)) {
      throw new Error(
        `saveAgentDraft: an agent named "${slug}" already exists in your user-agents directory.`,
      );
    }

    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "manifest.yaml"), `${draft.yamlSource.trimEnd()}\n`, "utf8");

    return this.getAppState();
  }

  async updateUserAgentDraft(slug: string, yamlSource: string): Promise<AppState> {
    if (!this.userAgentsDir) {
      throw new Error("updateUserAgentDraft: user-agents directory is not configured.");
    }
    const agentDir = safeUserAgentDirectory(this.userAgentsDir, slug);
    if (!existsSync(agentDir)) {
      throw new Error(`updateUserAgentDraft: "${slug}" is not a user-authored agent.`);
    }

    const draft = validateAgentDraftSource(yamlSource, this.getReservedAgentSlugs(slug));
    if (!draft.manifest || draft.validationErrors.length > 0) {
      throw new Error(
        `updateUserAgentDraft: manifest failed validation: ${draft.validationErrors.join("; ")}`,
      );
    }
    if (draft.manifest.descriptor.id !== slug) {
      throw new Error(
        `updateUserAgentDraft: descriptor.id must stay "${slug}". Use export if you want a new agent slug.`,
      );
    }

    await writeFile(join(agentDir, "manifest.yaml"), `${draft.yamlSource.trimEnd()}\n`, "utf8");

    const registryAgent = findRegistryAgentById(slug, this.userAgentsDir);
    if (registryAgent) {
      await this.serialize(async () => {
        const persisted = await this.read();
        await this.write({
          ...persisted,
          installedAgents: persisted.installedAgents.map((agent) => {
            if (agent.slug !== slug && agent.id !== slug) return agent;
            return {
              ...toInstalledAgent(registryAgent, agent.installedAt),
              settings: agent.settings,
              schedule: agent.schedule,
              delivery: agent.delivery,
              lastRunAt: agent.lastRunAt,
              communitySubmission: agent.communitySubmission,
              provenance: buildAgentProvenance({
                agent: registryAgent,
                installedAt: agent.installedAt,
                updatedAt: new Date().toISOString(),
                manifestText: draft.yamlSource,
                source: "user",
              }),
            };
          }),
        });
      });
    }

    return this.getAppState();
  }

  async exportAgentDraftBundle(
    yamlSource: string,
    parentDirectory: string,
  ): Promise<ExportAgentBundleResult> {
    const draft = validateAgentDraftSource(yamlSource, []);
    if (!draft.manifest || draft.validationErrors.length > 0) {
      throw new Error(
        `exportAgentDraftBundle: manifest failed validation: ${draft.validationErrors.join("; ")}`,
      );
    }

    const manifest = draft.manifest;
    assertValidAgentSlug(manifest.descriptor.id);
    const outputDir = join(parentDirectory, manifest.descriptor.id);
    if (existsSync(outputDir)) {
      throw new Error(`Export folder already exists: ${outputDir}`);
    }

    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "manifest.yaml"), `${draft.yamlSource.trimEnd()}\n`, "utf8");
    await writeFile(join(outputDir, "README.md"), buildAgentReadme(manifest), "utf8");
    await writeFile(
      join(outputDir, "metadata.json"),
      `${JSON.stringify(buildAgentBundleMetadata(manifest), null, 2)}\n`,
      "utf8",
    );

    return { canceled: false, directoryPath: outputDir };
  }

  async prepareAgentCommunitySubmission(
    yamlSource: string,
    metadata: AgentCommunitySubmissionMetadata,
    allowedSlug?: string,
  ): Promise<AgentCommunitySubmissionReview> {
    const draft = validateAgentDraftSource(
      yamlSource,
      this.getReservedAgentSlugs(allowedSlug),
    );
    return buildAgentCommunitySubmissionReview(yamlSource, metadata, draft);
  }

  async submitAgentCommunitySubmission(
    yamlSource: string,
    metadata: AgentCommunitySubmissionMetadata,
    allowedSlug?: string,
  ): Promise<AgentCommunitySubmissionResult> {
    const review = await this.prepareAgentCommunitySubmission(
      yamlSource,
      metadata,
      allowedSlug,
    );
    if (!review.ok) {
      throw new Error("Community submission is blocked until QA failures are fixed.");
    }
    if (this.statsApiUrl.length === 0) {
      throw new Error(
        "Community submission endpoint is not configured in this build.",
      );
    }

    const response = await fetch(
      `${this.statsApiUrl.replace(/\/$/, "")}/api/agent-submissions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          metadata,
          issueTitle: review.issueTitle,
          issueBody: review.issueBody,
          package: review.package,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );

    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const message =
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof parsed.error === "string"
          ? parsed.error
          : `Community submission failed with HTTP ${response.status}.`;
      throw new Error(message);
    }

    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("issueUrl" in parsed) ||
      typeof parsed.issueUrl !== "string"
    ) {
      throw new Error("Community submission endpoint returned an invalid response.");
    }

    const result = {
      issueUrl: parsed.issueUrl,
      ...("issueNumber" in parsed && typeof parsed.issueNumber === "number"
        ? { issueNumber: parsed.issueNumber }
        : {}),
    };

    const submittedSlug =
      allowedSlug ??
      review.package.manifestYaml.match(/^\s*id:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/m)?.[1];
    if (submittedSlug) {
      await this.serialize(async () => {
        const persisted = await this.read();
        await this.write({
          ...persisted,
          installedAgents: persisted.installedAgents.map((agent) =>
            agent.slug === submittedSlug || agent.id === submittedSlug
              ? {
                  ...agent,
                  communitySubmission: {
                    status: "submitted",
                    issueUrl: result.issueUrl,
                    ...("issueNumber" in result ? { issueNumber: result.issueNumber } : {}),
                    submittedAt: new Date().toISOString(),
                  },
                }
              : agent,
          ),
        });
      });
    }

    return result;
  }

  private getReservedAgentSlugs(allowedSlug?: string): string[] {
    const slugs = new Set<string>();
    for (const agent of this.listRegistryAgents()) {
      slugs.add(agent.slug);
      slugs.add(agent.id);
    }
    if (allowedSlug) {
      slugs.delete(allowedSlug);
    }
    return [...slugs].filter(Boolean).sort();
  }

  private isUserAuthoredRegistryPath(registryPath?: string): boolean {
    if (!registryPath || !this.userAgentsDir) return false;
    return registryPath
      .replace(/\\/g, "/")
      .startsWith(this.userAgentsDir.replace(/\\/g, "/"));
  }

  async uninstallAgent(slug: string): Promise<AppState> {
    let userAuthoredDir: string | undefined;
    let downloadedManifestDir: string | undefined;

    await this.serialize(async () => {
      const persisted = await this.read();
      const target = persisted.installedAgents.find(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (!target) {
        throw new Error(`Agent is not installed: ${slug}`);
      }

      // If the installed agent is sourced from the writable user-agents
      // directory, delete those files too. Bundled / monorepo agents
      // stay on disk and remain available in the registry.
      if (this.userAgentsDir && target.registryPath) {
        const normalized = target.registryPath.replace(/\\/g, "/");
        const root = this.userAgentsDir.replace(/\\/g, "/");
        if (normalized.startsWith(`${root}/`) || normalized === root) {
          userAuthoredDir = target.registryPath;
        }
      }
      const updatesRoot = this.agentUpdatesRoot();
      if (updatesRoot) {
        downloadedManifestDir = join(updatesRoot, target.slug);
      }

      await this.write({
        ...persisted,
        installedAgents: persisted.installedAgents.filter(
          (agent) => agent.slug !== target.slug && agent.id !== target.id,
        ),
      });
    });

    if (userAuthoredDir) {
      try {
        await rm(userAuthoredDir, { recursive: true, force: true });
      } catch (error) {
        console.error("[uninstall] failed to remove user-authored dir", error);
      }
    }
    if (downloadedManifestDir) {
      try {
        await rm(downloadedManifestDir, { recursive: true, force: true });
      } catch (error) {
        console.error("[uninstall] failed to remove downloaded manifest", error);
      }
    }

    return this.getAppState();
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    return this.runService.cancelRun(runId);
  }

  async installAgent(agentId: string): Promise<AppState> {
    let installedSlug: string | undefined;
    let installIdForReport: string | undefined;
    const initialCandidate = this.listRegistryAgents().find(
      (agent) =>
        agent.id === agentId ||
        agent.slug === agentId ||
        agent.registryId === agentId,
    );
    if (!initialCandidate) {
      throw new Error(`Unknown registry agent: ${agentId}`);
    }
    const downloaded = initialCandidate.manifestUrl
      ? await this.fetchAgentUpdateManifest(agentId, "installAgent")
      : undefined;

    await this.serialize(async () => {
      const persisted = await this.read();
      const existing = persisted.installedAgents.find(
        (agent) =>
          agent.id === agentId ||
          agent.slug === agentId ||
          agent.registryId === agentId,
      );

      if (existing) {
        return;
      }

      const registryAgent = downloaded?.target ?? initialCandidate;
      const compatibleRegistryAgent = withAgentCompatibility(
        registryAgent,
        this.appVersion,
      );
      assertAgentCompatible(compatibleRegistryAgent, "install");

      const registryInstallCountsEnabled =
        persisted.registryInstallCountsEnabled !== false;
      const installId = registryInstallCountsEnabled
        ? persisted.installId ?? randomUUID()
        : persisted.installId;

      const installedAt = new Date();
      const installed = toInstalledAgent(compatibleRegistryAgent, installedAt);
      installed.provenance = buildAgentProvenance({
        agent: compatibleRegistryAgent,
        installedAt: installed.installedAt,
        ...(downloaded
          ? {
              manifestText: downloaded.manifestText,
              manifestSha256: downloaded.manifestSha256,
            }
          : {}),
      });

      const commitState = () =>
        this.write({
          ...persisted,
          ...(installId ? { installId } : {}),
          installedAgents: [...persisted.installedAgents, installed],
        });
      if (downloaded) {
        await this.commitDownloadedAgentManifest(
          installed.slug,
          downloaded.manifestText,
          commitState,
        );
      } else {
        await commitState();
      }

      installedSlug = compatibleRegistryAgent.slug;
      installIdForReport = registryInstallCountsEnabled ? installId : undefined;
    });

    if (installedSlug && installIdForReport) {
      this.reportInstall(installedSlug, installIdForReport);
    }

    return this.getAppState();
  }

  /**
   * Attach `updateAvailable` to any installed agent whose registry version
   * is newer than what the user has. Pure function over the registry cache
   * — no I/O, no persistence, recomputed on every `getAppState()`. When
   * no match is found (e.g. an agent that was removed from the registry,
   * or a user-authored agent) the field is simply omitted.
   */
  private decorateInstalledWithUpdateInfo(
    installed: AgentSummary[],
    registry: RegistryAgentSummary[],
  ): AgentSummary[] {
    const bySlug = new Map<string, RegistryAgentSummary>();
    for (const entry of registry) {
      bySlug.set(entry.slug, entry);
      if (entry.id !== entry.slug) bySlug.set(entry.id, entry);
    }
    return installed.map((agent) => {
      const candidate = bySlug.get(agent.slug) ?? bySlug.get(agent.id);
      const compatibleAgent = withAgentCompatibility(
        {
          ...agent,
          minAppVersion:
            candidate?.minAppVersion ??
            agent.minAppVersion ??
            agent.provenance?.minAppVersion,
        },
        this.appVersion,
      );
      if (!candidate || !candidate.manifestUrl || !candidate.manifestSha256) {
        return compatibleAgent;
      }
      if (compareSemver(candidate.version, agent.version) <= 0) return compatibleAgent;
      return {
        ...compatibleAgent,
        updateAvailable: {
          version: candidate.version,
          manifestUrl: candidate.manifestUrl,
          manifestSha256: candidate.manifestSha256,
          minAppVersion: candidate.minAppVersion,
        },
      };
    });
  }

  /**
   * Apply an over-the-air update to a single installed agent. Fetches the
   * new manifest from the registry's `manifestUrl`, validates it against
   * the agent-template schema, persists the result to
   * `<userData>/agent-updates/<slug>/manifest.yaml`, and refreshes the
   * `installedAgents` entry with the registry-summary fields (version,
   * scopes, description, name, mode, category). User settings, schedule,
   * and `installedAt` are preserved; settings keys that no longer exist
   * in the new manifest are dropped silently. Failures (network, schema,
   * slug mismatch) throw with an actionable message and leave the
   * previously-installed manifest in place.
   */
  async getAgentUpdateReview(slug: string): Promise<AgentUpdateReview> {
    const { target, manifestText, parsedManifest, manifestSha256 } =
      await this.fetchAgentUpdateManifest(slug, "getAgentUpdateReview");
    const installed = (await this.read()).installedAgents.find(
      (agent) => agent.slug === slug || agent.id === slug,
    );
    if (!installed) {
      throw new Error(`getAgentUpdateReview: "${slug}" is not installed.`);
    }
    return buildAgentUpdateReview({
      previous: installed,
      target,
      parsedManifest,
      manifestText,
      manifestSha256,
    });
  }

  async updateAgent(
    slug: string,
    options?: { confirmTrustChanges?: boolean },
  ): Promise<AppState> {
    if (!this.userDataPath) {
      throw new Error(
        "updateAgent: userDataPath is not configured; cannot persist the updated manifest.",
      );
    }
    const { target, manifestText, parsedManifest, manifestSha256 } =
      await this.fetchAgentUpdateManifest(slug, "updateAgent");

    // Persist the new manifest under the override directory, atomically:
    // write to a tmp file first, then rename. Avoids a half-written file
    // if the process dies mid-write.
    // Reconcile `installedAgents`. Refresh the registry-derived fields
    // from `target`, keep user-controlled fields (settings, schedule,
    // installedAt) intact. Drop any settings keys the new manifest no
    // longer declares so we don't carry forward dead config silently.
    const declared = parsedManifest.definition.settings ?? [];
    const declaredIds = new Set(declared.map((s) => s.id));

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgent: "${slug}" is not installed.`);
      }
      const previous = persisted.installedAgents[idx];
      const review = buildAgentUpdateReview({
        previous,
        target,
        parsedManifest,
        manifestText,
        manifestSha256,
      });
      if (review.requiresConfirmation && options?.confirmTrustChanges !== true) {
        throw new Error(
          "updateAgent: this update changes agent trust boundaries. Review and confirm the changes before applying it.",
        );
      }

      // Persist the new manifest only after trust-boundary confirmation
      // has passed. Otherwise an unconfirmed update could still shadow the
      // installed manifest through the agent-updates override directory.
      // Prune any settings whose keys the new manifest no longer declares.
      // When the new manifest declares zero settings (or all previous keys
      // were dropped), we explicitly clear `settings` rather than spreading
      // it conditionally — otherwise `...previous` would leave the stale
      // settings object behind. Removing the key entirely keeps the
      // persisted JSON tidy.
      const prunedSettings = previous.settings
        ? Object.fromEntries(
            Object.entries(previous.settings).filter(([key]) => declaredIds.has(key)),
          )
        : {};
      const hasRemainingSettings = Object.keys(prunedSettings).length > 0;

      const { settings: _droppedPreviousSettings, ...previousWithoutSettings } = previous;
      const next: AgentSummary = {
        ...previousWithoutSettings,
        name: target.name,
        description: target.description,
        version: target.version,
        mode: target.mode,
        category: target.category,
        tier: target.tier ?? previous.tier,
        requiresEntraTier: target.requiresEntraTier ?? previous.requiresEntraTier,
        scopes: target.scopes,
        author: target.author,
        ...(hasRemainingSettings ? { settings: prunedSettings } : {}),
        provenance: buildAgentProvenance({
          agent: target,
          installedAt: previous.installedAt,
          updatedAt: new Date().toISOString(),
          manifestText,
          manifestSha256,
        }),
      };
      // `updateAvailable` is derived state — never persist it.
      delete next.updateAvailable;

      const installedAgents = [...persisted.installedAgents];
      installedAgents[idx] = next;
      await this.commitDownloadedAgentManifest(slug, manifestText, () =>
        this.write({ ...persisted, installedAgents }),
      );
    });

    return this.getAppState();
  }

  private async fetchAgentUpdateManifest(
    slug: string,
    context: "installAgent" | "getAgentUpdateReview" | "updateAgent",
  ): Promise<{
    target: RegistryAgentSummary;
    manifestText: string;
    parsedManifest: ReturnType<typeof parseAgentTemplate>;
    manifestSha256: string;
  }> {
    const registryAgents = this.listRegistryAgents();
    const target =
      registryAgents.find((entry) => entry.slug === slug || entry.id === slug);
    if (!target) {
      throw new Error(`${context}: agent "${slug}" is not in the registry.`);
    }
    if (!target.manifestUrl) {
      throw new Error(
        `${context}: agent "${slug}" has no manifestUrl; nothing to fetch.`,
      );
    }
    if (!target.manifestSha256 || !/^[a-f0-9]{64}$/.test(target.manifestSha256)) {
      throw new Error(
        `${context}: agent "${slug}" has no verified manifest digest; refresh the registry before updating.`,
      );
    }
    assertAgentCompatible(target, context === "updateAgent" ? "update" : "review");

    const FETCH_TIMEOUT_MS = 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let manifestText: string;
    try {
      const response = await fetch(target.manifestUrl, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${target.manifestUrl}`);
      }
      manifestText = await response.text();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`${context}: failed to fetch manifest — ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    let parsedManifest;
    try {
      parsedManifest = parseAgentTemplate(manifestText);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${context}: fetched manifest for "${slug}" is invalid — ${reason}`,
      );
    }
    if (parsedManifest.descriptor.id !== target.id) {
      throw new Error(
        `${context}: fetched manifest declares id "${parsedManifest.descriptor.id}" but registry expected "${target.id}".`,
      );
    }
    if (
      parsedManifest.descriptor.version !== target.version ||
      parsedManifest.descriptor.mode !== target.mode ||
      parsedManifest.descriptor.category !== target.category
    ) {
      throw new Error(
        `${context}: fetched manifest metadata does not match the verified registry entry.`,
      );
    }
    const manifestScopes = [...new Set(collectManifestScopes(parsedManifest))].sort();
    const registryScopes = [...new Set(target.scopes)].sort();
    if (JSON.stringify(manifestScopes) !== JSON.stringify(registryScopes)) {
      throw new Error(
        `${context}: fetched manifest Graph scopes do not match the verified registry entry.`,
      );
    }
    const manifestConnectorIds = (parsedManifest.descriptor.connectors ?? [])
      .map((connector) => connector.id)
      .sort();
    const registryConnectorIds = (target.connectors ?? [])
      .map((connector) => connector.id)
      .sort();
    if (JSON.stringify(manifestConnectorIds) !== JSON.stringify(registryConnectorIds)) {
      throw new Error(
        `${context}: fetched manifest connector access does not match the verified registry entry.`,
      );
    }

    const manifestSha256 = sha256(manifestText);
    if (manifestSha256 !== target.manifestSha256) {
      throw new Error(
        `${context}: fetched manifest digest did not match the verified registry index. The update was not applied.`,
      );
    }

    return {
      target,
      manifestText,
      parsedManifest,
      manifestSha256,
    };
  }

  private async commitDownloadedAgentManifest(
    slug: string,
    manifestText: string,
    commitState: () => Promise<void>,
  ): Promise<void> {
    const updatesRoot = this.agentUpdatesRoot();
    if (!updatesRoot) {
      throw new Error("Agent manifest storage is unavailable.");
    }
    const agentDir = join(updatesRoot, slug);
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    const finalPath = join(agentDir, "manifest.yaml");
    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    let previousManifest: string | undefined;
    try {
      previousManifest = await readFile(finalPath, "utf8");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }

    const normalized = manifestText.endsWith("\n")
      ? manifestText
      : `${manifestText}\n`;
    await writeFile(tmpPath, normalized, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(tmpPath, finalPath);
      try {
        await commitState();
      } catch (stateError) {
        if (previousManifest === undefined) {
          await rm(finalPath, { force: true });
        } else {
          const rollbackPath = `${finalPath}.${randomUUID()}.rollback`;
          await writeFile(rollbackPath, previousManifest, {
            encoding: "utf8",
            mode: 0o600,
          });
          await rename(rollbackPath, finalPath);
        }
        throw stateError;
      }
    } finally {
      await rm(tmpPath, { force: true });
    }
  }

  /**
   * Fire-and-forget POST to the stats aggregator. Never blocks the
   * install, never throws, never surfaces UI errors. We don't even
   * log non-2xx responses at info level — the desktop user has zero
   * leverage to act on them, and a 404 / 429 from this endpoint must
   * never feel like the install itself failed.
   *
   * User-authored agents (registry path outside the bundled tree)
   * never report — they don't exist in the public registry, so the
   * aggregator would reject the slug anyway.
   */
  private reportInstall(slug: string, installId: string): void {
    if (this.statsApiUrl.length === 0) return;
    if (this.userAgentsDir && this.isUserAuthoredSlug(slug)) return;

    const url = `${this.statsApiUrl.replace(/\/$/, "")}/api/install`;
    const body = JSON.stringify(createRegistryInstallCountPayload({
      slug,
      rawInstallId: installId,
      version: this.appVersion,
      platform: process.platform,
    }));
    void fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      // Keep the request bounded so a hung server doesn't keep the
      // socket alive forever.
      signal: AbortSignal.timeout(5_000),
    }).catch((error) => {
      // Intentionally swallow. Console-debug for the curious dev only.
      console.debug("[stats] report install failed:", error);
    });
  }

  private isUserAuthoredSlug(slug: string): boolean {
    if (!this.userAgentsDir) return false;
    const candidate = join(this.userAgentsDir, slug);
    return existsSync(candidate);
  }

  async setActiveProvider(id: ProviderId): Promise<AppState> {
    if (!isProviderId(id)) {
      throw new Error(`Unknown provider: ${String(id)}`);
    }

    await this.serialize(async () => {
      const persisted = await this.read();
      await this.write({
        ...persisted,
        activeProviderId: id,
      });
    });

    return this.getAppState();
  }

  async setActiveModel(
    providerId: ProviderId,
    model: string | null,
  ): Promise<AppState> {
    if (!isProviderId(providerId)) {
      throw new Error(`Unknown provider: ${String(providerId)}`);
    }
    if (model !== null) {
      if (typeof model !== "string" || model.trim().length === 0) {
        throw new Error("setActiveModel: model must be a non-empty string or null.");
      }
      // Validate that the model is one the provider actually has.
      const providers = await this.listProviders();
      const provider = providers.find((p) => p.id === providerId);
      if (!provider) {
        throw new Error(`Provider not found: ${providerId}`);
      }
      const known = provider.models ?? [];
      if (known.length > 0 && !known.includes(model)) {
        throw new Error(
          `Model "${model}" is not installed for ${provider.name}. Available: ${known.join(", ")}.`,
        );
      }
    }

    await this.serialize(async () => {
      const persisted = await this.read();
      const next = { ...(persisted.activeModelByProviderId ?? {}) };
      if (model === null) {
        delete next[providerId];
      } else {
        next[providerId] = model;
      }
      const cleaned = Object.keys(next).length > 0 ? next : undefined;
      const updated: PersistedState = {
        ...persisted,
        ...(cleaned ? { activeModelByProviderId: cleaned } : {}),
      };
      if (!cleaned) {
        delete updated.activeModelByProviderId;
      }
      await this.write(updated);
    });

    return this.getAppState();
  }

  async listTenants(): Promise<TenantRecord[]> {
    const persisted = await this.read();
    return persisted.tenants;
  }

  async hasConnectedTenant(): Promise<boolean> {
    const persisted = await this.read();
    return persisted.tenants.length > 0;
  }

  async hasEnabledSchedule(): Promise<boolean> {
    const persisted = await this.read();
    return persisted.installedAgents.some((agent) => agent.schedule?.enabled === true);
  }

  async hasEnabledBackgroundWork(): Promise<boolean> {
    const persisted = await this.read();
    if (persisted.installedAgents.some((agent) => agent.schedule?.enabled === true)) {
      return true;
    }
    if (!this.intelligenceStore) return false;
    return persisted.tenants.some(
      (tenant) =>
        this.intelligenceStore?.getGraphCacheRefreshSchedule(tenant.id).enabled === true,
    );
  }

  async getAgentSchedule(slug: string): Promise<AgentSchedule | undefined> {
    const persisted = await this.read();
    return persisted.installedAgents.find((agent) => agent.slug === slug)?.schedule;
  }

  async getSchedulerStatus() {
    const persisted = await this.read();
    return this.deriveSchedulerStatus(persisted);
  }

  private deriveSchedulerStatus(persisted: PersistedState) {
    const scheduledAgents = persisted.installedAgents.filter(
      (agent) => agent.schedule?.enabled === true,
    );
    const next = scheduledAgents
      .map((agent) => {
        const schedule = agent.schedule;
        const last = schedule?.lastScheduledRunAt
          ? new Date(schedule.lastScheduledRunAt).getTime()
          : scheduleFallbackAnchor(agent.installedAt, Date.now());
        return {
          agent,
          dueAt: last + (schedule?.intervalSeconds ?? 3600) * 1000,
        };
      })
      .sort((a, b) => a.dueAt - b.dueAt)[0];
    const scheduledRuns = persisted.runs.filter((run) => run.trigger === "schedule");
    const latestWake = scheduledRuns[0];
    const latestSuccess = scheduledRuns.find((run) => run.status === "completed");
    const latestFailureMessage = latestWake?.status === "failed"
      ? humanizeScheduledRunError(latestWake.error ?? latestWake.summary ?? "Scheduled run failed.")
      : undefined;
    return {
      supported: process.platform !== "linux",
      enabled: false,
      requiresTenant: persisted.tenants.length === 0,
      activeScheduleCount: scheduledAgents.length,
      ...(latestWake ? { lastWakeAt: latestWake.queuedAt } : {}),
      ...(latestSuccess?.finishedAt ? { lastSuccessAt: latestSuccess.finishedAt } : {}),
      ...(latestFailureMessage ? { lastError: latestFailureMessage } : {}),
      ...(next
        ? {
            nextDueAt: new Date(next.dueAt).toISOString(),
            nextDueAgentName: next.agent.name,
          }
        : {}),
    };
  }

  async listRequestedScopes(): Promise<RequestedScope[]> {
    // Strips the Graph resource prefix so the renderer can display the
    // bare scope name (e.g. "DeviceManagementManagedDevices.Read.All")
    // while the constant in msal.ts keeps the fully-qualified URI MSAL
    // requires.
    return DEFAULT_SCOPE_METADATA.map((scope) => ({
      name: scope.name,
      mode: scope.mode,
      rationale: scope.rationale,
    }));
  }

  async connectTenant(): Promise<AppState> {
    this.tenantConnectController?.abort();
    const controller = new AbortController();
    this.tenantConnectController = controller;
    const client = this.getMsalClient();
    let result;
    try {
      result = await runInteractiveFlow({
        client,
        openBrowser: this.openBrowser,
        signal: controller.signal,
        timeoutMs: 300_000,
      });
    } catch (error) {
      throw new Error(humanizeMsalError(error));
    } finally {
      if (this.tenantConnectController === controller) {
        this.tenantConnectController = undefined;
      }
    }

    if (!result.account) {
      throw new Error(
        "Microsoft sign-in did not return an account. Try connecting again from Settings → Tenants.",
      );
    }
    const account = result.account;
    const homeAccountId = account.homeAccountId;
    const displayName =
      account.tenantId && account.username
        ? account.username.split("@")[1] ?? account.tenantId
        : account.tenantId ?? "tenant";

    const tenantId = account.tenantId ?? homeAccountId;
    const addedAt = new Date().toISOString();
    const tenant: TenantRecord = {
      id: tenantId,
      homeAccountId,
      displayName,
      username: account.username,
      addedAt,
      lastUsedAt: addedAt,
    };

    await this.serialize(async () => {
      const persisted = await this.read();
      const existingIdx = persisted.tenants.findIndex((t) => t.id === tenant.id);
      const nextTenants = [...persisted.tenants];
      if (existingIdx >= 0) {
        nextTenants[existingIdx] = { ...nextTenants[existingIdx], ...tenant };
      } else {
        nextTenants.push(tenant);
      }
      await this.write({
        ...persisted,
        tenants: nextTenants,
        activeTenantId: tenant.id,
      });
    });

    // Background probe: detect the tenant's Entra ID tier so Agent Hub
    // can badge incompatible agents. Failure here is silent — `unknown`
    // is treated as informational (badges shown, runs not blocked).
    void this.probeEntraTier(tenant).catch(() => undefined);

    return this.getAppState();
  }

  cancelConnectTenant(): void {
    this.tenantConnectController?.abort();
    this.tenantConnectController = undefined;
  }

  /**
   * Fetch `/subscribedSkus` for the given tenant and persist the
   * detected Entra ID tier on the tenant record. Skipped if the last
   * probe succeeded within the past 24 hours (license states change
   * rarely). Best-effort — silent on failure.
   */
  /**
   * Fire a tenant tier probe for every persisted tenant. Do not call
   * this during app startup: MSAL token-cache reads can trigger the
   * macOS Keychain prompt before the user has taken an auth-related
   * action. Keep this behind explicit tenant or run flows.
   */
  async probeAllTenants(): Promise<void> {
    const persisted = await this.read().catch(() => null);
    if (!persisted) return;
    for (const tenant of persisted.tenants) {
      void this.probeEntraTier(tenant, { force: true }).catch(() => undefined);
    }
  }

  async probeEntraTier(
    tenant: TenantRecord,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const recent =
      tenant.entraTier &&
      tenant.entraTier !== "unknown" &&
      tenant.entraTierDetectedAt &&
      Date.now() - new Date(tenant.entraTierDetectedAt).getTime() < DAY_MS;
    // Re-probe even when recent if the licenses panel hasn't been
    // populated yet (migration from pre-license-panel persisted state).
    const licensesMissing = tenant.relevantLicenses === undefined;
    if (recent && !licensesMissing && !options.force) {
      return;
    }
    const client = this.getMsalClient();
    const openBrowser = this.openBrowser;
    const session = createTenantSession({
      client,
      tenantId: tenant.id,
      username: tenant.username,
      homeAccountId: tenant.homeAccountId,
      acquireInteractive: async (scopes) =>
        await runInteractiveFlow({ client, scopes, openBrowser }),
    });
    const result = await probeSubscribedSkus(
      (scopes) => session.acquireTokenForScopes(scopes),
    );
    const detected = result?.tier ?? "unknown";
    const relevantLicenses = result?.relevantLicenses ?? [];
    // Surface SKUs we recognise but couldn't map to a friendly name.
    // Lands in the dev log so we can grow RELEVANT_SKU_NAMES quickly
    // when Microsoft ships a new tier.
    if (result?.allSkuPartNumbers) {
      const surfaced = new Set(relevantLicenses.map((l) => l.skuPartNumber));
      const unmatched = result.allSkuPartNumbers.filter((p) => !surfaced.has(p));
      if (unmatched.length > 0) {
        console.log(
          `[probeEntraTier] ${tenant.displayName}: unmatched skuPartNumbers (add to RELEVANT_SKU_NAMES if these should appear in the Licenses panel):`,
          unmatched,
        );
      }
    }
    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.tenants.findIndex((t) => t.id === tenant.id);
      if (idx < 0) return;
      const next = [...persisted.tenants];
      next[idx] = {
        ...next[idx],
        entraTier: detected,
        entraTierDetectedAt: new Date().toISOString(),
        relevantLicenses,
      };
      await this.write({ ...persisted, tenants: next });
    });
  }

  async setActiveTenant(id: string): Promise<AppState> {
    await this.serialize(async () => {
      const persisted = await this.read();
      const exists = persisted.tenants.some((tenant) => tenant.id === id);
      if (!exists) {
        throw new Error(`Tenant not found: ${id}`);
      }
      await this.write({
        ...persisted,
        activeTenantId: id,
      });
    });
    return this.getAppState();
  }

  async disconnectTenant(id: string): Promise<AppState> {
    await this.serialize(async () => {
      const persisted = await this.read();
      const target = persisted.tenants.find((tenant) => tenant.id === id);
      if (target) {
        try {
          await removeAccount({
            client: this.getMsalClient(),
            homeAccountId: target.homeAccountId,
          });
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          throw new Error(
            `The Microsoft sign-in connection could not be removed, so local tenant deletion was not started. ${detail}`,
            { cause },
          );
        }
      }
      const nextTenants = persisted.tenants.filter((tenant) => tenant.id !== id);
      const removedRunIds = new Set(
        persisted.runs.filter((run) => run.tenantId === id).map((run) => run.id),
      );
      const next: PersistedState = {
        ...persisted,
        tenants: nextTenants,
        runs: persisted.runs.filter((run) => run.tenantId !== id),
      };
      const deliveryQueue = (persisted.runDeliveryQueue ?? []).filter(
        (item) => !removedRunIds.has(item.runId),
      );
      if (deliveryQueue.length > 0) next.runDeliveryQueue = deliveryQueue;
      else delete next.runDeliveryQueue;
      if (persisted.activeTenantId === id) {
        delete next.activeTenantId;
      }
      this.intelligenceStore?.purgeTenant(id);
      await this.write(next);
    });

    return this.getAppState();
  }

  async startRun(
    agentSlug: string,
    options: StartRunOptions = {},
  ): Promise<RunRecord> {
    return this.runService.startRun(agentSlug, options);
  }

  async confirmRun(runId: string, phrase: string): Promise<RunRecord> {
    return this.runService.confirmRun(runId, phrase);
  }

  async rejectRun(runId: string): Promise<RunRecord> {
    return this.runService.rejectRun(runId);
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    return this.runService.getRun(id);
  }

  private async buildLlm(
    providerId: ProviderId,
    model: string | undefined,
  ): Promise<RunLlmApi> {
    if (this.llmFactory) {
      return await this.llmFactory(providerId, model);
    }
    const providers = await this.listProviders();
    const provider = providers.find((entry) => entry.id === providerId);
    const providerReady =
      provider?.status === "connected" ||
      (provider?.id === "azure-openai" && provider.status === "available");
    if (!provider || !providerReady) {
      return noopLlm;
    }

    const defaultModel = model ?? provider.defaultModel ?? provider.models[0];
    if (providerId === "ollama") {
      const options: { defaultModel?: string } = {};
      if (defaultModel) {
        options.defaultModel = defaultModel;
      }
      return createOllamaLlm(options);
    }
    if (providerId === "apple-foundation") {
      return createAppleFoundationLlm({ defaultModel });
    }
    if (providerId === "lm-studio") {
      const options: { defaultModel?: string } = {};
      if (defaultModel) {
        options.defaultModel = defaultModel;
      }
      return createLmStudioLlm(options);
    }
    if (providerId === "anthropic") {
      return createClaudeCodeLlm({ defaultModel });
    }
    if (providerId === "openai") {
      return createCodexLlm({ defaultModel });
    }
    if (providerId === "azure-openai") {
      try {
        return createAzureOpenAiLlm(
          await this.azureOpenAIRuntimeOptions(defaultModel),
        );
      } catch {
        return noopLlm;
      }
    }
    return noopLlm;
  }

  private async azureOpenAIRuntimeOptions(defaultModel?: string): Promise<{
    endpoint: string;
    deployment: string;
    apiVersion: string;
    apiKey: string;
    defaultModel?: string;
  }> {
    const persisted = await this.read();
    const config = this.azureOpenAIConfigFromState(persisted);
    const apiKey = await this.providerSecretsFor("azure-openai").get("api-key");
    if (!config.endpoint || !config.deployment || !config.apiVersion || !apiKey) {
      throw new Error(
        "Azure OpenAI is not configured. Add your endpoint, deployment, API version, and key in Settings.",
      );
    }
    const options: {
      endpoint: string;
      deployment: string;
      apiVersion: string;
      apiKey: string;
      defaultModel?: string;
    } = {
      endpoint: config.endpoint,
      deployment: config.deployment,
      apiVersion: config.apiVersion,
      apiKey,
    };
    if (defaultModel) options.defaultModel = defaultModel;
    return options;
  }

  private async buildGraph(
    pinnedTenantId?: string,
    agentScopes?: string[],
  ): Promise<{
    createGraph: (
      log: (
        level: RunLogLevel,
        message: string,
        metadata?: Record<string, unknown>,
      ) => void,
    ) => RunGraphApi;
    tenantId: string;
    tenantSession: TenantSession;
  }> {
    const persisted = await this.read();
    const tenantId = pinnedTenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((t) => t.id === tenantId)
      : undefined;
    if (!tenant) {
      throw new Error(
        "No tenant connected. Connect a Microsoft 365 tenant before running agents.",
      );
    }
    const client = this.getMsalClient();
    const openBrowser = this.openBrowser;
    const tenantSession = createTenantSession({
      client,
      tenantId: tenant.id,
      username: tenant.username,
      homeAccountId: tenant.homeAccountId,
      acquireInteractive: async (scopes) => {
        // Per-capability incremental consent. Pops a browser sign-in when
        // a connector or agent requests scopes the cached refresh token
        // cannot satisfy. The user re-consents to the additional
        // scopes; subsequent silent acquisitions for the same scope set
        // succeed from cache.
        return await runInteractiveFlow({ client, scopes, openBrowser });
      },
    });
    // When the agent declares Graph scopes, route the tokenProvider
    // through `tenantSession.acquireTokenForScopes` so the silent
    // acquisition asks MSAL for those exact scopes and falls through to
    // interactive consent on the first run that requires a new one.
    // Connectors already do this for their declared scopes; agents now
    // get the same treatment.
    const scopes = (agentScopes ?? []).filter((s) => s.length > 0);
    const tokenProvider =
      scopes.length > 0
        ? async () => await tenantSession.acquireTokenForScopes(scopes)
        : async () => {
            const result = await acquireTokenSilent({
              client,
              homeAccountId: tenant.homeAccountId,
            });
            return result.accessToken;
          };
    return {
      createGraph: (log) => createGraphAdapter({ tokenProvider, log }),
      tenantId: tenant.id,
      tenantSession,
    };
  }

  private async persistRunSnapshot(run: RunRecord): Promise<void> {
    return this.runService.persistRunSnapshot(run);
  }

  async processPendingRunDeliveries(): Promise<void> {
    return this.runDeliveryService.processPendingRunDeliveries();
  }

  private async enqueueRunDeliveries(run: RunRecord): Promise<void> {
    return this.runDeliveryService.enqueueRunDeliveries(run);
  }

  private notifyRunFinished(run: RunRecord): void {
    if (!this.onRunFinished) return;
    try {
      this.onRunFinished(run);
    } catch (error) {
      console.error("[state] onRunFinished listener failed", error);
    }
  }

  private emitStateChanged(reason: string, runId?: string): void {
    try {
      this.onStateChanged?.({
        reason,
        ...(runId ? { runId } : {}),
      });
    } catch (error) {
      console.error("[state] onStateChanged listener failed", error);
    }
  }

  /**
   * Last successfully-parsed state, used as a safety net when a fresh
   * read fails to parse (e.g. the OS happened to schedule the read in
   * the middle of a partial `writeFile`). Without this cache, a parse
   * error caused `read()` to silently return `defaultState` — whose
   * empty `tenants` array tripped the routing gate in App.tsx and
   * bounced the user to /onboarding. The atomic rename in `write()`
   * makes the race impossible going forward, but the cache keeps us
   * robust against any future read-side surprises.
   */
  private lastReadSnapshot: PersistedState | undefined;

  private async read(): Promise<PersistedState> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.write(defaultState);
        this.lastReadSnapshot = defaultState;
        return defaultState;
      }
      // The file exists but couldn't be read (permission, IO error).
      // Return the last-known-good snapshot rather than fabricating
      // an empty state; if we have nothing cached, surface the error.
      if (this.lastReadSnapshot) {
        return this.lastReadSnapshot;
      }
      throw error;
    }
    let parsed: Partial<PersistedState>;
    try {
      parsed = JSON.parse(raw) as Partial<PersistedState>;
    } catch (error) {
      // Parse error on a non-empty file is almost always a transient
      // race against a writer. Return the last-known-good snapshot
      // (atomic rename in `write()` makes this branch rare but
      // possible during e.g. backups or hand-edits).
      if (this.lastReadSnapshot) {
        return this.lastReadSnapshot;
      }
      throw error;
    }
    {

      const tenants = Array.isArray(parsed.tenants) ? parsed.tenants : [];
      const activeTenantId =
        typeof parsed.activeTenantId === "string" &&
        tenants.some((tenant) => tenant.id === parsed.activeTenantId)
          ? parsed.activeTenantId
          : undefined;

      const state: PersistedState = {
        activeProviderId: isProviderId(parsed.activeProviderId)
          ? parsed.activeProviderId
          : defaultState.activeProviderId,
        installedAgents: Array.isArray(parsed.installedAgents)
          ? // 0.1.9: force-drop the legacy `retire-inactive-devices` slug.
            // The agent was renamed to `offboarding-agent`; we don't migrate
            // settings — users reinstall the new one fresh from the registry.
            parsed.installedAgents.filter(
              (agent) =>
                !(
                  agent &&
                  typeof agent === "object" &&
                  (
                    (agent as { slug?: unknown }).slug === "retire-inactive-devices" ||
                    (agent as { id?: unknown }).id === "retire-inactive-devices"
                  )
                ),
            )
          : defaultState.installedAgents,
        runs: Array.isArray(parsed.runs) ? parsed.runs : defaultState.runs,
        tenants,
      };
      if (activeTenantId) {
        state.activeTenantId = activeTenantId;
      }
      if (typeof parsed.installId === "string" && parsed.installId.length > 0) {
        state.installId = parsed.installId;
      }
      if (typeof parsed.registryInstallCountsEnabled === "boolean") {
        state.registryInstallCountsEnabled = parsed.registryInstallCountsEnabled;
      }
      if (typeof parsed.sandboxedCodeEnabled === "boolean") {
        state.sandboxedCodeEnabled = parsed.sandboxedCodeEnabled;
      }
      if (typeof parsed.registrySource === "string" && parsed.registrySource.length > 0) {
        try {
          state.registrySource = validateRegistrySource(parsed.registrySource, {
            allowDevSource: this.allowDevRegistrySource,
          }).sourceUrl;
        } catch {
          // Ignore invalid legacy state. New writes validate before persistence.
        }
      }
      const rawActiveModels = (parsed as { activeModelByProviderId?: unknown })
        .activeModelByProviderId;
      if (rawActiveModels && typeof rawActiveModels === "object" && !Array.isArray(rawActiveModels)) {
        const sanitized: Partial<Record<ProviderId, string>> = {};
        for (const [key, value] of Object.entries(rawActiveModels)) {
          if (isProviderId(key) && typeof value === "string" && value.length > 0) {
            sanitized[key] = value;
          }
        }
        if (Object.keys(sanitized).length > 0) {
          state.activeModelByProviderId = sanitized;
        }
      }
      const rawConnectors = (parsed as { connectors?: unknown }).connectors;
      if (
        rawConnectors &&
        typeof rawConnectors === "object" &&
        !Array.isArray(rawConnectors)
      ) {
        const sanitized: NonNullable<PersistedState["connectors"]> = {};
        for (const [id, entry] of Object.entries(rawConnectors)) {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
          const obj = entry as Record<string, unknown>;
          const config =
            obj.config && typeof obj.config === "object" && !Array.isArray(obj.config)
              ? (obj.config as Record<string, unknown>)
              : {};
          const cleaned: NonNullable<PersistedState["connectors"]>[string] = { config };
          if (
            obj.status === "connected" ||
            obj.status === "needs-setup" ||
            obj.status === "needs-scope" ||
            obj.status === "error" ||
            obj.status === "unknown"
          ) {
            cleaned.status = obj.status;
          }
          if (typeof obj.lastTestedAt === "string") {
            cleaned.lastTestedAt = obj.lastTestedAt;
          }
          if (typeof obj.lastTestMessage === "string") {
            cleaned.lastTestMessage = obj.lastTestMessage;
          }
          sanitized[id] = cleaned;
        }
        if (Object.keys(sanitized).length > 0) {
          state.connectors = sanitized;
        }
      }
      const rawProviderConfigs = (parsed as { providerConfigs?: unknown })
        .providerConfigs;
      if (
        rawProviderConfigs &&
        typeof rawProviderConfigs === "object" &&
        !Array.isArray(rawProviderConfigs)
      ) {
        const rawAzureOpenAI = (rawProviderConfigs as Record<string, unknown>)
          .azureOpenAI;
        if (
          rawAzureOpenAI &&
          typeof rawAzureOpenAI === "object" &&
          !Array.isArray(rawAzureOpenAI)
        ) {
          const obj = rawAzureOpenAI as Record<string, unknown>;
          state.providerConfigs = {
            azureOpenAI: {
              endpoint:
                typeof obj.endpoint === "string" ? obj.endpoint.trim() : "",
              deployment:
                typeof obj.deployment === "string" ? obj.deployment.trim() : "",
              apiVersion:
                typeof obj.apiVersion === "string" && obj.apiVersion.trim()
                  ? obj.apiVersion.trim()
                  : DEFAULT_AZURE_OPENAI_API_VERSION,
            },
          };
        }
      }
      const rawDeliveryQueue = (parsed as { runDeliveryQueue?: unknown })
        .runDeliveryQueue;
      if (Array.isArray(rawDeliveryQueue)) {
        const sanitizedQueue = rawDeliveryQueue
          .map((entry): RunDeliveryQueueItem | undefined => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
              return undefined;
            }
            const obj = entry as Record<string, unknown>;
            const connectorId =
              obj.connectorId === "teams" ||
              obj.connectorId === WHATSAPP_WEB_CONNECTOR_ID ||
              obj.connectorId === OUTLOOK_CONNECTOR_ID ||
              obj.connectorId === SLACK_CONNECTOR_ID ||
              obj.connectorId === DISCORD_CONNECTOR_ID ||
              obj.connectorId === SIGNAL_CONNECTOR_ID
                ? obj.connectorId
                : undefined;
            if (
              typeof obj.id !== "string" ||
              typeof obj.runId !== "string" ||
              !connectorId ||
              typeof obj.createdAt !== "string" ||
              typeof obj.nextAttemptAt !== "string"
            ) {
              return undefined;
            }
            const attempts =
              typeof obj.attempts === "number" &&
              Number.isFinite(obj.attempts) &&
              obj.attempts >= 0
                ? Math.floor(obj.attempts)
                : 0;
            return {
              id: obj.id,
              runId: obj.runId,
              connectorId,
              attempts,
              createdAt: obj.createdAt,
              nextAttemptAt: obj.nextAttemptAt,
              ...(typeof obj.lastAttemptAt === "string"
                ? { lastAttemptAt: obj.lastAttemptAt }
                : {}),
              ...(typeof obj.lastError === "string"
                ? { lastError: obj.lastError }
                : {}),
            };
          })
          .filter((entry): entry is RunDeliveryQueueItem => entry !== undefined);
        if (sanitizedQueue.length > 0) {
          state.runDeliveryQueue = sanitizedQueue;
        }
      }
      const rawRunHistoryRetention = (parsed as { runHistoryRetention?: unknown })
        .runHistoryRetention;
      if (isStateRecord(rawRunHistoryRetention)) {
        state.runHistoryRetention = this.normalizeRunHistoryRetentionSettings(
          rawRunHistoryRetention as unknown as RunHistoryRetentionSettings,
        );
      }
      const rawDriftRetention = (parsed as { driftRetentionDays?: unknown })
        .driftRetentionDays;
      if (
        isStateRecord(rawDriftRetention) ||
        typeof rawDriftRetention === "number" ||
        rawDriftRetention === "never"
      ) {
        state.driftRetentionDays = this.normalizeDriftRetentionSettings(
          rawDriftRetention as DriftRetentionSettings | number | "never",
        );
      }
      const rawLastRunHistoryPrune = (parsed as { lastRunHistoryPrune?: unknown })
        .lastRunHistoryPrune;
      if (isStateRecord(rawLastRunHistoryPrune)) {
        const obj = rawLastRunHistoryPrune;
        const trigger =
          obj.trigger === "startup" ||
          obj.trigger === "scheduler" ||
          obj.trigger === "manual"
            ? obj.trigger
            : undefined;
        const beforeCount = sanitizeNonNegativeInteger(obj.beforeCount);
        const afterCount = sanitizeNonNegativeInteger(obj.afterCount);
        const eligibleCount = sanitizeNonNegativeInteger(obj.eligibleCount);
        const prunedCount = sanitizeNonNegativeInteger(obj.prunedCount);
        const protectedCount = sanitizeNonNegativeInteger(obj.protectedCount);
        const protectedWorkspaceCount = sanitizeNonNegativeInteger(
          obj.protectedWorkspaceCount,
        );
        const protectedActiveCount = sanitizeNonNegativeInteger(
          obj.protectedActiveCount,
        );
        const protectedAwaitingConfirmationCount = sanitizeNonNegativeInteger(
          obj.protectedAwaitingConfirmationCount,
        );
        if (
          typeof obj.prunedAt === "string" &&
          trigger &&
          typeof obj.reason === "string" &&
          beforeCount !== undefined &&
          afterCount !== undefined &&
          eligibleCount !== undefined &&
          prunedCount !== undefined &&
          protectedCount !== undefined &&
          protectedWorkspaceCount !== undefined &&
          protectedActiveCount !== undefined &&
          protectedAwaitingConfirmationCount !== undefined
        ) {
          state.lastRunHistoryPrune = {
            prunedAt: obj.prunedAt,
            trigger,
            policy: isStateRecord(obj.policy)
              ? this.normalizeRunHistoryRetentionSettings(
                  obj.policy as unknown as RunHistoryRetentionSettings,
                )
              : this.normalizeRunHistoryRetentionSettings(
                  state.runHistoryRetention,
                ),
            beforeCount,
            afterCount,
            eligibleCount,
            prunedCount,
            protectedCount,
            protectedWorkspaceCount,
            protectedActiveCount,
            protectedAwaitingConfirmationCount,
            reason: obj.reason,
            ...(typeof obj.oldestPrunedQueuedAt === "string"
              ? { oldestPrunedQueuedAt: obj.oldestPrunedQueuedAt }
              : {}),
            ...(typeof obj.newestPrunedQueuedAt === "string"
              ? { newestPrunedQueuedAt: obj.newestPrunedQueuedAt }
              : {}),
          };
        }
      }
      const rawLastDriftHistoryPrune = (parsed as { lastDriftHistoryPrune?: unknown })
        .lastDriftHistoryPrune;
      if (isStateRecord(rawLastDriftHistoryPrune)) {
        const obj = rawLastDriftHistoryPrune;
        const trigger =
          obj.trigger === "startup" ||
          obj.trigger === "scheduler" ||
          obj.trigger === "manual"
            ? obj.trigger
            : undefined;
        const snapshotsDeleted = sanitizeNonNegativeInteger(obj.snapshotsDeleted);
        const versionsDeleted = sanitizeNonNegativeInteger(obj.versionsDeleted);
        if (
          typeof obj.prunedAt === "string" &&
          trigger &&
          typeof obj.reason === "string" &&
          snapshotsDeleted !== undefined &&
          versionsDeleted !== undefined
        ) {
          state.lastDriftHistoryPrune = {
            prunedAt: obj.prunedAt,
            trigger,
            policy: isStateRecord(obj.policy)
              ? this.normalizeDriftRetentionSettings(
                  obj.policy as unknown as DriftRetentionSettings,
                )
              : this.normalizeDriftRetentionSettings(state.driftRetentionDays),
            snapshotsDeleted,
            versionsDeleted,
            reason: obj.reason,
          };
        }
      }
      this.lastReadSnapshot = state;
      return state;
    }
  }

  /**
   * Atomic write: serialize the new state to a unique sibling temp file, then
   * `rename` it over `state.json`. Rename is atomic on every
   * filesystem we target (APFS, ext4, NTFS), so a concurrent reader
   * either sees the previous file content or the new one — never a
   * half-flushed JSON. Plain `writeFile` truncated first and was the
   * root cause of the "redirected to onboarding mid-action" bug.
   */
  private async write(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmpPath, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, this.filePath);
      this.lastReadSnapshot = state;
    } finally {
      await rm(tmpPath, { force: true });
    }
  }
}
