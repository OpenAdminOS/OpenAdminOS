import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  acquireTokenSilent,
  compareSemver,
  createGraphAdapter,
  classifyOllamaEndpoint,
  createCodexLlm,
  createAppleFoundationLlm,
  createMsalClient,
  createOllamaLlm,
  createRegistryInstallCountPayload,
  createQueuedRun,
  createTenantSession,
  DEFAULT_SCOPE_METADATA,
  probeSubscribedSkus,
  executeApply,
  executePlan,
  executeRun,
  findConnectorFactory,
  findRegistryAgentById,
  listAllRegistryAgents,
  listRegisteredConnectors,
  loadAgentManifestPreview,
  noSecrets,
  noopLlm,
  parseAgentTemplate,
  probeCodexLlm,
  probeAppleFoundationLlm,
  ManifestValidationError,
  removeAccount,
  resolveOllamaEndpoint,
  runInteractiveFlow,
  setAgentUpdatesDir,
  tenantSatisfiesRequirement,
  toInstalledAgent,
  type TokenCacheStorage,
} from "@openadminos/runtime";
import type {
  AgentDraft,
  AgentCommunitySubmissionMetadata,
  AgentCommunitySubmissionReview,
  AgentCommunitySubmissionResult,
  AgentDraftPreflightResult,
  ExportAgentBundleResult,
  AgentManifestPreview,
  AgentUpdateReview,
  AgentUpdateTrustChange,
  ConnectorSummary,
  ConnectorAuditEntry,
  RequestedScope,
  RunGraphApi,
  RunLlmApi,
  RunLogLevel,
  RunStepStatus,
  ProviderTestResult,
  StartRunOptions,
  AgentTemplate,
  TemplateSetting,
  TenantRecord,
  TenantSession,
  GraphCacheRefreshResult,
  GraphCacheRefreshResourceResult,
  GraphCacheRefreshScheduleSettings,
  GraphCacheResourceKind,
  GraphCacheResourceStatus,
  GraphCacheStatus,
  HostedProviderBatchConsent,
  ImportMultiTenantResultToWorkspacesInput,
  ImportMultiTenantResultToWorkspacesResult,
  CreateWorkspaceInput,
  IntuneChatConversation,
  IntuneChatMessage,
  IntuneChatProgressStep,
  IntuneChatStreamStage,
  IntuneChatStreamEvent,
  LocalDataSummary,
  MultiTenantAgentBatch,
  MultiTenantChatJob,
  MultiTenantChatRunResult,
  MultiTenantChatStreamEvent,
  MultiTenantDeviceRow,
  MultiTenantTenantComparison,
  PinWorkspaceEvidenceInput,
  PreflightMultiTenantChatInput,
  QueueMultiTenantAgentBatchInput,
  QueueMultiTenantAgentBatchResult,
  RefreshGraphCacheOptions,
  ResetSelfTrainingInput,
  RunMultiTenantChatInput,
  SavedMultiTenantQuery,
  SetGraphCacheRefreshScheduleInput,
  SelfTrainingSettings,
  SelfTrainingSuggestion,
  SelfTrainingSuggestionStatus,
  SendIntuneChatMessageInput,
  SendIntuneChatMessageResult,
  SecretAccessor,
  TenantGroup,
  TenantReadinessStatus,
  TenantScope,
  TenantScopePreflight,
  UpdateWorkspaceInput,
  WorkspaceDetail,
  WorkspaceEvidence,
  WorkspaceLink,
  WorkspaceNote,
  WorkspacePromptContextInput,
  WorkspacePromptContextSummary,
  WorkspaceSummary,
} from "@openadminos/agent-sdk";
import {
  ConnectorNotConfiguredError,
  ConnectorValidationError,
  deriveTrustState,
  providerCatalog,
  resolveProviderDefaultModel,
  resolveRunModel,
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
import { requestConnectorConfirmation } from "./connector-confirm-bridge.js";
import {
  searchEndpoints,
  validatePath,
  type EndpointSummary,
} from "./graph-catalog.js";

type WorkspacePromptContextPayload = {
  summary: WorkspacePromptContextSummary;
  promptBlock: string;
};

import {
  DEFAULT_REGISTRY_SOURCE,
  refreshRegistry,
  validateRegistrySource,
  type RegistryIndexEntry,
} from "./registry-client.js";
import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import {
  GRAPH_CACHE_RESOURCES,
  buildAnswerPack,
  chatTitleForPrompt,
  definitionForResource,
  matchAgentsToQuestion,
  pathForResource,
  planChatContext,
  requiredScopesForResources,
  selfTrainingCandidateFromPrompt,
  staleManagedDeviceSyncThresholdDays,
  thresholdIsoDaysBefore,
} from "./intune-chat/planner.js";

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
   * Durable, local queue for post-run connector delivery. Items are
   * enqueued when a run first reaches a terminal state and retried on
   * app startup / scheduler ticks if the previous process exited or a
   * transient connector failure occurred.
   */
  runDeliveryQueue?: RunDeliveryQueueItem[];
  /** User-overridable registry source URL. */
  registrySource?: string;
}

type RunDeliveryConnectorId =
  | "teams"
  | typeof WHATSAPP_WEB_CONNECTOR_ID
  | typeof OUTLOOK_CONNECTOR_ID
  | typeof SLACK_CONNECTOR_ID
  | typeof DISCORD_CONNECTOR_ID
  | typeof SIGNAL_CONNECTOR_ID;

interface RunDeliveryQueueItem {
  id: string;
  runId: string;
  connectorId: RunDeliveryConnectorId;
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastError?: string;
}

interface RunDeliveryResult {
  retryable: boolean;
  error?: string;
}

type GraphCacheRefreshProgressEvent =
  | {
      type: "resource-start";
      resource: GraphCacheResourceKind;
      label: string;
      completed: number;
      total: number;
    }
  | {
      type: "resource-complete";
      result: GraphCacheRefreshResourceResult;
      completed: number;
      total: number;
    };

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

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
  }>;
}

const defaultState: PersistedState = {
  activeProviderId: "ollama",
  installedAgents: [],
  runs: [],
  tenants: [],
};

const providerIds = new Set<ProviderId>(
  providerCatalog.map((provider) => provider.id),
);
const OUTLOOK_CONNECTOR_ID = "outlook" as const;
const SLACK_CONNECTOR_ID = "slack" as const;
const DISCORD_CONNECTOR_ID = "discord" as const;
const SIGNAL_CONNECTOR_ID = "signal" as const;
const RUN_DELIVERY_MAX_ATTEMPTS = 3;
const RUN_DELIVERY_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;

/**
 * Default stats aggregator URL. Constructor option `statsApiUrl` wins;
 * env var `OPENAGENTS_STATS_API` is the next fallback; otherwise the
 * official deployment URL. An empty string disables the POST entirely
 * — installs still complete locally, the count just doesn't flow to
 * the public stats file. main.ts passes `""` in dev so we don't
 * report dev installs to production.
 */
const DEFAULT_STATS_API_URL = "https://openadminos.com";
const AGENT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function entryToRegistrySummary(
  entry: RegistryIndexEntry,
  appVersion: string,
): RegistryAgentSummary {
  return withAgentCompatibility({
    id: entry.id,
    slug: entry.slug,
    registryId: entry.id,
    name: entry.name,
    description: entry.description,
    version: entry.version,
    mode: entry.mode,
    category: entry.category as RegistryAgentSummary["category"],
    tier: entry.tier,
    requiresEntraTier: entry.requiresEntraTier ?? "free",
    scopes: entry.scopes,
    author: entry.author,
    manifestUrl: entry.manifestUrl,
    minAppVersion: entry.minAppVersion,
    execution: entry.execution,
  }, appVersion);
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
  private readonly graphFactory: AppStateStoreOptions["graphFactory"] | undefined;
  private readonly llmFactory: AppStateStoreOptions["llmFactory"] | undefined;
  private readonly whatsAppWebClientFactory:
    | AppStateStoreOptions["whatsAppWebClientFactory"]
    | undefined;
  private readonly connectorSecretsForOverride:
    | AppStateStoreOptions["connectorSecretsFor"]
    | undefined;
  private readonly connectorSecretStore: SafeStorageConnectorSecretStore | undefined;
  private readonly allowDevRegistrySource: boolean;
  private msalClient: PublicClientApplication | undefined;
  // Soft-cancel set. While a run id is here, progress snapshots from
  // the runtime are dropped so the run stays in "cancelled" state. The
  // background driver eventually returns; we don't (yet) plumb an
  // AbortSignal through the runtime to interrupt it mid-flight.
  private readonly cancelledRunIds = new Set<string>();
  private whatsappWebClientInstance: WhatsAppWebClientLike | undefined;
  private deliveryQueueProcessing: Promise<void> | undefined;

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
      this.llmFactory = undefined;
      this.whatsAppWebClientFactory = undefined;
      this.connectorSecretsForOverride = undefined;
      this.connectorSecretStore = undefined;
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
      this.llmFactory = options.llmFactory;
      this.whatsAppWebClientFactory = options.whatsAppWebClientFactory;
      this.connectorSecretsForOverride = options.connectorSecretsFor;
      this.connectorSecretStore = options.userDataPath
        ? new SafeStorageConnectorSecretStore(
            join(options.userDataPath, "connectors", "secrets"),
          )
        : undefined;
      this.allowDevRegistrySource = options.allowDevRegistrySource === true;
    }
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

  private async maybeCreateSelfTrainingSuggestionFromChat(input: {
    tenantId: string;
    question: string;
    agentSuggestions: NonNullable<IntuneChatMessage["agentSuggestions"]>;
  }): Promise<void> {
    const store = this.requireIntelligenceStore();
    const settings = store.getSelfTrainingSettings();
    if (!settings.enabled) return;
    const candidate = selfTrainingCandidateFromPrompt(input);
    if (!candidate) return;
    const now = new Date().toISOString();
    const id = stableSuggestionId(input.tenantId, candidate.agentSlug, candidate.text);
    store.recordLearningEvent({
      id: `event_${randomUUID()}`,
      tenantId: input.tenantId,
      agentSlug: candidate.agentSlug,
      eventType: "chat.preference-detected",
      source: "chat",
      payload: { question: input.question, candidate },
      createdAt: now,
    });
    store.createSelfTrainingSuggestion({
      id,
      tenantId: input.tenantId,
      agentSlug: candidate.agentSlug,
      status: "pending",
      text: candidate.text,
      reason: candidate.reason,
      source: "chat",
      createdAt: now,
    });
  }

  private async writeSelfTrainingFile(
    tenantId: string,
    agentSlug: string,
  ): Promise<void> {
    if (!this.userDataPath) return;
    const store = this.requireIntelligenceStore();
    const accepted = store.listAcceptedSelfTrainingSuggestions({ tenantId, agentSlug });
    const tenantKey = hashTenantId(tenantId);
    const dir = join(
      this.userDataPath,
      "agent-learning",
      "tenants",
      tenantKey,
      "agents",
      agentSlug,
    );
    await mkdir(dir, { recursive: true });
    const updatedAt = new Date().toISOString();
    const yaml = buildSelfTrainingYaml({
      agentSlug,
      tenantKey,
      updatedAt,
      suggestions: accepted,
    });
    await writeFile(join(dir, "self-training.yaml"), yaml, "utf8");
  }

  private selfTrainingPromptOverlay(tenantId: string, agentSlug: string): string | undefined {
    if (!this.intelligenceStore) return undefined;
    const settings = this.intelligenceStore.getSelfTrainingSettings();
    if (!settings.enabled) return undefined;
    const accepted = this.intelligenceStore.listAcceptedSelfTrainingSuggestions({
      tenantId,
      agentSlug,
    });
    if (accepted.length === 0) return undefined;
    return [
      "Approved local self-training instructions for this tenant and agent:",
      ...accepted.map((entry, index) => `${index + 1}. ${entry.text}`),
      "These instructions may guide reasoning and wording only. They do not change scopes, write mode, connector egress, or confirmation policy.",
    ].join("\n");
  }

  private recordLearningEventSafely(input: {
    tenantId?: string;
    agentSlug?: string;
    eventType: string;
    source: string;
    payload: unknown;
  }): void {
    if (!this.intelligenceStore || !input.tenantId) return;
    try {
      this.intelligenceStore.recordLearningEvent({
        id: `event_${randomUUID()}`,
        tenantId: input.tenantId,
        agentSlug: input.agentSlug,
        eventType: input.eventType,
        source: input.source,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn("[self-training] failed to record learning event", error);
    }
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
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

  async listProviders(): Promise<ProviderSummary[]> {
    return Promise.all(
      providerCatalog.map(async (provider) => {
        if (provider.id === "ollama") return checkOllama(provider);
        if (provider.id === "apple-foundation") return checkAppleFoundation(provider);
        if (provider.id === "openai") return checkCodex(provider);
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
    if (provider.status !== "connected") {
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
    return this.requireIntelligenceStore().listConversations();
  }

  async searchIntuneChatConversations(query: string): Promise<IntuneChatConversation[]> {
    return this.requireIntelligenceStore().searchConversations(query);
  }

  async renameIntuneChatConversation(
    conversationId: string,
    title: string,
  ): Promise<IntuneChatConversation> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    const normalizedTitle = normalizeChatConversationTitle(title);
    return this.requireIntelligenceStore().renameConversation(
      conversationId,
      normalizedTitle,
      new Date().toISOString(),
    );
  }

  async setIntuneChatConversationPinned(
    conversationId: string,
    pinned: boolean,
  ): Promise<IntuneChatConversation> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    return this.requireIntelligenceStore().setConversationPinned(
      conversationId,
      pinned,
      new Date().toISOString(),
    );
  }

  async deleteIntuneChatConversation(conversationId: string): Promise<void> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    this.requireIntelligenceStore().deleteConversation(conversationId);
  }

  async getIntuneChatMessages(conversationId: string): Promise<IntuneChatMessage[]> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    return this.requireIntelligenceStore().listMessages(conversationId);
  }

  async listTenantGroups(): Promise<TenantGroup[]> {
    return this.requireIntelligenceStore().listTenantGroups();
  }

  async saveTenantGroup(input: {
    id?: string;
    name: string;
    tenantIds: string[];
  }): Promise<TenantGroup> {
    const persisted = await this.read();
    const knownTenantIds = new Set(persisted.tenants.map((tenant) => tenant.id));
    const tenantIds = [...new Set(input.tenantIds)].filter((tenantId) => {
      if (!knownTenantIds.has(tenantId)) {
        throw new Error(`Tenant group includes an unknown tenant: ${tenantId}`);
      }
      return true;
    });
    const name = normalizeTenantGroupName(input.name);
    return this.requireIntelligenceStore().saveTenantGroup({
      id: input.id?.trim() || `tgrp_${randomUUID()}`,
      name,
      tenantIds,
      now: new Date().toISOString(),
    });
  }

  async deleteTenantGroup(id: string): Promise<void> {
    if (!id.trim()) throw new Error("Tenant group id is required.");
    this.requireIntelligenceStore().deleteTenantGroup(id);
  }

  async listSavedMultiTenantQueries(): Promise<SavedMultiTenantQuery[]> {
    return this.requireIntelligenceStore().listSavedMultiTenantQueries();
  }

  async preflightMultiTenantIntuneChat(
    input: PreflightMultiTenantChatInput,
  ): Promise<TenantScopePreflight> {
    return this.buildMultiTenantPreflight(input);
  }

  async runMultiTenantIntuneChat(
    input: RunMultiTenantChatInput,
    onEvent?: (event: MultiTenantChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<MultiTenantChatRunResult> {
    const content = input.prompt.trim();
    if (!content) throw new Error("Multi-tenant chat prompt is required.");
    const store = this.requireIntelligenceStore();
    const persisted = await this.read();
    const preflight = await this.buildMultiTenantPreflight(input);
    const providers = await this.listProviders();
    const activeTenant = this.resolveTenant(persisted);
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    this.requireHostedBatchConsent(input.hostedProviderConsent, preflight, provider, providerId);

    const now = new Date().toISOString();
    const jobId = `mtjob_${randomUUID()}`;
    let job: MultiTenantChatJob = {
      id: jobId,
      prompt: content,
      ...(input.savedQueryId ? { savedQueryId: input.savedQueryId } : {}),
      tenantScope: preflight.tenantScope,
      resolvedTenantIds: preflight.resolvedTenantIds,
      providerId,
      providerName: preflight.providerName,
      providerIsLocal: preflight.providerIsLocal,
      ...(preflight.model ? { model: preflight.model } : {}),
      status: "running",
      createdAt: now,
      updatedAt: now,
      preflight,
      progress: preflight.tenants.map((tenant) => ({
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        status:
          tenant.status === "expired" ||
          tenant.status === "missing-scopes" ||
          tenant.status === "throttled" ||
          tenant.status === "failed"
            ? "skipped"
            : "queued",
        detail: tenant.recovery,
        updatedAt: now,
      })),
      summary: emptyMultiTenantSummary(),
      comparisons: [],
      deviceRows: [],
      assistantText: "",
      exportDossierMarkdown: "",
    };
    const persistJob = (eventType: "started" | "progress" = "progress") => {
      store.upsertMultiTenantJob(job);
      onEvent?.({ type: eventType, job });
    };
    const assertNotCancelled = () => {
      if (options.signal?.aborted !== true) return;
      job = {
        ...job,
        status: "cancelled",
        error: "Stopped by user.",
        updatedAt: new Date().toISOString(),
      };
      store.upsertMultiTenantJob(job);
      onEvent?.({ type: "cancelled", job });
      throw new Error("Multi-tenant chat run stopped.");
    };
    persistJob("started");

    const runnable = preflight.tenants.filter(
      (tenant) =>
        tenant.selected &&
        tenant.status !== "expired" &&
        tenant.status !== "missing-scopes" &&
        tenant.status !== "throttled" &&
        tenant.status !== "failed" &&
        tenant.status !== "skipped",
    );
    const refreshTenant = async (tenant: (typeof runnable)[number]) => {
      const startedAt = new Date().toISOString();
      job = updateJobTenantProgress(job, tenant.tenantId, {
        status: input.refreshIfStale === false ? "reading-cache" : "refreshing-cache",
        detail:
          input.refreshIfStale === false
            ? "Reading existing local cache."
            : "Refreshing prompt-relevant cache.",
        updatedAt: startedAt,
      });
      persistJob();
      try {
        assertNotCancelled();
        if (input.refreshIfStale !== false && tenant.staleResources.length > 0) {
          const refreshResult = await this.refreshGraphCacheInternal({
            tenantId: tenant.tenantId,
            resources: tenant.staleResources,
          });
          const failedResources = refreshResult.resources.filter((resource) => !resource.ok);
          if (
            failedResources.some((resource) => resource.resource === "managedDevices") ||
            failedResources.length === refreshResult.resources.length
          ) {
            throw new Error(
              failedResources
                .map(
                  (resource) =>
                    `${resource.label}: ${resource.error ?? "Graph cache refresh failed."}`,
                )
                .join("; "),
            );
          }
        }
        job = updateJobTenantProgress(job, tenant.tenantId, {
          status: "building-result",
          detail: "Computing tenant result from local cache.",
          updatedAt: new Date().toISOString(),
        });
        persistJob();
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        job = updateJobTenantProgress(job, tenant.tenantId, {
          status: "failed",
          detail: message,
          updatedAt: new Date().toISOString(),
        });
        persistJob();
      }
    };
    assertNotCancelled();
    await runWithConcurrency(runnable, 2, refreshTenant);
    assertNotCancelled();

    const comparisons: MultiTenantTenantComparison[] = [];
    const deviceRows: MultiTenantDeviceRow[] = [];
    for (const tenant of preflight.tenants) {
      if (!tenant.selected) continue;
      const failedProgress = job.progress.find(
        (entry) => entry.tenantId === tenant.tenantId && entry.status === "failed",
      );
      if (failedProgress) {
        comparisons.push({
          tenantId: tenant.tenantId,
          tenantName: tenant.tenantName,
          status: "failed",
          windowsDevices: 0,
          compliant: 0,
          nonCompliant: 0,
          unknown: 0,
          lastRefresh: tenant.cacheFreshness,
          warnings: [...tenant.warnings, failedProgress.detail ?? "Tenant refresh failed."],
        });
        continue;
      }
      if (!runnable.some((entry) => entry.tenantId === tenant.tenantId)) {
        comparisons.push({
          tenantId: tenant.tenantId,
          tenantName: tenant.tenantName,
          status: tenant.status,
          windowsDevices: 0,
          compliant: 0,
          nonCompliant: 0,
          unknown: 0,
          lastRefresh: tenant.cacheFreshness,
          warnings: tenant.warnings,
        });
        continue;
      }
      const tenantRows = store.readManagedDeviceRowsForTenant({
        tenantId: tenant.tenantId,
        limit: 10_000,
      });
      const normalizedRows = tenantRows
        .map((entry) =>
          normalizeMultiTenantDeviceRow({
            row: entry.row,
            tenantId: tenant.tenantId,
            tenantName: tenant.tenantName,
            sourceRefreshedAt: entry.refreshedAt,
          }),
        )
        .filter((row): row is MultiTenantDeviceRow => Boolean(row));
      const windowsRows = normalizedRows.filter((row) =>
        row.operatingSystem.toLowerCase().includes("windows"),
      );
      deviceRows.push(...windowsRows);
      comparisons.push(buildTenantComparison({
        tenant,
        rows: windowsRows,
      }));
      job = updateJobTenantProgress(job, tenant.tenantId, {
        status: "ready",
        detail: `${windowsRows.length.toLocaleString()} Windows device rows prepared.`,
        updatedAt: new Date().toISOString(),
      });
      persistJob();
    }

    const summary = buildMultiTenantSummary(comparisons);
    const assistantText = await this.buildMultiTenantAssistantText({
      prompt: content,
      providerId,
      provider,
      model: preflight.model,
      summary,
      comparisons,
    });
    const exportDossierMarkdown = buildMultiTenantDossierMarkdown({
      prompt: content,
      providerName: preflight.providerName,
      model: preflight.model,
      generatedAt: new Date().toISOString(),
      summary,
      comparisons,
      rows: deviceRows,
    });
    const finalStatus =
      comparisons.some((comparison) =>
        ["failed", "expired", "missing-scopes", "throttled", "skipped"].includes(
          comparison.status,
        ),
      )
        ? "partial"
        : "completed";
    job = {
      ...job,
      status: finalStatus,
      summary,
      comparisons,
      deviceRows,
      assistantText,
      exportDossierMarkdown,
      updatedAt: new Date().toISOString(),
    };

    const conversation = store.createConversation({
      id: `chat_${randomUUID()}`,
      title: chatTitleForPrompt(content),
      tenantId: activeTenant.id,
      now,
      scopeKind: "multi-tenant",
      tenantScope: preflight.tenantScope,
      multiTenantJobId: job.id,
    });
    job = { ...job, conversationId: conversation.id, updatedAt: new Date().toISOString() };
    persistJob();
    const userMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "user",
      content,
      status: "completed",
      createdAt: now,
    };
    const assistantMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "assistant",
      content: assistantText,
      status: finalStatus === "completed" || finalStatus === "partial" ? "completed" : "failed",
      createdAt: new Date().toISOString(),
      providerId,
      ...(preflight.model ? { model: preflight.model } : {}),
      sources: [
        {
          resource: "managedDevices",
          label: "Intune managed devices",
          rows: deviceRows.length,
          source: "cache",
          path: "/deviceManagement/managedDevices",
        },
      ],
    };
    store.insertMessage(userMessage);
    store.insertMessage(assistantMessage);
    store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);

    const result = {
      job,
      conversation: store.getConversation(conversation.id) ?? conversation,
      userMessage,
      assistantMessage,
    };
    onEvent?.({ type: "completed", result });
    return result;
  }

  async streamMultiTenantIntuneChat(
    input: RunMultiTenantChatInput,
    onEvent: (event: MultiTenantChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<MultiTenantChatRunResult> {
    try {
      return await this.runMultiTenantIntuneChat(input, onEvent, options);
    } catch (caught) {
      if (options.signal?.aborted !== true) {
        onEvent({
          type: "failed",
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
      throw caught;
    }
  }

  private buildWorkspacePromptContext(
    input: WorkspacePromptContextInput,
    tenantId: string,
    persisted: PersistedState,
  ): WorkspacePromptContextPayload {
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) throw new Error("Workspace context requires a workspace id.");
    const store = this.requireIntelligenceStore();
    const workspace = store.getWorkspace(workspaceId, tenantNamesById(persisted.tenants));
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (workspace.tenantId !== tenantId) {
      throw new Error("Workspace context tenant does not match the active chat tenant.");
    }

    const selectedEvidenceIds = new Set(input.evidenceIds ?? []);
    const selectedNoteIds = new Set(input.noteIds ?? []);
    const evidence =
      selectedEvidenceIds.size > 0
        ? workspace.evidence.filter((entry) => selectedEvidenceIds.has(entry.id))
        : [];
    const notes =
      selectedNoteIds.size > 0
        ? workspace.notes.filter((entry) => selectedNoteIds.has(entry.id))
        : [];
    const includesInstructions =
      input.includeInstructions === true && Boolean(workspace.instructions?.trim());

    if (!includesInstructions && evidence.length === 0 && notes.length === 0) {
      throw new Error("Select workspace evidence, notes, or instructions before attaching context.");
    }

    const missingEvidence = [...selectedEvidenceIds].filter(
      (id) => !workspace.evidence.some((entry) => entry.id === id),
    );
    const missingNotes = [...selectedNoteIds].filter(
      (id) => !workspace.notes.some((entry) => entry.id === id),
    );
    if (missingEvidence.length > 0 || missingNotes.length > 0) {
      throw new Error("Workspace context includes evidence or notes that no longer exist.");
    }

    const lines = [
      "Workspace context attached by the admin.",
      `Workspace: ${workspace.title}`,
      `Tenant: ${workspace.tenantName ?? workspace.tenantId}`,
    ];
    if (includesInstructions && workspace.instructions) {
      lines.push("", "Workspace instructions:", workspace.instructions.trim());
    }
    if (notes.length > 0) {
      lines.push("", "Workspace notes:");
      notes.slice(0, 12).forEach((note, index) => {
        lines.push(`${index + 1}. ${trimForPrompt(note.content, 1400)}`);
      });
    }
    if (evidence.length > 0) {
      lines.push("", "Workspace evidence:");
      evidence.slice(0, 8).forEach((entry, index) => {
        lines.push(
          `${index + 1}. ${entry.title} (${entry.sourceType}, ${entry.createdAt})`,
          trimForPrompt(JSON.stringify(entry.content, null, 2), 2800),
        );
      });
    }

    return {
      summary: {
        workspaceId: workspace.id,
        workspaceTitle: workspace.title,
        tenantId: workspace.tenantId,
        evidenceCount: evidence.length,
        noteCount: notes.length,
        includesInstructions,
      },
      promptBlock: lines.join("\n"),
    };
  }

  async listMultiTenantChatJobs(): Promise<MultiTenantChatJob[]> {
    return this.requireIntelligenceStore().listMultiTenantJobs();
  }

  async getMultiTenantChatJob(id: string): Promise<MultiTenantChatJob | undefined> {
    if (!id.trim()) throw new Error("Multi-tenant job id is required.");
    return this.requireIntelligenceStore().getMultiTenantJob(id);
  }

  async queueMultiTenantAgentBatch(
    input: QueueMultiTenantAgentBatchInput,
  ): Promise<QueueMultiTenantAgentBatchResult> {
    const agentSlug = input.agentSlug.trim();
    if (!agentSlug) throw new Error("Agent slug is required.");
    const store = this.requireIntelligenceStore();
    const persisted = await this.read();
    const agent = persisted.installedAgents.find((entry) => entry.slug === agentSlug);
    if (!agent) {
      throw new Error(`Agent is not installed: ${agentSlug}`);
    }
    assertAgentCompatible(withAgentCompatibility(agent, this.appVersion), "run");

    const prompt =
      input.prompt?.trim() || `Run ${agent.name} against the selected tenant scope.`;
    const preflight = await this.buildMultiTenantPreflight({
      prompt,
      tenantScope: input.tenantScope,
      ...(input.savedQueryId ? { savedQueryId: input.savedQueryId } : {}),
    });
    const runnable = preflight.tenants.filter(
      (tenant) =>
        tenant.selected &&
        tenant.status !== "expired" &&
        tenant.status !== "missing-scopes" &&
        tenant.status !== "throttled" &&
        tenant.status !== "failed" &&
        tenant.status !== "skipped",
    );
    if (runnable.length === 0) {
      throw new Error("No selected tenants are ready for this agent batch.");
    }

    const now = new Date().toISOString();
    let batch: MultiTenantAgentBatch = {
      id: `mtbatch_${randomUUID()}`,
      agentSlug: agent.slug,
      agentName: agent.name,
      agentMode: agent.mode,
      tenantScope: preflight.tenantScope,
      resolvedTenantIds: runnable.map((tenant) => tenant.tenantId),
      status: "queued",
      runIds: [],
      createdAt: now,
      updatedAt: now,
      preflight,
    };
    store.upsertMultiTenantAgentBatch(batch);

    const runs: RunRecord[] = [];
    const failures: string[] = [];
    for (const tenant of runnable) {
      try {
        const run = await this.startRun(agent.slug, {
          tenantId: tenant.tenantId,
          trigger: "manual",
        });
        runs.push(run);
        batch = {
          ...batch,
          status: agent.mode === "write" ? "awaiting-confirmation" : "running",
          runIds: runs.map((entry) => entry.id),
          updatedAt: new Date().toISOString(),
        };
        store.upsertMultiTenantAgentBatch(batch);
      } catch (caught) {
        failures.push(
          `${tenant.tenantName}: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }

    const finalStatus =
      failures.length === 0
        ? agent.mode === "write"
          ? "awaiting-confirmation"
          : "running"
        : runs.length > 0
          ? "partial"
          : "failed";
    batch = {
      ...batch,
      status: finalStatus,
      runIds: runs.map((entry) => entry.id),
      ...(failures.length > 0 ? { error: failures.join("; ") } : {}),
      updatedAt: new Date().toISOString(),
    };
    store.upsertMultiTenantAgentBatch(batch);
    return { batch, runs };
  }

  async listMultiTenantAgentBatches(): Promise<MultiTenantAgentBatch[]> {
    return this.requireIntelligenceStore().listMultiTenantAgentBatches();
  }

  async getMultiTenantAgentBatch(
    id: string,
  ): Promise<MultiTenantAgentBatch | undefined> {
    if (!id.trim()) throw new Error("Multi-tenant agent batch id is required.");
    return this.requireIntelligenceStore().getMultiTenantAgentBatch(id);
  }

  private async buildMultiTenantPreflight(
    input: PreflightMultiTenantChatInput,
  ): Promise<TenantScopePreflight> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Multi-tenant chat prompt is required.");
    const store = this.requireIntelligenceStore();
    const persisted = await this.read();
    const activeTenant = this.resolveTenant(persisted);
    if (persisted.tenants.length === 0) {
      throw new Error("Connect at least one tenant before using multi-tenant Intune Chat.");
    }
    const groups = store.listTenantGroups();
    const resolvedGroups = resolveTenantGroups(input.tenantScope, groups);
    const resolvedTenantIds = resolveTenantScopeIds({
      scope: input.tenantScope,
      groups: resolvedGroups,
      tenants: persisted.tenants,
      activeTenantId: activeTenant.id,
    });
    const selectedTenantSet = new Set(resolvedTenantIds);
    const savedQuery = input.savedQueryId
      ? store
          .listSavedMultiTenantQueries()
          .find((query) => query.id === input.savedQueryId)
      : undefined;
    const planned = planChatContext(prompt);
    const resourceSet = new Set<GraphCacheResourceKind>([
      ...planned.resources,
      ...(savedQuery?.resourceHints ?? []),
    ]);
    if (isWindowsCompliancePrompt(prompt)) {
      resourceSet.add("managedDevices");
    }
    const resources = sanitizeGraphResources([...resourceSet]);
    const requiredScopes = requiredScopesForResources(resources);
    const providers = await this.listProviders();
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    const model = resolveProviderDefaultModel(
      provider,
      persisted.activeModelByProviderId,
    ).model;
    const now = new Date().toISOString();
    const tenants = persisted.tenants
      .filter((tenant) => selectedTenantSet.has(tenant.id))
      .map((tenant) => {
        const statusRows = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
        const relevantStatus = statusRows.filter((status) =>
          resources.includes(status.resource),
        );
        const staleResources = relevantStatus
          .filter((status) => isGraphCacheStatusStale(status))
          .map((status) => status.resource);
        const cacheFreshness = newestRefreshedAt(relevantStatus);
        const errors = relevantStatus
          .map((status) => status.lastError)
          .filter((error): error is string => Boolean(error));
        const missingScopes = errors.some((error) => /scope|consent|permission/i.test(error))
          ? requiredScopes
          : [];
        const status = tenantReadinessStatus({
          missingScopes,
          staleResources,
          errors,
          hasRows: relevantStatus.some((entry) => entry.rows > 0),
        });
        return {
          tenantId: tenant.id,
          tenantName: tenant.displayName,
          username: tenant.username,
          status,
          selected: true,
          cacheFreshness,
          staleResources,
          missingScopes,
          warnings: readinessWarnings({ status, staleResources, errors }),
          recovery: readinessRecovery(status),
        };
      });
    return {
      id: `preflight_${randomUUID()}`,
      prompt,
      tenantScope: input.tenantScope,
      resolvedTenantIds,
      resolvedGroups,
      resources,
      providerId,
      providerName: provider?.name ?? providerId,
      providerIsLocal: provider?.isLocal !== false,
      ...(model ? { model } : {}),
      generatedAt: now,
      tenants,
      canRun:
        tenants.length > 0 &&
        tenants.some((tenant) =>
          tenant.status === "ready" || tenant.status === "stale",
        ),
    };
  }

  private requireHostedBatchConsent(
    consent: HostedProviderBatchConsent | undefined,
    preflight: TenantScopePreflight,
    provider: ProviderSummary | undefined,
    providerId: ProviderId,
  ): void {
    if (provider?.isLocal !== false) return;
    if (!consent) {
      throw new Error(
        "Hosted provider confirmation is required before multi-tenant chat can send tenant context to the selected provider.",
      );
    }
    if (consent.providerId !== providerId) {
      throw new Error("Hosted provider confirmation does not match the selected provider.");
    }
    const expected = new Set(preflight.resolvedTenantIds);
    const acknowledged = new Set(consent.tenantIds);
    for (const tenantId of expected) {
      if (!acknowledged.has(tenantId)) {
        throw new Error("Hosted provider confirmation does not cover every selected tenant.");
      }
    }
    const acknowledgedAt = Date.parse(consent.acknowledgedAt);
    const now = Date.now();
    if (
      !Number.isFinite(acknowledgedAt) ||
      now - acknowledgedAt > 5 * 60 * 1000 ||
      acknowledgedAt - now > 60 * 1000
    ) {
      throw new Error("Hosted provider confirmation expired. Confirm the batch again.");
    }
  }

  private async buildMultiTenantAssistantText(input: {
    prompt: string;
    providerId: ProviderId;
    provider: ProviderSummary | undefined;
    model?: string;
    summary: MultiTenantChatJob["summary"];
    comparisons: MultiTenantChatJob["comparisons"];
  }): Promise<string> {
    const deterministic = summarizeMultiTenantResult(input.summary, input.comparisons);
    const llm = await this.buildLlm(input.providerId, input.model);
    if (!llm.available) return deterministic;
    try {
      const completion = await llm.complete({
        system: buildIntuneChatSystemPrompt(input.provider?.isLocal === true),
        prompt: [
          "Summarize this read-only multi-tenant Intune Chat result for an admin.",
          "The JSON table is the source of truth. Mention partial, failed, skipped, or stale tenants.",
          `Question: ${input.prompt}`,
          JSON.stringify(
            {
              summary: input.summary,
              tenants: input.comparisons,
            },
            null,
            2,
          ),
        ].join("\n\n"),
        ...(input.model ? { model: input.model } : {}),
        temperature: 0.2,
        maxTokens: 700,
      });
      return completion.text.trim() || deterministic;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${deterministic}\n\nThe selected LLM provider failed while summarizing this multi-tenant result. ${message}`;
    }
  }

  async getGraphCacheStatus(tenantId?: string): Promise<GraphCacheStatus> {
    const persisted = await this.read();
    const resolvedTenant = this.resolveTenant(persisted, tenantId);
    const store = this.requireIntelligenceStore();
    return {
      tenantId: resolvedTenant.id,
      resources: store.getGraphCacheStatus(
        resolvedTenant.id,
        [...GRAPH_CACHE_RESOURCES],
      ),
      schedule: store.getGraphCacheRefreshSchedule(resolvedTenant.id),
    };
  }

  async getGraphCacheRefreshSchedule(
    tenantId?: string,
  ): Promise<GraphCacheRefreshScheduleSettings> {
    const persisted = await this.read();
    const resolvedTenant = this.resolveTenant(persisted, tenantId);
    return this.requireIntelligenceStore().getGraphCacheRefreshSchedule(
      resolvedTenant.id,
    );
  }

  async setGraphCacheRefreshSchedule(
    input: SetGraphCacheRefreshScheduleInput,
  ): Promise<GraphCacheRefreshScheduleSettings> {
    const persisted = await this.read();
    const resolvedTenant = this.resolveTenant(persisted, input.tenantId);
    const intervalMinutes =
      typeof input.intervalMinutes === "number" && Number.isFinite(input.intervalMinutes)
        ? input.intervalMinutes
        : 360;
    return this.requireIntelligenceStore().setGraphCacheRefreshSchedule({
      tenantId: resolvedTenant.id,
      enabled: input.enabled,
      intervalMinutes,
      now: new Date().toISOString(),
    });
  }

  async getLocalDataSummary(tenantId?: string): Promise<LocalDataSummary> {
    const persisted = await this.read();
    const resolvedTenant =
      tenantId || persisted.activeTenantId
        ? this.resolveTenant(persisted, tenantId)
        : undefined;
    return this.requireIntelligenceStore().getLocalDataSummary({
      tenantId: resolvedTenant?.id,
      definitions: resolvedTenant ? [...GRAPH_CACHE_RESOURCES] : undefined,
    });
  }

  async clearIntuneChatHistory(): Promise<LocalDataSummary> {
    this.requireIntelligenceStore().clearChatHistory();
    return this.getLocalDataSummary();
  }

  async clearGraphCache(tenantId?: string): Promise<LocalDataSummary> {
    const persisted = await this.read();
    const resolvedTenant = this.resolveTenant(persisted, tenantId);
    this.requireIntelligenceStore().clearGraphCache(resolvedTenant.id);
    return this.getLocalDataSummary(resolvedTenant.id);
  }

  async refreshGraphCache(
    options: RefreshGraphCacheOptions = {},
  ): Promise<GraphCacheRefreshResult> {
    return this.refreshGraphCacheInternal(options);
  }

  private async refreshGraphCacheInternal(
    options: RefreshGraphCacheOptions = {},
    onProgress?: (event: GraphCacheRefreshProgressEvent) => void,
  ): Promise<GraphCacheRefreshResult> {
    const store = this.requireIntelligenceStore();
    const persisted = await this.read();
    const tenant = this.resolveTenant(persisted, options.tenantId);
    const resources = sanitizeGraphResources(options.resources);
    const scopes = requiredScopesForResources(resources);
    const startedAt = new Date().toISOString();
    const log = (level: RunLogLevel, message: string, metadata?: Record<string, unknown>) => {
      console.info("[intune-chat][graph]", level, message, metadata ?? "");
    };
    const graph = this.graphFactory
      ? this.graphFactory({ tenantId: tenant.id, scopes, log })
      : (await this.buildGraph(tenant.id, scopes)).createGraph(log);
    const results: GraphCacheRefreshResult["resources"] = [];

    for (const resource of resources) {
      const definition = definitionForResource(resource);
      const request = pathForResource(resource);
      const refreshedAt = new Date().toISOString();
      onProgress?.({
        type: "resource-start",
        resource,
        label: definition.label,
        completed: results.length,
        total: resources.length,
      });
      try {
        const query: Record<string, string> = { ...(request.query ?? {}) };
        if (request.select && request.select.length > 0) {
          query.$select = request.select.join(",");
        }
        const pageResult = await fetchGraphCachePages(graph, {
          path: request.path,
          query,
          headers: request.headers,
        });
        store.replaceGraphResources({
          tenantId: tenant.id,
          resource,
          label: definition.label,
          scopeSet: definition.scopes,
          rows: pageResult.rows,
          pageCount: pageResult.pages,
          pageLimitReached: pageResult.pageLimitReached,
          refreshedAt,
        });
        results.push({
          resource,
          label: definition.label,
          rows: pageResult.rows.length,
          pages: pageResult.pages,
          pageLimitReached: pageResult.pageLimitReached,
          refreshedAt,
          ok: true,
        });
        onProgress?.({
          type: "resource-complete",
          result: results.at(-1)!,
          completed: results.length,
          total: resources.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        store.recordGraphResourceError({
          tenantId: tenant.id,
          resource,
          label: definition.label,
          scopeSet: definition.scopes,
          error: message,
          now: refreshedAt,
        });
        results.push({
          resource,
          label: definition.label,
          rows: 0,
          refreshedAt,
          ok: false,
          error: message,
        });
        onProgress?.({
          type: "resource-complete",
          result: results.at(-1)!,
          completed: results.length,
          total: resources.length,
        });
      }
    }

    return {
      tenantId: tenant.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      resources: results,
    };
  }

  async sendIntuneChatMessage(
    input: SendIntuneChatMessageInput,
  ): Promise<SendIntuneChatMessageResult> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Chat message must not be empty.");
    }

    const store = this.requireIntelligenceStore();
    const persisted = await this.read();
    const tenant = this.resolveTenant(persisted);
    const providers = await this.listProviders();
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    const selectedModel = resolveProviderDefaultModel(
      provider,
      persisted.activeModelByProviderId,
    ).model;
    const chatBudget = intuneChatProviderBudget(providerId);
    const workspaceContext = input.workspaceContext
      ? this.buildWorkspacePromptContext(input.workspaceContext, tenant.id, persisted)
      : undefined;
    this.requireHostedChatConsent(
      input,
      tenant,
      provider,
      providerId,
      workspaceContext?.summary,
    );
    const planned = planChatContext(content);
    const now = new Date().toISOString();

    let conversation = input.conversationId
      ? store.getConversation(input.conversationId)
      : undefined;
    if (conversation) {
      assertConversationTenant(conversation, tenant.id);
    }
    if (!conversation) {
      conversation = store.createConversation({
        id: `chat_${randomUUID()}`,
        title: chatTitleForPrompt(content),
        tenantId: tenant.id,
        now,
      });
    }

    const userMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "user",
      content,
      status: "completed",
      createdAt: now,
    };
    store.insertMessage(userMessage);

    let refreshResult: GraphCacheRefreshResult | undefined;
    if (input.refreshIfStale !== false) {
      const before = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const staleResources = planned.resources.filter((resource) => {
        const status = before.find((entry) => entry.resource === resource);
        if (!status || status.rows === 0 || !status.refreshedAt) return true;
        return Date.now() - new Date(status.refreshedAt).getTime() > 6 * 60 * 60 * 1000;
      });
      if (staleResources.length > 0) {
        refreshResult = await this.refreshGraphCache({
          tenantId: tenant.id,
          resources: staleResources,
        });
        store.insertToolCall({
          id: `tool_${randomUUID()}`,
          conversationId: conversation.id,
          messageId: userMessage.id,
          type: "graph-cache-refresh",
          status: refreshResult.resources.some((resource) => resource.ok)
            ? "completed"
            : "failed",
          createdAt: now,
          completedAt: refreshResult.finishedAt,
          input: { resources: staleResources },
          output: refreshResult,
        });
      }
    }

    const cacheStatus = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
    const answerGeneratedAt = new Date().toISOString();
    const rows = readPlannedChatRows(store, {
      tenantId: tenant.id,
      question: content,
      generatedAt: answerGeneratedAt,
      resources: planned.resources,
      searchTerms: planned.searchTerms,
      limitPerResource: chatBudget.limitPerResource,
    });
    const agentSuggestions = matchAgentsToQuestion(content, persisted.installedAgents);
    const refreshedResources = new Set(
      refreshResult?.resources
        .filter((resource) => resource.ok)
        .map((resource) => resource.resource) ?? [],
    );
    const sources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: planned.resources,
      refreshedResources,
    });

    const llm = await this.buildLlm(providerId, selectedModel);
    let assistantContent: string;
    let assistantStatus: IntuneChatMessage["status"] = "completed";
    let assistantError: string | undefined;

    if (!llm.available) {
      assistantStatus = "failed";
      assistantError =
        "No LLM provider is connected. Start Ollama or choose another provider in Settings, then try again.";
      assistantContent = assistantError;
    } else {
      const modelQuestion = workspaceContext
        ? `${content}\n\n${workspaceContext.promptBlock}`
        : content;
      const answerPack = buildAnswerPack({
        question: modelQuestion,
        tenant,
        cacheStatus,
        rows,
        hasWriteIntent: planned.hasWriteIntent,
        agentSuggestions,
        generatedAt: answerGeneratedAt,
        limits: chatBudget.answerPackLimits,
      });
      try {
        const completion = await llm.complete({
          system: buildIntuneChatSystemPrompt(provider?.isLocal === true),
          prompt: `Use this retrieved tenant context to answer the admin.\n\n${answerPack}`,
          temperature: 0.2,
          maxTokens: chatBudget.maxTokens,
        });
        assistantContent = completion.text.trim();
        if (planned.hasWriteIntent) {
          assistantContent = `${assistantContent}\n\nI cannot perform tenant changes directly from chat. Use an installed write agent so the existing plan and confirmation flow stays in force.`;
        }
        if (agentSuggestions.length > 0) {
          assistantContent = `${assistantContent}\n\nDetected matching agent: ${agentSuggestions[0]?.agentName}.`;
        }
      } catch (caught) {
        assistantStatus = "failed";
        assistantError = caught instanceof Error ? caught.message : String(caught);
        assistantContent = `The selected LLM provider failed while answering this chat message. ${assistantError}`;
      }
    }

    const assistantMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "assistant",
      content: assistantContent,
      status: assistantStatus,
      createdAt: new Date().toISOString(),
      providerId,
      model: selectedModel,
      sources,
      agentSuggestions,
      ...(assistantError ? { error: assistantError } : {}),
    };
    store.insertMessage(assistantMessage);
    store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);

    await this.maybeCreateSelfTrainingSuggestionFromChat({
      tenantId: tenant.id,
      question: content,
      agentSuggestions,
    });

    return {
      conversation: store.getConversation(conversation.id) ?? conversation,
      userMessage,
      assistantMessage,
      cacheStatus: {
        tenantId: tenant.id,
        resources: cacheStatus,
        schedule: store.getGraphCacheRefreshSchedule(tenant.id),
      },
    };
  }

  async streamIntuneChatMessage(
    input: SendIntuneChatMessageInput,
    onEvent: (event: IntuneChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<SendIntuneChatMessageResult> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Chat message must not be empty.");
    }

    const store = this.requireIntelligenceStore();
    const persisted = await this.read();
    const tenant = this.resolveTenant(persisted);
    const providers = await this.listProviders();
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    const selectedModel = resolveProviderDefaultModel(
      provider,
      persisted.activeModelByProviderId,
    ).model;
    const chatBudget = intuneChatProviderBudget(providerId);
    const workspaceContext = input.workspaceContext
      ? this.buildWorkspacePromptContext(input.workspaceContext, tenant.id, persisted)
      : undefined;
    this.requireHostedChatConsent(
      input,
      tenant,
      provider,
      providerId,
      workspaceContext?.summary,
    );
    const planned = planChatContext(content);
    const now = new Date().toISOString();

    let conversation = input.conversationId
      ? store.getConversation(input.conversationId)
      : undefined;
    if (conversation) {
      assertConversationTenant(conversation, tenant.id);
    }
    if (!conversation) {
      conversation = store.createConversation({
        id: `chat_${randomUUID()}`,
        title: chatTitleForPrompt(content),
        tenantId: tenant.id,
        now,
      });
    }

    const userMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "user",
      content,
      status: "completed",
      createdAt: now,
    };
    store.insertMessage(userMessage);

    const assistantId = `msg_${randomUUID()}`;
    const pendingAssistant: IntuneChatMessage = {
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      providerId,
      ...(selectedModel ? { model: selectedModel } : {}),
    };
    const initialCacheStatus: GraphCacheStatus = {
      tenantId: tenant.id,
      resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
      schedule: store.getGraphCacheRefreshSchedule(tenant.id),
    };
    onEvent({
      type: "started",
      conversation,
      userMessage,
      assistantMessage: pendingAssistant,
      cacheStatus: initialCacheStatus,
    });
    const isCancelled = () => options.signal?.aborted === true;
    const finishCancelled = (): SendIntuneChatMessageResult => {
      const cancelledAt = new Date().toISOString();
      const currentCacheStatus = store.getGraphCacheStatus(tenant.id, [
        ...GRAPH_CACHE_RESOURCES,
      ]);
      const assistantMessage: IntuneChatMessage = {
        id: assistantId,
        conversationId: conversation.id,
        role: "assistant",
        content: "Response stopped by user before a final answer was saved.",
        status: "cancelled",
        createdAt: cancelledAt,
        providerId,
        ...(selectedModel ? { model: selectedModel } : {}),
        sources: buildIntuneChatSources({
          cacheStatus: currentCacheStatus,
          plannedResources: planned.resources,
          refreshedResources: new Set(),
        }),
        error: "Stopped by user.",
      };
      store.insertMessage(assistantMessage);
      store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);
      return {
        conversation: store.getConversation(conversation.id) ?? conversation,
        userMessage,
        assistantMessage,
        cacheStatus: {
          tenantId: tenant.id,
          resources: currentCacheStatus,
          schedule: store.getGraphCacheRefreshSchedule(tenant.id),
        },
      };
    };

    if (isCancelled()) {
      const result = finishCancelled();
      onEvent({ type: "cancelled", result });
      return result;
    }

    let refreshResult: GraphCacheRefreshResult | undefined;
    let progressRefreshResources: GraphCacheResourceKind[] = [];
    let progressRefreshResults: GraphCacheRefreshResourceResult[] = [];
    let progressActiveResource: GraphCacheResourceKind | undefined;
    const sendProgress = (input: {
      message: string;
      stage: IntuneChatStreamStage;
      cacheCheckStatus?: IntuneChatProgressStep["status"];
      contextStatus?: IntuneChatProgressStep["status"];
      modelStatus?: IntuneChatProgressStep["status"];
      cacheStatus?: GraphCacheStatus;
    }) => {
      const progressSteps = buildChatProgressSteps({
        refreshResources: progressRefreshResources,
        refreshResults: progressRefreshResults,
        activeResource: progressActiveResource,
        cacheCheckStatus: input.cacheCheckStatus ?? "completed",
        contextStatus: input.contextStatus ?? "pending",
        modelStatus: input.modelStatus ?? "pending",
      });
      onEvent({
        type: "status",
        conversationId: conversation.id,
        message: input.message,
        stage: input.stage,
        progressSteps,
        progressPercent: estimateChatProgressPercent(progressSteps),
        ...(input.cacheStatus ? { cacheStatus: input.cacheStatus } : {}),
      });
    };
    sendProgress({
      message: "Checking cached tenant data.",
      stage: "checking-cache",
      cacheCheckStatus: "active",
    });

    if (input.refreshIfStale !== false) {
      const before = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const staleResources = planned.resources.filter((resource) => {
        const status = before.find((entry) => entry.resource === resource);
        if (!status || status.rows === 0 || !status.refreshedAt) return true;
        return Date.now() - new Date(status.refreshedAt).getTime() > 6 * 60 * 60 * 1000;
      });
      progressRefreshResources = staleResources;
      if (staleResources.length > 0) {
        sendProgress({
          message: `Refreshing ${staleResources.length} tenant data source${staleResources.length === 1 ? "" : "s"} before answering.`,
          stage: "refreshing-cache",
        });
        refreshResult = await this.refreshGraphCacheInternal(
          {
            tenantId: tenant.id,
            resources: staleResources,
          },
          (event) => {
            if (event.type === "resource-start") {
              progressActiveResource = event.resource;
              sendProgress({
                message: `Refreshing ${event.label}.`,
                stage: "refreshing-cache",
              });
              return;
            }
            progressActiveResource = undefined;
            progressRefreshResults = [...progressRefreshResults, event.result];
            sendProgress({
              message: event.result.ok
                ? `Cached ${event.result.label}.`
                : `Could not refresh ${event.result.label}.`,
              stage: "refreshing-cache",
            });
          },
        );
        store.insertToolCall({
          id: `tool_${randomUUID()}`,
          conversationId: conversation.id,
          messageId: userMessage.id,
          type: "graph-cache-refresh",
          status: refreshResult.resources.some((resource) => resource.ok)
            ? "completed"
            : "failed",
          createdAt: now,
          completedAt: refreshResult.finishedAt,
          input: { resources: staleResources },
          output: refreshResult,
        });
        sendProgress({
          message: "Building answer context from local cache.",
          stage: "building-context",
          contextStatus: "active",
          cacheStatus: {
            tenantId: tenant.id,
            resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
            schedule: store.getGraphCacheRefreshSchedule(tenant.id),
          },
        });
      } else {
        sendProgress({
          message: "Using cached tenant context.",
          stage: "building-context",
          contextStatus: "active",
        });
      }
    }
    if (isCancelled()) {
      const result = finishCancelled();
      sendProgress({
        message: "Response stopped.",
        stage: "failed",
        contextStatus: "completed",
        modelStatus: "failed",
        cacheStatus: result.cacheStatus,
      });
      onEvent({ type: "cancelled", result });
      return result;
    }

    const cacheStatus = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
    const answerGeneratedAt = new Date().toISOString();
    const rows = readPlannedChatRows(store, {
      tenantId: tenant.id,
      question: content,
      generatedAt: answerGeneratedAt,
      resources: planned.resources,
      searchTerms: planned.searchTerms,
      limitPerResource: chatBudget.limitPerResource,
    });
    const agentSuggestions = matchAgentsToQuestion(content, persisted.installedAgents);
    const refreshedResources = new Set(
      refreshResult?.resources
        .filter((resource) => resource.ok)
        .map((resource) => resource.resource) ?? [],
    );
    const sources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: planned.resources,
      refreshedResources,
    });

    const llm = await this.buildLlm(providerId, selectedModel);
    let assistantContent = "";
    let assistantStatus: IntuneChatMessage["status"] = "completed";
    let assistantError: string | undefined;
    let responseModel = selectedModel;

    if (!llm.available) {
      assistantStatus = "failed";
      assistantError =
        "No LLM provider is connected. Start Ollama or choose another provider in Settings, then try again.";
      assistantContent = assistantError;
    } else {
      const modelQuestion = workspaceContext
        ? `${content}\n\n${workspaceContext.promptBlock}`
        : content;
      const answerPack = buildAnswerPack({
        question: modelQuestion,
        tenant,
        cacheStatus,
        rows,
        hasWriteIntent: planned.hasWriteIntent,
        agentSuggestions,
        generatedAt: answerGeneratedAt,
        limits: chatBudget.answerPackLimits,
      });
      try {
        sendProgress({
          message: "Model response started.",
          stage: "generating-answer",
          contextStatus: "completed",
          modelStatus: "active",
          cacheStatus: {
            tenantId: tenant.id,
            resources: cacheStatus,
            schedule: store.getGraphCacheRefreshSchedule(tenant.id),
          },
        });
        for await (const chunk of llm.stream({
          system: buildIntuneChatSystemPrompt(provider?.isLocal === true),
          prompt: `Use this retrieved tenant context to answer the admin.\n\n${answerPack}`,
          ...(selectedModel ? { model: selectedModel } : {}),
          temperature: 0.2,
          maxTokens: chatBudget.maxTokens,
          signal: options.signal,
        })) {
          if (isCancelled()) {
            break;
          }
          responseModel = chunk.model;
          assistantContent = chunk.accumulated;
          onEvent({
            type: "delta",
            conversationId: conversation.id,
            assistantMessageId: assistantId,
            delta: chunk.delta,
            content: assistantContent,
            providerId,
            model: responseModel,
          });
        }
        assistantContent = assistantContent.trim();
        if (planned.hasWriteIntent) {
          assistantContent = `${assistantContent}\n\nI cannot perform tenant changes directly from chat. Use an installed write agent so the existing plan and confirmation flow stays in force.`;
        }
        if (agentSuggestions.length > 0) {
          assistantContent = `${assistantContent}\n\nDetected matching agent: ${agentSuggestions[0]?.agentName}.`;
        }
        onEvent({
          type: "delta",
          conversationId: conversation.id,
          assistantMessageId: assistantId,
          delta: "",
          content: assistantContent,
          providerId,
          model: responseModel,
        });
      } catch (caught) {
        if (isCancelled()) {
          const result = finishCancelled();
          sendProgress({
            message: "Response stopped.",
            stage: "failed",
            contextStatus: "completed",
            modelStatus: "failed",
            cacheStatus: result.cacheStatus,
          });
          onEvent({ type: "cancelled", result });
          return result;
        }
        assistantStatus = "failed";
        assistantError = caught instanceof Error ? caught.message : String(caught);
        assistantContent = assistantContent.trim()
          ? `${assistantContent.trim()}\n\nThe selected LLM provider failed while answering this chat message. ${assistantError}`
          : `The selected LLM provider failed while answering this chat message. ${assistantError}`;
      }
    }
    if (isCancelled()) {
      const result = finishCancelled();
      sendProgress({
        message: "Response stopped.",
        stage: "failed",
        contextStatus: "completed",
        modelStatus: "failed",
        cacheStatus: result.cacheStatus,
      });
      onEvent({ type: "cancelled", result });
      return result;
    }

    const assistantMessage: IntuneChatMessage = {
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: assistantContent,
      status: assistantStatus,
      createdAt: new Date().toISOString(),
      providerId,
      ...(responseModel ? { model: responseModel } : {}),
      sources,
      agentSuggestions,
      ...(assistantError ? { error: assistantError } : {}),
    };
    store.insertMessage(assistantMessage);
    store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);

    await this.maybeCreateSelfTrainingSuggestionFromChat({
      tenantId: tenant.id,
      question: content,
      agentSuggestions,
    });

    const result: SendIntuneChatMessageResult = {
      conversation: store.getConversation(conversation.id) ?? conversation,
      userMessage,
      assistantMessage,
      cacheStatus: {
        tenantId: tenant.id,
        resources: cacheStatus,
        schedule: store.getGraphCacheRefreshSchedule(tenant.id),
      },
    };

    sendProgress({
      message:
        assistantStatus === "failed"
          ? "Chat answer failed."
          : "Chat answer ready.",
      stage: assistantStatus === "failed" ? "failed" : "completed",
      contextStatus: "completed",
      modelStatus: assistantStatus === "failed" ? "failed" : "completed",
      cacheStatus: result.cacheStatus,
    });

    if (assistantStatus === "failed") {
      onEvent({
        type: "failed",
        result,
        error: assistantError ?? "The selected LLM provider failed.",
      });
    } else {
      onEvent({ type: "completed", result });
    }
    return result;
  }

  private requireHostedChatConsent(
    input: SendIntuneChatMessageInput,
    tenant: TenantRecord,
    provider: ProviderSummary | undefined,
    providerId: ProviderId,
    workspaceContext?: WorkspacePromptContextSummary,
  ): void {
    if (provider?.isLocal !== false) {
      return;
    }

    const consent = input.hostedProviderConsent;
    if (!consent) {
      throw new Error(
        "Hosted provider confirmation is required before Intune Chat can send tenant context to the selected provider.",
      );
    }

    if (consent.tenantId !== tenant.id || consent.providerId !== providerId) {
      throw new Error(
        "Hosted provider confirmation does not match the active tenant and provider. Confirm the chat send again.",
      );
    }

    const acknowledgedAt = Date.parse(consent.acknowledgedAt);
    const now = Date.now();
    if (
      !Number.isFinite(acknowledgedAt) ||
      now - acknowledgedAt > 5 * 60 * 1000 ||
      acknowledgedAt - now > 60 * 1000
    ) {
      throw new Error(
        "Hosted provider confirmation expired. Confirm the chat send again.",
      );
    }

    if (!workspaceContext) {
      return;
    }

    const acknowledgedWorkspace = consent.workspaceContext;
    if (
      !acknowledgedWorkspace ||
      acknowledgedWorkspace.workspaceId !== workspaceContext.workspaceId ||
      acknowledgedWorkspace.tenantId !== workspaceContext.tenantId ||
      acknowledgedWorkspace.evidenceCount !== workspaceContext.evidenceCount ||
      acknowledgedWorkspace.noteCount !== workspaceContext.noteCount ||
      acknowledgedWorkspace.includesInstructions !== workspaceContext.includesInstructions
    ) {
      throw new Error(
        "Hosted provider confirmation does not include the attached workspace context. Confirm the chat send again.",
      );
    }
  }

  async getSelfTrainingSettings(): Promise<SelfTrainingSettings> {
    return this.requireIntelligenceStore().getSelfTrainingSettings();
  }

  async setSelfTrainingEnabled(enabled: boolean): Promise<SelfTrainingSettings> {
    const now = new Date().toISOString();
    return this.requireIntelligenceStore().setSelfTrainingEnabled(enabled, now);
  }

  async listSelfTrainingSuggestions(
    status?: SelfTrainingSuggestionStatus,
  ): Promise<SelfTrainingSuggestion[]> {
    return this.requireIntelligenceStore().listSelfTrainingSuggestions(status);
  }

  async approveSelfTrainingSuggestion(id: string): Promise<SelfTrainingSuggestion> {
    const suggestion = this.requireIntelligenceStore().decideSelfTrainingSuggestion(
      id,
      "accepted",
      new Date().toISOString(),
    );
    await this.writeSelfTrainingFile(suggestion.tenantId, suggestion.agentSlug);
    return suggestion;
  }

  async rejectSelfTrainingSuggestion(id: string): Promise<SelfTrainingSuggestion> {
    return this.requireIntelligenceStore().decideSelfTrainingSuggestion(
      id,
      "rejected",
      new Date().toISOString(),
    );
  }

  async resetSelfTrainingSuggestions(
    input: ResetSelfTrainingInput,
  ): Promise<SelfTrainingSuggestion[]> {
    const persisted = await this.read();
    const tenantId = this.resolveTenant(persisted, input.tenantId).id;
    const reset = this.requireIntelligenceStore().resetAcceptedSelfTrainingSuggestions({
      tenantId,
      agentSlug: input.agentSlug,
      now: new Date().toISOString(),
    });
    await this.writeSelfTrainingFile(tenantId, input.agentSlug);
    return reset;
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
        next[idx] = {
          ...existing,
          schedule: {
            enabled: schedule.enabled,
            intervalSeconds: Math.floor(schedule.intervalSeconds),
            notifyOnSuccess: schedule.notifyOnSuccess ?? existing.schedule?.notifyOnSuccess ?? true,
            notifyOnFailure: schedule.notifyOnFailure ?? existing.schedule?.notifyOnFailure ?? true,
            notifyOnChangeOnly:
              schedule.notifyOnChangeOnly ?? existing.schedule?.notifyOnChangeOnly ?? false,
            ...(schedule.lastScheduledRunAt
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
    const sanitized =
      delivery === null ? null : sanitizeTeamsDelivery(delivery);

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentTeamsDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, teams: undefined })
          : removeEmptyDelivery({ ...currentDelivery, teams: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.getAppState();
  }

  async updateAgentWhatsAppWebDelivery(
    slug: string,
    delivery: AgentWhatsAppWebDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeWhatsAppWebDelivery(delivery);

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentWhatsAppWebDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, whatsappWeb: undefined })
          : removeEmptyDelivery({ ...currentDelivery, whatsappWeb: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.getAppState();
  }

  async updateAgentOutlookDelivery(
    slug: string,
    delivery: AgentOutlookDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeOutlookDelivery(delivery);

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentOutlookDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, outlook: undefined })
          : removeEmptyDelivery({ ...currentDelivery, outlook: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.getAppState();
  }

  async updateAgentSlackDelivery(
    slug: string,
    delivery: AgentSlackDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeSlackDelivery(delivery);

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentSlackDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, slack: undefined })
          : removeEmptyDelivery({ ...currentDelivery, slack: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.getAppState();
  }

  async updateAgentDiscordDelivery(
    slug: string,
    delivery: AgentDiscordDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeDiscordDelivery(delivery);

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentDiscordDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, discord: undefined })
          : removeEmptyDelivery({ ...currentDelivery, discord: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.getAppState();
  }

  async updateAgentSignalDelivery(
    slug: string,
    delivery: AgentSignalDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeSignalDelivery(delivery);

    await this.serialize(async () => {
      const persisted = await this.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentSignalDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, signal: undefined })
          : removeEmptyDelivery({ ...currentDelivery, signal: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.getAppState();
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
        : 0;
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
    if (!this.intelligenceStore) return;
    const persisted = await this.read();
    const nowMs = Date.now();

    for (const tenant of persisted.tenants) {
      if (!this.intelligenceStore.isGraphCacheRefreshDue(tenant.id, nowMs)) continue;
      const startedAt = new Date(nowMs).toISOString();
      try {
        const result = await this.refreshGraphCache({ tenantId: tenant.id });
        const failures = result.resources.filter((resource) => !resource.ok);
        this.intelligenceStore.markGraphCacheRefreshScheduleRun({
          tenantId: tenant.id,
          startedAt,
          success: failures.length === 0,
          ...(failures.length > 0
            ? {
                error: failures
                  .map((failure) => `${failure.label}: ${failure.error ?? "failed"}`)
                  .join("; "),
              }
            : {}),
        });
      } catch (error) {
        this.intelligenceStore.markGraphCacheRefreshScheduleRun({
          tenantId: tenant.id,
          startedAt,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(
          `[intune-chat] scheduled Graph cache refresh failed for tenant ${tenant.id}:`,
          error,
        );
      }
    }
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
      provider?.status === "connected"
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

    return this.getAppState();
  }

  async cancelRun(runId: string): Promise<RunRecord> {
    const result = await this.serialize(async () => {
      const persisted = await this.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "rejected" ||
        run.status === "cancelled"
      ) {
        // Already terminal — nothing to cancel.
        return run;
      }

      const finishedAt = new Date().toISOString();
      const cancelled: RunRecord = {
        ...run,
        status: "cancelled",
        finishedAt,
        // Overwrite any stale in-progress summary (e.g. "X is running.")
        // with an explicit cancellation message. The original summary
        // would otherwise leak into Activity rows long after the cancel.
        summary: "Cancelled by user.",
        // Transition any in-flight step to "cancelled" and stop any
        // streaming reasoning indicator. Without this the UI keeps
        // spinning the active step and showing a "streaming" badge
        // even though the run is terminal.
        steps: run.steps.map((step) =>
          step.status === "running"
            ? {
                ...step,
                status: "cancelled",
                finishedAt: step.finishedAt ?? finishedAt,
                thinking: step.thinking
                  ? { ...step.thinking, streaming: false }
                  : step.thinking,
              }
            : step.thinking?.streaming
              ? {
                  ...step,
                  thinking: { ...step.thinking, streaming: false },
                }
              : step,
        ),
      };
      const nextRuns = persisted.runs.map((existing) =>
        existing.id === runId ? cancelled : existing,
      );
      await this.write({ ...persisted, runs: nextRuns });
      return cancelled;
    });
    this.cancelledRunIds.add(runId);
    return result;
  }

  async installAgent(agentId: string): Promise<AppState> {
    let installedSlug: string | undefined;
    let installIdForReport: string | undefined;

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

      const registryAgent = this.listRegistryAgents().find(
        (agent) =>
          agent.id === agentId ||
          agent.slug === agentId ||
          agent.registryId === agentId,
      );
      if (!registryAgent) {
        throw new Error(`Unknown registry agent: ${agentId}`);
      }
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
      });

      await this.write({
        ...persisted,
        ...(installId ? { installId } : {}),
        installedAgents: [...persisted.installedAgents, installed],
      });

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
      if (!candidate || !candidate.manifestUrl) return compatibleAgent;
      if (compareSemver(candidate.version, agent.version) <= 0) return compatibleAgent;
      return {
        ...compatibleAgent,
        updateAvailable: {
          version: candidate.version,
          manifestUrl: candidate.manifestUrl,
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
      const updatesRoot = this.agentUpdatesRoot();
      if (!updatesRoot) {
        throw new Error("updateAgent: agent-updates root is unavailable.");
      }
      const agentDir = join(updatesRoot, slug);
      await mkdir(agentDir, { recursive: true });
      const finalPath = join(agentDir, "manifest.yaml");
      const tmpPath = `${finalPath}.tmp`;
      await writeFile(
        tmpPath,
        manifestText.endsWith("\n") ? manifestText : `${manifestText}\n`,
        "utf8",
      );
      await rename(tmpPath, finalPath);

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
      await this.write({ ...persisted, installedAgents });
    });

    return this.getAppState();
  }

  private async fetchAgentUpdateManifest(
    slug: string,
    context: "getAgentUpdateReview" | "updateAgent",
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

    return {
      target,
      manifestText,
      parsedManifest,
      manifestSha256: sha256(manifestText),
    };
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
          : Date.now();
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
    const client = this.getMsalClient();
    let result;
    try {
      result = await runInteractiveFlow({
        client,
        openBrowser: this.openBrowser,
      });
    } catch (error) {
      throw new Error(humanizeMsalError(error));
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
    const client = this.getMsalClient();
    const persistedBefore = await this.read();
    const target = persistedBefore.tenants.find((tenant) => tenant.id === id);
    if (target) {
      try {
        await removeAccount({ client, homeAccountId: target.homeAccountId });
      } catch {
        // best-effort; we still clear the tenant entry below.
      }
    }

    await this.serialize(async () => {
      const persisted = await this.read();
      const nextTenants = persisted.tenants.filter((tenant) => tenant.id !== id);
      const next: PersistedState = {
        ...persisted,
        tenants: nextTenants,
      };
      if (persisted.activeTenantId === id) {
        delete next.activeTenantId;
      }
      await this.write(next);
    });

    return this.getAppState();
  }

  async startRun(
    agentSlug: string,
    options: StartRunOptions = {},
  ): Promise<RunRecord> {
    const queued = await this.serialize(async () => {
      const persisted = await this.read();
      const agent = persisted.installedAgents.find(
        (installedAgent) => installedAgent.slug === agentSlug,
      );

      if (!agent) {
        throw new Error(`Agent is not installed: ${agentSlug}`);
      }
      assertAgentCompatible(
        withAgentCompatibility(agent, this.appVersion),
        "run",
      );

      const providers = await this.listProviders();
      // Honor a per-run provider override if supplied; otherwise fall
      // back to the globally-active provider. Unknown ids are an error
      // — silently dropping the override would be misleading.
      let selectedProvider: ProviderSummary | undefined;
      if (options.providerId !== undefined) {
        selectedProvider = providers.find((p) => p.id === options.providerId);
        if (!selectedProvider) {
          throw new Error(`Unknown provider: ${String(options.providerId)}`);
        }
      } else {
        selectedProvider =
          providers.find((provider) => provider.id === persisted.activeProviderId) ??
          providers[0];
      }
      const activeProvider = selectedProvider;
      const providerId =
        activeProvider?.id ?? options.providerId ?? persisted.activeProviderId;

      // Resolve which model to stamp on the run, in priority order:
      //   1. Explicit per-run override (options.model) when supplied
      //   2. Agent manifest's preferredModel IF the provider has it pulled
      //   3. User's pinned activeModelByProviderId[providerId] if set
      //   4. Provider's first reported model (defaultModel)
      const knownModels = activeProvider?.models ?? [];
      const explicitModel =
        typeof options.model === "string" && options.model.length > 0
          ? options.model
          : undefined;
      if (explicitModel) {
        if (knownModels.length > 0 && !knownModels.includes(explicitModel)) {
          const recovery =
            activeProvider?.id === "ollama"
              ? ` Pull it with \`ollama pull ${explicitModel}\` and try again.`
              : " Pick one of the models reported by the provider and try again.";
          throw new Error(
            `Model "${explicitModel}" is not available for ${activeProvider?.name ?? providerId}.${recovery}`,
          );
        }
      }
      const model = resolveRunModel({
        provider: activeProvider,
        activeModelByProviderId: persisted.activeModelByProviderId,
        preferredModel: agent.preferredModel,
        explicitModel,
      }).model;

      // Preflight the LLM provider so a clearly-actionable error is
      // returned to the renderer synchronously instead of a queued
      // run that fails moments later when the runtime can't reach it.
      if (activeProvider && activeProvider.status !== "connected") {
        if (activeProvider.id === "ollama") {
          throw new Error(
            "Ollama isn't reachable. Start it with `ollama serve`, then try again.",
          );
        }
        throw new Error(
          `${activeProvider.name} isn't ready. Open Settings → LLM Providers to check the connection.`,
        );
      }

      // Resolve the effective tenant at queue time. Runs cannot proceed
      // without a connected tenant — onboarding is the gate that gets a
      // user here in the first place, but defend in depth.
      //   - explicit id  -> validate it exists and pin it
      //   - omitted      -> default to currently-active tenant
      let pinnedTenantId: string;
      if (typeof options.tenantId === "string") {
        const exists = persisted.tenants.some((tenant) => tenant.id === options.tenantId);
        if (!exists) {
          throw new Error(`Tenant not connected: ${options.tenantId}`);
        }
        pinnedTenantId = options.tenantId;
      } else if (persisted.activeTenantId) {
        pinnedTenantId = persisted.activeTenantId;
      } else {
        throw new Error(
          "No tenant connected. Connect a Microsoft 365 tenant before running agents.",
        );
      }

      // Entra ID tier preflight: if the agent declares a required tier
      // and the tenant's detected tier is known to fall short, refuse
      // the run with a clear remediation message. `unknown` tier (not
      // probed yet, or probe failed) is treated as informational —
      // runs proceed and the actual Graph call may fail with a real
      // 403, which still surfaces meaningfully via the runtime.
      const requiredTier = agent.requiresEntraTier ?? "free";
      if (requiredTier !== "free") {
        const tenantRecord = persisted.tenants.find((t) => t.id === pinnedTenantId);
        const satisfies = tenantSatisfiesRequirement(tenantRecord?.entraTier, requiredTier);
        if (satisfies === false) {
          const detectedLabel = tenantRecord?.entraTier === "free" ? "Entra ID Free" : `Entra ID ${tenantRecord?.entraTier?.toUpperCase()}`;
          const requiredLabel = `Entra ID ${requiredTier.toUpperCase()}`;
          throw new Error(
            `${agent.name} requires ${requiredLabel}. The active tenant (${tenantRecord?.displayName ?? pinnedTenantId}) is on ${detectedLabel}. Microsoft 365 Business Premium includes Entra ID P1 — check your tenant's subscription, or pick a free-tier agent.`,
          );
        }
      }

      const queuedRun = createQueuedRun({ agent, providerId, model });
      queuedRun.tenantId = pinnedTenantId;
      queuedRun.trigger = options.trigger ?? "manual";

      await this.write({
        ...persisted,
        runs: [queuedRun, ...persisted.runs],
      });

      return { agent, providerId, model, queuedRun };
    });

    if (options.source?.type === "intune-chat" && this.intelligenceStore) {
      const now = new Date().toISOString();
      const statusNote =
        queued.agent.mode === "write"
          ? "Write actions still require the normal confirmation flow."
          : "Read-only agent run queued.";
      const message: IntuneChatMessage = {
        id: `msg_${randomUUID()}`,
        conversationId: options.source.conversationId,
        role: "assistant",
        content: `${queued.agent.name} started from chat. Run ${queued.queuedRun.id} is ${queued.queuedRun.status}. ${statusNote}`,
        status: "completed",
        providerId: queued.providerId,
        model: queued.model,
        createdAt: now,
      };
      this.intelligenceStore.insertMessage(message);
      this.intelligenceStore.insertToolCall({
        id: `tool_${randomUUID()}`,
        conversationId: options.source.conversationId,
        messageId: message.id,
        type: "agent-run",
        status: "completed",
        createdAt: now,
        completedAt: now,
        input: {
          agentSlug,
          originatingMessageId: options.source.messageId,
        },
        output: {
          runId: queued.queuedRun.id,
          runStatus: queued.queuedRun.status,
        },
      });
      this.intelligenceStore.touchConversation(options.source.conversationId, undefined, now);
    }

    void this.driveRun({
      run: queued.queuedRun,
      agent: queued.agent,
      providerId: queued.providerId,
      model: queued.model,
    });
    this.recordLearningEventSafely({
      tenantId: queued.queuedRun.tenantId,
      agentSlug: queued.agent.slug,
      eventType: "agent.run-started",
      source: "run",
      payload: {
        runId: queued.queuedRun.id,
        trigger: queued.queuedRun.trigger,
        mode: queued.agent.mode,
      },
    });
    return queued.queuedRun;
  }

  async confirmRun(runId: string, phrase: string): Promise<RunRecord> {
    const transition = await this.serialize(async () => {
      const persisted = await this.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (run.status !== "awaiting-confirmation") {
        throw new Error(
          `Run ${runId} is not awaiting confirmation (status: ${run.status}).`,
        );
      }
      if (!run.plan) {
        throw new Error(`Run ${runId} has no plan to confirm.`);
      }
      if (phrase !== run.plan.confirmationPhrase) {
        throw new Error("Confirmation phrase does not match.");
      }

      const agent = persisted.installedAgents.find(
        (installedAgent) => installedAgent.slug === run.agentSlug,
      );
      if (!agent) {
        throw new Error(`Agent is not installed: ${run.agentSlug}`);
      }
      if (agent.mode !== "write") {
        throw new Error(`Agent ${run.agentSlug} is not a write agent.`);
      }

      const confirmedAt = new Date().toISOString();
      const updated: RunRecord = {
        ...run,
        status: "running",
        confirmedAt,
        startedAt: confirmedAt,
        summary: `${agent.name} is applying.`,
      };
      await this.write({
        ...persisted,
        runs: persisted.runs.map((existing) =>
          existing.id === runId ? updated : existing,
        ),
      });

      const providers = await this.listProviders();
      const activeProvider =
        providers.find((provider) => provider.id === persisted.activeProviderId) ??
        providers[0];
      const providerId = run.providerId ?? activeProvider?.id ?? persisted.activeProviderId;
      const model =
        run.model ??
        resolveProviderDefaultModel(
          activeProvider,
          persisted.activeModelByProviderId,
        ).model;

      return { agent, providerId, model, updated };
    });

    void this.driveApply({
      run: transition.updated,
      agent: transition.agent,
      providerId: transition.providerId,
      model: transition.model,
      plan: transition.updated.plan!,
    });
    this.recordLearningEventSafely({
      tenantId: transition.updated.tenantId,
      agentSlug: transition.agent.slug,
      eventType: "agent.write-plan-confirmed",
      source: "run",
      payload: {
        runId: transition.updated.id,
        actionCount: transition.updated.plan?.actions.length ?? 0,
      },
    });
    return transition.updated;
  }

  async rejectRun(runId: string): Promise<RunRecord> {
    return this.serialize(async () => {
      const persisted = await this.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (run.status !== "awaiting-confirmation") {
        throw new Error(
          `Run ${runId} cannot be rejected (status: ${run.status}).`,
        );
      }

      const rejectedAt = new Date().toISOString();
      const updated: RunRecord = {
        ...run,
        status: "rejected",
        rejectedAt,
        finishedAt: rejectedAt,
        summary: `Run rejected by user.`,
      };
      await this.write({
        ...persisted,
        runs: persisted.runs.map((existing) =>
          existing.id === runId ? updated : existing,
        ),
      });
      this.recordLearningEventSafely({
        tenantId: updated.tenantId,
        agentSlug: updated.agentSlug,
        eventType: "agent.write-plan-rejected",
        source: "run",
        payload: {
          runId: updated.id,
          actionCount: updated.plan?.actions.length ?? 0,
        },
      });
      return updated;
    });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const persisted = await this.read();
    return persisted.runs.find((run) => run.id === id);
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
    if (!provider || provider.status !== "connected") {
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
    if (providerId === "openai") {
      return createCodexLlm({ defaultModel });
    }
    return noopLlm;
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

  private stampTenant(run: RunRecord, tenantId: string): RunRecord {
    return { ...run, tenantId };
  }

  private async driveRun(input: {
    run: RunRecord;
    agent: AgentSummary;
    providerId: ProviderId;
    model?: string;
  }): Promise<void> {
    try {
      const driver = input.agent.mode === "write" ? executePlan : executeRun;
      const baseLlm = await this.buildLlm(input.providerId, input.model);
      const selection = await this.buildGraph(input.run.tenantId, input.agent.scopes);
      const overlay = this.selfTrainingPromptOverlay(selection.tenantId, input.agent.slug);
      const llm = overlay ? withSelfTrainingOverlay(baseLlm, overlay) : baseLlm;
      const stampedRun = this.stampTenant(input.run, selection.tenantId);
      await this.persistRunSnapshot(stampedRun);
      await driver({
        run: stampedRun,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        llm,
        createGraph: selection.createGraph,
        tenant: selection.tenantSession,
        connectorConfigs: await this.readConnectorConfigs(),
        connectorSecretsFor: (connectorId) => this.connectorSecretsFor(connectorId),
        confirmCapability: requestConnectorConfirmation,
        realWrites: true,
        onProgress: (next) =>
          this.persistRunSnapshot(this.stampTenant(next, selection.tenantId)),
      });
    } catch (error) {
      await this.persistFailedSnapshot(input.run, input.agent, error);
    }
  }

  private async driveApply(input: {
    run: RunRecord;
    agent: AgentSummary;
    providerId: ProviderId;
    model?: string;
    plan: NonNullable<RunRecord["plan"]>;
  }): Promise<void> {
    try {
      const baseLlm = await this.buildLlm(input.providerId, input.model);
      const selection = await this.buildGraph(input.run.tenantId, input.agent.scopes);
      const overlay = this.selfTrainingPromptOverlay(selection.tenantId, input.agent.slug);
      const llm = overlay ? withSelfTrainingOverlay(baseLlm, overlay) : baseLlm;
      await executeApply({
        run: input.run,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        plan: input.plan,
        llm,
        createGraph: selection.createGraph,
        tenant: selection.tenantSession,
        connectorConfigs: await this.readConnectorConfigs(),
        connectorSecretsFor: (connectorId) => this.connectorSecretsFor(connectorId),
        confirmCapability: requestConnectorConfirmation,
        realWrites: true,
        onProgress: (next) =>
          this.persistRunSnapshot(this.stampTenant(next, selection.tenantId)),
      });
    } catch (error) {
      await this.persistFailedSnapshot(input.run, input.agent, error);
    }
  }

  private async persistFailedSnapshot(
    run: RunRecord,
    agent: AgentSummary,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    await this.persistRunSnapshot({
      ...run,
      status: "failed",
      finishedAt,
      summary: `${agent.name} failed: ${message}`,
      error: message,
    });
  }

  private async persistRunSnapshot(run: RunRecord): Promise<void> {
    if (this.cancelledRunIds.has(run.id)) {
      // Run was soft-cancelled: discard further progress snapshots so
      // the stored state stays in the "cancelled" terminal state even
      // while background work finishes returning.
      return Promise.resolve();
    }
    let deliveryCandidate: RunRecord | undefined;
    await this.serialize(async () => {
      const persisted = await this.read();
      const previous = persisted.runs.find((existing) => existing.id === run.id);
      const wasTerminal = previous ? isTerminalRunStatus(previous.status) : false;
      const isNowTerminal = isTerminalRunStatus(run.status);
      const nextRun =
        isNowTerminal && run.status === "completed" && run.trigger === "schedule"
          ? this.withScheduleChangeState(run, persisted.runs)
          : run;
      const exists = previous !== undefined;
      const nextRuns = exists
        ? persisted.runs.map((existing) => (existing.id === nextRun.id ? nextRun : existing))
        : [nextRun, ...persisted.runs];
      await this.write({ ...persisted, runs: nextRuns });
      if (!wasTerminal && isNowTerminal && this.onRunFinished) {
        try {
          this.onRunFinished(nextRun);
        } catch (error) {
          console.error("[state] onRunFinished listener failed", error);
        }
      }
      if (!wasTerminal && isNowTerminal) {
        deliveryCandidate = nextRun;
      }
    });
    if (deliveryCandidate) {
      await this.enqueueRunDeliveries(deliveryCandidate);
      void this.processPendingRunDeliveries();
    }
  }

  async processPendingRunDeliveries(): Promise<void> {
    if (this.deliveryQueueProcessing) return this.deliveryQueueProcessing;
    this.deliveryQueueProcessing = this.processRunDeliveryQueue().finally(() => {
      this.deliveryQueueProcessing = undefined;
    });
    return this.deliveryQueueProcessing;
  }

  private async enqueueRunDeliveries(run: RunRecord): Promise<void> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    if (!agent) return;
    const connectorIds: RunDeliveryConnectorId[] = [];
    if (agent.delivery?.teams?.enabled) connectorIds.push("teams");
    if (agent.delivery?.whatsappWeb?.enabled) {
      connectorIds.push(WHATSAPP_WEB_CONNECTOR_ID);
    }
    if (agent.delivery?.outlook?.enabled) connectorIds.push(OUTLOOK_CONNECTOR_ID);
    if (agent.delivery?.slack?.enabled) connectorIds.push(SLACK_CONNECTOR_ID);
    if (agent.delivery?.discord?.enabled) connectorIds.push(DISCORD_CONNECTOR_ID);
    if (agent.delivery?.signal?.enabled) connectorIds.push(SIGNAL_CONNECTOR_ID);
    if (connectorIds.length === 0) return;

    const now = new Date().toISOString();
    await this.serialize(async () => {
      const current = await this.read();
      const existing = current.runDeliveryQueue ?? [];
      const existingIds = new Set(existing.map((item) => item.id));
      const additions = connectorIds
        .map((connectorId): RunDeliveryQueueItem => ({
          id: `${run.id}:${connectorId}`,
          runId: run.id,
          connectorId,
          attempts: 0,
          createdAt: now,
          nextAttemptAt: now,
        }))
        .filter((item) => !existingIds.has(item.id));
      if (additions.length === 0) return;
      await this.write({
        ...current,
        runDeliveryQueue: [...existing, ...additions],
      });
    });
  }

  private async processRunDeliveryQueue(): Promise<void> {
    for (;;) {
      const item = await this.claimDueRunDelivery();
      if (!item) return;
      const result = await this.processRunDeliveryItem(item);
      if (result.retryable && item.attempts < RUN_DELIVERY_MAX_ATTEMPTS) {
        await this.rescheduleRunDelivery(item, result.error);
      } else {
        await this.removeRunDelivery(item.id);
      }
    }
  }

  private async claimDueRunDelivery(): Promise<RunDeliveryQueueItem | undefined> {
    const now = new Date();
    let claimed: RunDeliveryQueueItem | undefined;
    await this.serialize(async () => {
      const current = await this.read();
      const queue = current.runDeliveryQueue ?? [];
      const index = queue.findIndex((item) => {
        if (item.attempts >= RUN_DELIVERY_MAX_ATTEMPTS) return false;
        const dueAt = new Date(item.nextAttemptAt).getTime();
        return !Number.isFinite(dueAt) || dueAt <= now.getTime();
      });
      if (index < 0) return;
      const item = queue[index];
      if (!item) return;
      const attempts = item.attempts + 1;
      const claimedItem: RunDeliveryQueueItem = {
        ...item,
        attempts,
        lastAttemptAt: now.toISOString(),
        nextAttemptAt: new Date(
          now.getTime() + retryDelayForAttempt(attempts),
        ).toISOString(),
      };
      const nextQueue = [...queue];
      nextQueue[index] = claimedItem;
      claimed = claimedItem;
      await this.write({ ...current, runDeliveryQueue: nextQueue });
    });
    return claimed;
  }

  private async processRunDeliveryItem(
    item: RunDeliveryQueueItem,
  ): Promise<RunDeliveryResult> {
    const persisted = await this.read();
    const run = persisted.runs.find((candidate) => candidate.id === item.runId);
    if (!run || !isTerminalRunStatus(run.status)) {
      return { retryable: false };
    }
    try {
      switch (item.connectorId) {
        case "teams":
          return await this.deliverRunToTeams(run);
        case WHATSAPP_WEB_CONNECTOR_ID:
          return await this.deliverRunToWhatsAppWeb(run);
        case OUTLOOK_CONNECTOR_ID:
          return await this.deliverRunToOutlook(run);
        case SLACK_CONNECTOR_ID:
          return await this.deliverRunToSlack(run);
        case DISCORD_CONNECTOR_ID:
          return await this.deliverRunToDiscord(run);
        case SIGNAL_CONNECTOR_ID:
          return await this.deliverRunToSignal(run);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendRunLog(
        item.runId,
        "warn",
        `Run delivery failed: ${message}`,
      );
      return { retryable: true, error: message };
    }
  }

  private async rescheduleRunDelivery(
    item: RunDeliveryQueueItem,
    error?: string,
  ): Promise<void> {
    await this.serialize(async () => {
      const current = await this.read();
      const nextQueue = (current.runDeliveryQueue ?? []).map((queued) =>
        queued.id === item.id
          ? {
              ...queued,
              attempts: item.attempts,
              nextAttemptAt: item.nextAttemptAt,
              ...(item.lastAttemptAt ? { lastAttemptAt: item.lastAttemptAt } : {}),
              ...(error ? { lastError: error } : {}),
            }
          : queued,
      );
      await this.write({ ...current, runDeliveryQueue: nextQueue });
    });
  }

  private async removeRunDelivery(id: string): Promise<void> {
    await this.serialize(async () => {
      const current = await this.read();
      const nextQueue = (current.runDeliveryQueue ?? []).filter(
        (item) => item.id !== id,
      );
      const nextState: PersistedState = { ...current };
      if (nextQueue.length > 0) {
        nextState.runDeliveryQueue = nextQueue;
      } else {
        delete nextState.runDeliveryQueue;
      }
      await this.write(nextState);
    });
  }

  private withScheduleChangeState(run: RunRecord, runs: RunRecord[]): RunRecord {
    const previous = runs.find(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.agentSlug === run.agentSlug &&
        candidate.trigger === "schedule" &&
        candidate.status === "completed",
    );
    if (!previous) return { ...run, changeState: "new" };
    return {
      ...run,
      changeState:
        fingerprintRunOutput(previous) === fingerprintRunOutput(run)
          ? "unchanged"
          : "changed",
    };
  }

  private async deliverRunToTeams(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.teams;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Microsoft Teams");
    if (!evaluation.shouldSend) {
      await this.appendRunStep(run.id, {
        label: "Microsoft Teams notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.appendRunLog(
        run.id,
        "info",
        `Teams delivery skipped: ${evaluation.detail}`,
        { connectorId: "teams" },
      );
      return { retryable: false };
    }

    const tenantId = run.tenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((candidate) => candidate.id === tenantId)
      : undefined;
    const baseConfig = persisted.connectors?.teams?.config ?? {};
    const targetLabel = teamsDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.appendRunStep(run.id, {
      label: "Send run report to Microsoft Teams",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!tenant) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No tenant session was available for Microsoft Teams delivery.",
      );
      await this.appendRunLog(run.id, "warn", "Teams delivery failed: no tenant session available.", {
        connectorId: "teams",
      });
      return {
        retryable: false,
        error: "No tenant session was available for Microsoft Teams delivery.",
      };
    }

    const factory = findConnectorFactory("teams");
    if (!factory) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Microsoft Teams connector is not registered.",
      );
      await this.appendRunLog(run.id, "warn", "Teams delivery failed: Teams connector is not registered.", {
        connectorId: "teams",
      });
      return {
        retryable: false,
        error: "Microsoft Teams connector is not registered.",
      };
    }

    const config =
      delivery?.useDefaultTarget === false
        ? {
            ...baseConfig,
            ...(delivery.teamId ? { defaultTeamId: delivery.teamId } : {}),
            ...(delivery.channelId ? { defaultChannelId: delivery.channelId } : {}),
            ...(delivery.teamName ? { defaultTeamName: delivery.teamName } : {}),
            ...(delivery.channelName ? { defaultChannelName: delivery.channelName } : {}),
          }
        : baseConfig;

    const client = this.getMsalClient();
    const openBrowser = this.openBrowser;
    const tenantSession = createTenantSession({
      client,
      tenantId: tenant.id,
      username: tenant.username,
      homeAccountId: tenant.homeAccountId,
      acquireInteractive: async (scopes) =>
        runInteractiveFlow({ client, scopes, openBrowser }),
    });

    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: tenantSession,
        config,
        secrets: noSecrets,
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:teams-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        postChannelMessage?: (args: {
          teamId?: string;
          channelId?: string;
          markdown: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.postChannelMessage !== "function") {
        throw new Error("Teams connector does not expose postChannelMessage.");
      }
      const markdown = formatTeamsDeliveryMessage(run, agent, tenant);
      const auditStartedAt = Date.now();
      const result = await capabilities.postChannelMessage({
        ...(delivery?.useDefaultTarget === false && delivery.teamId
          ? { teamId: delivery.teamId }
          : {}),
        ...(delivery?.useDefaultTarget === false && delivery.channelId
          ? { channelId: delivery.channelId }
          : {}),
        markdown,
      });
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: "teams",
        capability: "post-channel-message@1",
        idempotencyKey: `${run.id}:${stepId}:post-channel-message:0`,
        egressTarget: targetLabel,
        args: { target: targetLabel, markdown },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.appendRunLog(run.id, "info", "Run report delivered to Microsoft Teams.", {
        connectorId: "teams",
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: "teams",
        capability: "post-channel-message@1",
        idempotencyKey: `${run.id}:${stepId}:post-channel-message:0`,
        egressTarget: targetLabel,
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Microsoft Teams delivery failed: ${message}`,
      );
      await this.appendRunLog(
        run.id,
        "warn",
        `Teams delivery failed: ${message}`,
        {
          connectorId: "teams",
          connectorAudit: audit as unknown as Record<string, unknown>,
        },
      );
      return { retryable: true, error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToWhatsAppWeb(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.whatsappWeb;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "WhatsApp");
    if (!evaluation.shouldSend) {
      await this.appendRunStep(run.id, {
        label: "WhatsApp notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.appendRunLog(
        run.id,
        "info",
        `WhatsApp delivery skipped: ${evaluation.detail}`,
        { connectorId: WHATSAPP_WEB_CONNECTOR_ID },
      );
      return { retryable: false };
    }

    const config = persisted.connectors?.[WHATSAPP_WEB_CONNECTOR_ID]?.config ?? {};
    const recipient =
      delivery.useDefaultRecipient === false
        ? delivery.recipient
        : resolveWhatsAppDefaultRecipient(config);
    const targetLabel = whatsAppDeliveryTargetLabel(delivery, config);
    const stepId = await this.appendRunStep(run.id, {
      label: "Send run report to WhatsApp",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!recipient) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No WhatsApp notification target is configured.",
      );
      await this.appendRunLog(
        run.id,
        "warn",
        "WhatsApp delivery failed: no target configured.",
        { connectorId: WHATSAPP_WEB_CONNECTOR_ID },
      );
      return {
        retryable: false,
        error: "No WhatsApp notification target is configured.",
      };
    }

    const tenantId = run.tenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((candidate) => candidate.id === tenantId)
      : undefined;

    try {
      const text = formatWhatsAppDeliveryMessage(run, agent, tenant);
      const auditStartedAt = Date.now();
      const result = await this.whatsAppWebClient().sendMessage({
        to: recipient,
        text,
      });
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: WHATSAPP_WEB_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `${WHATSAPP_WEB_CONNECTOR_ID}:to=redacted`,
        args: { to: "redacted", text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.appendRunLog(
        run.id,
        "info",
        "Run report delivered to WhatsApp Web.",
        {
          connectorId: WHATSAPP_WEB_CONNECTOR_ID,
          messageId: result.messageId,
          connectorAudit: audit as unknown as Record<string, unknown>,
        },
      );
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: WHATSAPP_WEB_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `${WHATSAPP_WEB_CONNECTOR_ID}:to=redacted`,
        args: { to: "redacted" },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        `WhatsApp delivery failed: ${message}`,
      );
      await this.appendRunLog(
        run.id,
        "warn",
        `WhatsApp delivery failed: ${message}`,
        {
          connectorId: WHATSAPP_WEB_CONNECTOR_ID,
          connectorAudit: audit as unknown as Record<string, unknown>,
        },
      );
      return { retryable: true, error: message };
    }
  }

  private async deliverRunToOutlook(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.outlook;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Outlook");
    if (!evaluation.shouldSend) {
      await this.appendRunStep(run.id, {
        label: "Outlook notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.appendRunLog(run.id, "info", `Outlook delivery skipped: ${evaluation.detail}`, {
        connectorId: OUTLOOK_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const tenantId = run.tenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((candidate) => candidate.id === tenantId)
      : undefined;
    const baseConfig = persisted.connectors?.[OUTLOOK_CONNECTOR_ID]?.config ?? {};
    const recipients =
      delivery.useDefaultRecipients === false
        ? sanitizeDeliveryList(delivery.recipients)
        : undefined;
    const targetLabel = outlookDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.appendRunStep(run.id, {
      label: "Send run report by Outlook email",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!tenant) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No tenant session was available for Outlook delivery.",
      );
      await this.appendRunLog(run.id, "warn", "Outlook delivery failed: no tenant session available.", {
        connectorId: OUTLOOK_CONNECTOR_ID,
      });
      return {
        retryable: false,
        error: "No tenant session was available for Outlook delivery.",
      };
    }
    if (delivery.useDefaultRecipients === false && (!recipients || recipients.length === 0)) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No Outlook notification recipients are configured.",
      );
      await this.appendRunLog(
        run.id,
        "warn",
        "Outlook delivery failed: no recipients configured.",
        { connectorId: OUTLOOK_CONNECTOR_ID },
      );
      return {
        retryable: false,
        error: "No Outlook notification recipients are configured.",
      };
    }

    const factory = findConnectorFactory(OUTLOOK_CONNECTOR_ID);
    if (!factory) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Outlook connector is not registered.",
      );
      await this.appendRunLog(run.id, "warn", "Outlook delivery failed: connector is not registered.", {
        connectorId: OUTLOOK_CONNECTOR_ID,
      });
      return { retryable: false, error: "Outlook connector is not registered." };
    }

    const client = this.getMsalClient();
    const openBrowser = this.openBrowser;
    const tenantSession = createTenantSession({
      client,
      tenantId: tenant.id,
      username: tenant.username,
      homeAccountId: tenant.homeAccountId,
      acquireInteractive: async (scopes) =>
        runInteractiveFlow({ client, scopes, openBrowser }),
    });

    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: tenantSession,
        config: baseConfig,
        secrets: this.connectorSecretsFor(OUTLOOK_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:outlook-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMail?: (args: {
          to?: string[];
          subject: string;
          markdown: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMail !== "function") {
        throw new Error("Outlook connector does not expose sendMail.");
      }
      const markdown = formatOutlookDeliveryMessage(run, agent, tenant);
      const subject = formatDeliveryEmailSubject(run, agent);
      const idempotencyKey = `${run.id}:${stepId}:send-mail:0`;
      const args: {
        to?: string[];
        subject: string;
        markdown: string;
        idempotencyKey: string;
      } = { subject, markdown, idempotencyKey };
      if (recipients && recipients.length > 0) args.to = recipients;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMail(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: OUTLOOK_CONNECTOR_ID,
        capability: "send-mail@1",
        idempotencyKey,
        egressTarget: "outlook:recipients=redacted",
        args: { target: targetLabel, subject, markdown },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.appendRunLog(run.id, "info", "Run report delivered by Outlook.", {
        connectorId: OUTLOOK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: OUTLOOK_CONNECTOR_ID,
        capability: "send-mail@1",
        idempotencyKey: `${run.id}:${stepId}:send-mail:0`,
        egressTarget: "outlook:recipients=redacted",
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Outlook delivery failed: ${message}`,
      );
      await this.appendRunLog(run.id, "warn", `Outlook delivery failed: ${message}`, {
        connectorId: OUTLOOK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToSlack(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.slack;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Slack");
    if (!evaluation.shouldSend) {
      await this.appendRunStep(run.id, {
        label: "Slack notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.appendRunLog(run.id, "info", `Slack delivery skipped: ${evaluation.detail}`, {
        connectorId: SLACK_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const baseConfig = persisted.connectors?.[SLACK_CONNECTOR_ID]?.config ?? {};
    const channel =
      delivery.useDefaultChannel === false ? delivery.channel?.trim() : undefined;
    const defaultChannel = readConfigLabel(baseConfig, "defaultChannel");
    const targetLabel = slackDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.appendRunStep(run.id, {
      label: "Send run report to Slack",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (delivery.useDefaultChannel === false && !channel) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No Slack notification channel is configured.",
      );
      await this.appendRunLog(run.id, "warn", "Slack delivery failed: no channel configured.", {
        connectorId: SLACK_CONNECTOR_ID,
      });
      return { retryable: false, error: "No Slack notification channel is configured." };
    }
    if (delivery.useDefaultChannel !== false && !defaultChannel) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No default Slack notification channel is configured.",
      );
      await this.appendRunLog(
        run.id,
        "warn",
        "Slack delivery failed: no default channel configured.",
        { connectorId: SLACK_CONNECTOR_ID },
      );
      return {
        retryable: false,
        error: "No default Slack notification channel is configured.",
      };
    }

    const factory = findConnectorFactory(SLACK_CONNECTOR_ID);
    if (!factory) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Slack connector is not registered.",
      );
      await this.appendRunLog(run.id, "warn", "Slack delivery failed: connector is not registered.", {
        connectorId: SLACK_CONNECTOR_ID,
      });
      return { retryable: false, error: "Slack connector is not registered." };
    }

    const tenant = resolveRunTenant(persisted, run);
    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: createLocalOnlyTenantSession(),
        config: baseConfig,
        secrets: this.connectorSecretsFor(SLACK_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:slack-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMessage?: (args: {
          channel?: string;
          text: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMessage !== "function") {
        throw new Error("Slack connector does not expose sendMessage.");
      }
      const text = formatChatDeliveryMessage(run, agent, tenant);
      const idempotencyKey = `${run.id}:${stepId}:send-message:0`;
      const args: { channel?: string; text: string; idempotencyKey: string } = {
        text,
        idempotencyKey,
      };
      if (channel) args.channel = channel;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMessage(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SLACK_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey,
        egressTarget: `slack:${targetLabel}`,
        args: { target: targetLabel, text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.appendRunLog(run.id, "info", "Run report delivered to Slack.", {
        connectorId: SLACK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SLACK_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `slack:${targetLabel}`,
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Slack delivery failed: ${message}`,
      );
      await this.appendRunLog(run.id, "warn", `Slack delivery failed: ${message}`, {
        connectorId: SLACK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToDiscord(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.discord;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Discord");
    if (!evaluation.shouldSend) {
      await this.appendRunStep(run.id, {
        label: "Discord notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.appendRunLog(run.id, "info", `Discord delivery skipped: ${evaluation.detail}`, {
        connectorId: DISCORD_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const baseConfig = persisted.connectors?.[DISCORD_CONNECTOR_ID]?.config ?? {};
    const threadId =
      delivery.useDefaultWebhook === false ? delivery.threadId?.trim() : undefined;
    const targetLabel = discordDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.appendRunStep(run.id, {
      label: "Send run report to Discord",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    const factory = findConnectorFactory(DISCORD_CONNECTOR_ID);
    if (!factory) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Discord connector is not registered.",
      );
      await this.appendRunLog(
        run.id,
        "warn",
        "Discord delivery failed: connector is not registered.",
        { connectorId: DISCORD_CONNECTOR_ID },
      );
      return { retryable: false, error: "Discord connector is not registered." };
    }

    const tenant = resolveRunTenant(persisted, run);
    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: createLocalOnlyTenantSession(),
        config: baseConfig,
        secrets: this.connectorSecretsFor(DISCORD_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:discord-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMessage?: (args: {
          text: string;
          threadId?: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMessage !== "function") {
        throw new Error("Discord connector does not expose sendMessage.");
      }
      const text = formatChatDeliveryMessage(run, agent, tenant);
      const idempotencyKey = `${run.id}:${stepId}:send-message:0`;
      const args: { text: string; threadId?: string; idempotencyKey: string } = {
        text,
        idempotencyKey,
      };
      if (threadId) args.threadId = threadId;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMessage(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: DISCORD_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey,
        egressTarget: `discord:${targetLabel}`,
        args: { target: targetLabel, text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.appendRunLog(run.id, "info", "Run report delivered to Discord.", {
        connectorId: DISCORD_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: DISCORD_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `discord:${targetLabel}`,
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Discord delivery failed: ${message}`,
      );
      await this.appendRunLog(run.id, "warn", `Discord delivery failed: ${message}`, {
        connectorId: DISCORD_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToSignal(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.signal;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Signal");
    if (!evaluation.shouldSend) {
      await this.appendRunStep(run.id, {
        label: "Signal notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.appendRunLog(run.id, "info", `Signal delivery skipped: ${evaluation.detail}`, {
        connectorId: SIGNAL_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const baseConfig = persisted.connectors?.[SIGNAL_CONNECTOR_ID]?.config ?? {};
    const recipient =
      delivery.useDefaultRecipient === false
        ? delivery.recipient?.trim()
        : readConfigLabel(baseConfig, "defaultRecipient");
    const targetLabel = signalDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.appendRunStep(run.id, {
      label: "Send run report to Signal",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!recipient) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No Signal notification recipient is configured.",
      );
      await this.appendRunLog(
        run.id,
        "warn",
        "Signal delivery failed: no recipient configured.",
        { connectorId: SIGNAL_CONNECTOR_ID },
      );
      return { retryable: false, error: "No Signal notification recipient is configured." };
    }

    const factory = findConnectorFactory(SIGNAL_CONNECTOR_ID);
    if (!factory) {
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Signal connector is not registered.",
      );
      await this.appendRunLog(run.id, "warn", "Signal delivery failed: connector is not registered.", {
        connectorId: SIGNAL_CONNECTOR_ID,
      });
      return { retryable: false, error: "Signal connector is not registered." };
    }

    const tenant = resolveRunTenant(persisted, run);
    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: createLocalOnlyTenantSession(),
        config: baseConfig,
        secrets: this.connectorSecretsFor(SIGNAL_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:signal-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMessage?: (args: {
          to?: string;
          text: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMessage !== "function") {
        throw new Error("Signal connector does not expose sendMessage.");
      }
      const text = formatPlainDeliveryMessage(run, agent, tenant);
      const idempotencyKey = `${run.id}:${stepId}:send-message:0`;
      const args: { to?: string; text: string; idempotencyKey: string } = {
        text,
        idempotencyKey,
      };
      if (delivery.useDefaultRecipient === false) args.to = recipient;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMessage(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SIGNAL_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey,
        egressTarget: "signal:to=redacted",
        args: { target: targetLabel, text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.appendRunLog(run.id, "info", "Run report delivered to Signal.", {
        connectorId: SIGNAL_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SIGNAL_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: "signal:to=redacted",
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Signal delivery failed: ${message}`,
      );
      await this.appendRunLog(run.id, "warn", `Signal delivery failed: ${message}`, {
        connectorId: SIGNAL_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async appendRunLog(
    runId: string,
    level: RunLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.serialize(async () => {
      const persisted = await this.read();
      const timestamp = new Date().toISOString();
      const nextRuns = persisted.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              logs: [
                ...run.logs,
                {
                  id: `log_${randomUUID()}`,
                  runId,
                  timestamp,
                  level,
                  message,
                  ...(metadata ? { metadata } : {}),
                },
              ],
            }
          : run,
      );
      await this.write({ ...persisted, runs: nextRuns });
    });
    this.emitStateChanged("run-log-appended", runId);
  }

  private async appendRunStep(
    runId: string,
    input: {
      label: string;
      status: RunStepStatus;
      detail?: string;
    },
  ): Promise<string> {
    const stepId = `step_delivery_${randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    await this.serialize(async () => {
      const persisted = await this.read();
      const nextRuns = persisted.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              steps: [
                ...run.steps,
                {
                  id: stepId,
                  runId,
                  label: input.label,
                  status: input.status,
                  ...(input.detail ? { detail: input.detail } : {}),
                  startedAt: timestamp,
                  ...(input.status === "running" ? {} : { finishedAt: timestamp }),
                },
              ],
            }
          : run,
      );
      await this.write({ ...persisted, runs: nextRuns });
    });
    this.emitStateChanged("run-step-appended", runId);
    return stepId;
  }

  private async finishRunStep(
    runId: string,
    stepId: string,
    status: Extract<RunStepStatus, "completed" | "failed" | "skipped">,
    detail?: string,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.serialize(async () => {
      const persisted = await this.read();
      const nextRuns = persisted.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              steps: run.steps.map((step) =>
                step.id === stepId
                  ? {
                      ...step,
                      status,
                      finishedAt,
                      ...(detail ? { detail } : {}),
                    }
                  : step,
              ),
            }
          : run,
      );
      await this.write({ ...persisted, runs: nextRuns });
    });
    this.emitStateChanged("run-step-updated", runId);
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
      this.lastReadSnapshot = state;
      return state;
    }
  }

  /**
   * Atomic write: serialize the new state to `state.json.tmp`, then
   * `rename` it over `state.json`. Rename is atomic on every
   * filesystem we target (APFS, ext4, NTFS), so a concurrent reader
   * either sees the previous file content or the new one — never a
   * half-flushed JSON. Plain `writeFile` truncated first and was the
   * root cause of the "redirected to onboarding mid-action" bug.
   */
  private async write(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    const tmpPath = `${this.filePath}.tmp`;
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, this.filePath);
    this.lastReadSnapshot = state;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.has(value as ProviderId);
}

function humanizeScheduledRunError(message: string): string {
  const raw = message.trim();
  const lower = raw.toLowerCase();
  if (lower.includes("graph request failed") && lower.includes("fetch failed")) {
    return "Microsoft Graph request failed. Check network or VPN connectivity, then rerun the schedule.";
  }
  if (lower.includes("graph request failed") && (lower.includes("401") || lower.includes("unauthorized"))) {
    return "Microsoft Graph rejected the request because the tenant sign-in expired. Reconnect the tenant, then rerun the schedule.";
  }
  if (lower.includes("graph request failed") && (lower.includes("403") || lower.includes("forbidden"))) {
    return "Microsoft Graph rejected the request because required permissions are missing. Reconnect the tenant and approve the agent scopes.";
  }
  if (lower.includes("no active tenant") || lower.includes("tenant required")) {
    return "No active tenant is available. Connect a tenant before scheduled runs can start.";
  }
  if (raw.length > 180) {
    return `${raw.slice(0, 177)}...`;
  }
  return raw || "Scheduled run failed.";
}

/**
 * MSAL's interactive flow throws raw library errors whose messages are
 * accurate but unfriendly ("AADSTS500113: No reply address was found"…).
 * Map the common ones to plain English; fall back to the original message
 * so we never hide signal.
 */
function humanizeMsalError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (lower.includes("user_cancelled") || lower.includes("cancelled by user")) {
    return "Sign-in was cancelled in the browser. Try again from Settings → Tenants.";
  }
  if (lower.includes("aadsts50105") || lower.includes("assigned to a role")) {
    return "The account isn't assigned to access Microsoft Graph CLI for this tenant. Ask a tenant admin to grant access, or sign in with a different account.";
  }
  if (
    lower.includes("aadsts65001") ||
    lower.includes("consent") ||
    lower.includes("requires admin")
  ) {
    return "Admin consent is required for the Microsoft Graph CLI in this tenant. Have a Global Administrator approve the app, then try again.";
  }
  if (lower.includes("aadsts50020") || lower.includes("user account") || lower.includes("not exist")) {
    return "That account doesn't exist in this tenant. Pick a directory account during sign-in instead of a personal Microsoft account.";
  }
  if (
    lower.includes("aadsts700016") ||
    lower.includes("aadsts900023") ||
    lower.includes("not found in the directory")
  ) {
    return "Microsoft rejected the sign-in because the tenant doesn't recognise our app id. This can happen if Conditional Access blocks the Microsoft Graph CLI; check with your security team.";
  }
  if (
    lower.includes("network") ||
    lower.includes("enotfound") ||
    lower.includes("etimedout") ||
    lower.includes("fetch failed")
  ) {
    return "Couldn't reach Microsoft's sign-in endpoint. Check your internet connection (proxy / VPN / DNS) and try again.";
  }
  if (lower.includes("interaction_required") || lower.includes("invalid_grant")) {
    return "The previous sign-in session expired. Reconnect from Settings → Tenants and complete the consent prompt.";
  }
  if (
    lower.includes("secure storage") ||
    lower.includes("secret service keyring") ||
    lower.includes("basic_text")
  ) {
    return raw;
  }
  // Fall back to the raw message so debugging is still possible.
  return `Sign-in failed: ${raw}`;
}

function isTerminalRunStatus(status: RunRecord["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rejected"
  );
}

function retryDelayForAttempt(attempts: number): number {
  const fallback =
    RUN_DELIVERY_RETRY_DELAYS_MS[RUN_DELIVERY_RETRY_DELAYS_MS.length - 1] ??
    300_000;
  return (
    RUN_DELIVERY_RETRY_DELAYS_MS[
      Math.min(Math.max(attempts - 1, 0), RUN_DELIVERY_RETRY_DELAYS_MS.length - 1)
    ] ?? fallback
  );
}

function sanitizeTeamsDelivery(delivery: AgentTeamsDelivery): AgentTeamsDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentTeamsDelivery: delivery must be an object or null.");
  }
  const useDefaultTarget = delivery.useDefaultTarget !== false;
  const sanitized: AgentTeamsDelivery = {
    enabled: delivery.enabled === true,
    useDefaultTarget,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultTarget) {
    if (!delivery.teamId || !delivery.channelId) {
      throw new Error(
        "updateAgentTeamsDelivery: teamId and channelId are required when not using the default Teams channel.",
      );
    }
    sanitized.teamId = delivery.teamId;
    sanitized.channelId = delivery.channelId;
    if (delivery.teamName) sanitized.teamName = delivery.teamName;
    if (delivery.channelName) sanitized.channelName = delivery.channelName;
  }
  return sanitized;
}

function sanitizeWhatsAppWebDelivery(
  delivery: AgentWhatsAppWebDelivery,
): AgentWhatsAppWebDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error(
      "updateAgentWhatsAppWebDelivery: delivery must be an object or null.",
    );
  }
  const useDefaultRecipient = delivery.useDefaultRecipient !== false;
  const sanitized: AgentWhatsAppWebDelivery = {
    enabled: delivery.enabled === true,
    useDefaultRecipient,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultRecipient) {
    const recipient = delivery.recipient?.trim();
    if (!recipient) {
      throw new Error(
        "updateAgentWhatsAppWebDelivery: recipient is required when not using the default WhatsApp recipient.",
      );
    }
    sanitized.recipient = recipient;
    const type = sanitizeWhatsAppRecipientType(delivery.recipientType, recipient);
    if (type) sanitized.recipientType = type;
    const label = delivery.recipientLabel?.trim();
    sanitized.recipientLabel =
      label && label !== recipient
        ? label
        : type === "self"
          ? "My WhatsApp"
          : type === "group"
            ? "WhatsApp group"
            : "WhatsApp recipient";
  }
  return sanitized;
}

function sanitizeOutlookDelivery(delivery: AgentOutlookDelivery): AgentOutlookDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentOutlookDelivery: delivery must be an object or null.");
  }
  const useDefaultRecipients = delivery.useDefaultRecipients !== false;
  const sanitized: AgentOutlookDelivery = {
    enabled: delivery.enabled === true,
    useDefaultRecipients,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultRecipients) {
    const recipients = sanitizeDeliveryList(delivery.recipients);
    if (recipients.length === 0) {
      throw new Error(
        "updateAgentOutlookDelivery: recipients are required when not using the default Outlook recipients.",
      );
    }
    sanitized.recipients = recipients;
    const label = delivery.recipientLabel?.trim();
    if (label) sanitized.recipientLabel = label;
  }
  return sanitized;
}

function sanitizeSlackDelivery(delivery: AgentSlackDelivery): AgentSlackDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentSlackDelivery: delivery must be an object or null.");
  }
  const useDefaultChannel = delivery.useDefaultChannel !== false;
  const sanitized: AgentSlackDelivery = {
    enabled: delivery.enabled === true,
    useDefaultChannel,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultChannel) {
    const channel = delivery.channel?.trim();
    if (!channel) {
      throw new Error(
        "updateAgentSlackDelivery: channel is required when not using the default Slack channel.",
      );
    }
    sanitized.channel = channel;
    const label = delivery.channelLabel?.trim();
    if (label) sanitized.channelLabel = label;
  }
  return sanitized;
}

function sanitizeDiscordDelivery(delivery: AgentDiscordDelivery): AgentDiscordDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentDiscordDelivery: delivery must be an object or null.");
  }
  const useDefaultWebhook = delivery.useDefaultWebhook !== false;
  const sanitized: AgentDiscordDelivery = {
    enabled: delivery.enabled === true,
    useDefaultWebhook,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultWebhook) {
    const threadId = delivery.threadId?.trim();
    if (threadId) sanitized.threadId = threadId;
    const label = delivery.targetLabel?.trim();
    if (label) sanitized.targetLabel = label;
  }
  return sanitized;
}

function sanitizeSignalDelivery(delivery: AgentSignalDelivery): AgentSignalDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentSignalDelivery: delivery must be an object or null.");
  }
  const useDefaultRecipient = delivery.useDefaultRecipient !== false;
  const sanitized: AgentSignalDelivery = {
    enabled: delivery.enabled === true,
    useDefaultRecipient,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultRecipient) {
    const recipient = delivery.recipient?.trim();
    if (!recipient) {
      throw new Error(
        "updateAgentSignalDelivery: recipient is required when not using the default Signal recipient.",
      );
    }
    sanitized.recipient = recipient;
    const label = delivery.recipientLabel?.trim();
    if (label) sanitized.recipientLabel = label;
  }
  return sanitized;
}

function resolveWhatsAppDefaultRecipient(config: Record<string, unknown>): string {
  const type =
    typeof config.defaultRecipientType === "string"
      ? config.defaultRecipientType
      : undefined;
  if (type === "self") return "self";
  const recipient =
    typeof config.defaultRecipient === "string"
      ? config.defaultRecipient.trim()
      : "";
  return recipient || "self";
}

function sanitizeWhatsAppRecipientType(
  type: unknown,
  recipient: string,
): AgentWhatsAppWebDelivery["recipientType"] {
  if (type === "self" || type === "group" || type === "manual") return type;
  if (recipient === "self") return "self";
  if (recipient.endsWith("@g.us")) return "group";
  return "manual";
}

function removeEmptyDelivery(
  delivery: NonNullable<AgentSummary["delivery"]>,
): AgentSummary["delivery"] {
  return delivery.teams ||
    delivery.whatsappWeb ||
    delivery.outlook ||
    delivery.slack ||
    delivery.discord ||
    delivery.signal
    ? delivery
    : undefined;
}

interface DeliveryRuleSettings {
  includeManualRuns?: boolean;
  includeScheduledRuns?: boolean;
  notifyOnSuccess?: boolean;
  notifyOnFailure?: boolean;
  notifyOnChangeOnly?: boolean;
}

interface DeliveryRuleEvaluation {
  shouldSend: boolean;
  detail: string;
}

function evaluateRunDeliveryRule(
  run: RunRecord,
  delivery: DeliveryRuleSettings,
  connectorName: string,
): DeliveryRuleEvaluation {
  const triggerLabel = run.trigger === "schedule" ? "scheduled" : "manual";
  if (run.status !== "completed" && run.status !== "failed") {
    return {
      shouldSend: false,
      detail: `${connectorName} delivery only runs after completed or failed runs.`,
    };
  }
  if (run.trigger === "schedule") {
    if (delivery.includeScheduledRuns === false) {
      return {
        shouldSend: false,
        detail: `${connectorName} delivery is disabled for scheduled runs.`,
      };
    }
    if (delivery.notifyOnChangeOnly === true && run.changeState === "unchanged") {
      return {
        shouldSend: false,
        detail: `${connectorName} delivery is configured only when scheduled findings change; this run was unchanged.`,
      };
    }
  } else if (delivery.includeManualRuns === false) {
    return {
      shouldSend: false,
      detail: `${connectorName} delivery is disabled for manual runs.`,
    };
  }
  if (run.status === "completed" && delivery.notifyOnSuccess === false) {
    return {
      shouldSend: false,
      detail:
        delivery.notifyOnFailure === true
          ? `${connectorName} delivery is configured for failed runs only; this run completed.`
          : `${connectorName} delivery is not configured for completed runs.`,
    };
  }
  if (run.status === "failed" && delivery.notifyOnFailure !== true) {
    return {
      shouldSend: false,
      detail:
        delivery.notifyOnSuccess !== false
          ? `${connectorName} delivery is configured for completed runs only; this run failed.`
          : `${connectorName} delivery is not configured for failed runs.`,
    };
  }
  return {
    shouldSend: true,
    detail: `${connectorName} delivery rule matched this ${triggerLabel} ${run.status} run.`,
  };
}

function teamsDeliveryTargetLabel(
  delivery: AgentTeamsDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultTarget === false) {
    return formatTeamsTargetLabel(delivery.teamName, delivery.channelName);
  }
  return formatTeamsTargetLabel(
    readConfigLabel(config, "defaultTeamName"),
    readConfigLabel(config, "defaultChannelName"),
  );
}

function formatTeamsTargetLabel(
  teamName: string | undefined,
  channelName: string | undefined,
): string {
  if (teamName && channelName) return `${teamName} -> #${channelName}`;
  if (channelName) return `#${channelName}`;
  if (teamName) return teamName;
  return "configured Teams channel";
}

function whatsAppDeliveryTargetLabel(
  delivery: AgentWhatsAppWebDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultRecipient === false) {
    return delivery.recipientLabel?.trim() || "WhatsApp recipient";
  }
  const label = readConfigLabel(config, "defaultRecipientLabel");
  if (label) return label;
  const type = readConfigLabel(config, "defaultRecipientType");
  const recipient = readConfigLabel(config, "defaultRecipient");
  if (type === "self" || !recipient) return "My WhatsApp";
  if (type === "group" || recipient.endsWith("@g.us")) return "WhatsApp group";
  return "WhatsApp recipient";
}

function outlookDeliveryTargetLabel(
  delivery: AgentOutlookDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultRecipients === false) {
    const label = delivery.recipientLabel?.trim();
    if (label) return label;
    return formatRecipientCount(sanitizeDeliveryList(delivery.recipients), "Outlook");
  }
  const defaultRecipients = sanitizeDeliveryList(
    splitDeliveryList(readConfigLabel(config, "defaultRecipients")),
  );
  return formatRecipientCount(defaultRecipients, "Outlook");
}

function slackDeliveryTargetLabel(
  delivery: AgentSlackDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultChannel === false) {
    return (
      delivery.channelLabel?.trim() ||
      delivery.channel?.trim() ||
      "Slack channel"
    );
  }
  return (
    readConfigLabel(config, "defaultChannelLabel") ||
    readConfigLabel(config, "defaultChannel") ||
    "default Slack channel"
  );
}

function discordDeliveryTargetLabel(
  delivery: AgentDiscordDelivery,
  config: Record<string, unknown>,
): string {
  const label = delivery.targetLabel?.trim() || readConfigLabel(config, "defaultTargetLabel");
  if (label) return label;
  const threadId =
    delivery.useDefaultWebhook === false
      ? delivery.threadId?.trim()
      : readConfigLabel(config, "defaultThreadId");
  return threadId ? "Discord webhook thread" : "Discord webhook";
}

function signalDeliveryTargetLabel(
  delivery: AgentSignalDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultRecipient === false) {
    return delivery.recipientLabel?.trim() || "Signal recipient";
  }
  return readConfigLabel(config, "defaultRecipientLabel") || "Signal recipient";
}

function formatRecipientCount(values: readonly string[], connectorName: string): string {
  if (values.length === 1) return `1 ${connectorName} recipient`;
  if (values.length > 1) return `${values.length} ${connectorName} recipients`;
  return `default ${connectorName} recipients`;
}

function splitDeliveryList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[,\n;]/g);
}

function sanitizeDeliveryList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function readConfigLabel(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function createDeliveryAuditEntry(input: {
  runId: string;
  stepId: string;
  connector: string;
  capability: string;
  idempotencyKey: string;
  egressTarget: string;
  args: unknown;
  status: ConnectorAuditEntry["status"];
  startedAt: number;
  result?: unknown;
  error?: unknown;
}): ConnectorAuditEntry {
  const refs = extractConnectorRefs(input.result);
  const errorMessage =
    input.error instanceof Error
      ? input.error.message
      : input.error !== undefined
        ? String(input.error)
        : undefined;
  return {
    runId: input.runId,
    stepId: input.stepId,
    connector: input.connector,
    capability: input.capability,
    kind: "notify",
    idempotencyKey: input.idempotencyKey,
    egressTarget: input.egressTarget,
    argsDigest: digestDeliveryArgs(input.args),
    status: input.status,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    ...(refs.externalId ? { externalId: refs.externalId } : {}),
    ...(refs.externalUrl ? { externalUrl: refs.externalUrl } : {}),
    ...(input.status === "failure" ? { errorClass: "Error" } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function digestDeliveryArgs(args: unknown): string {
  try {
    return createHash("sha256")
      .update(JSON.stringify(args) ?? "null")
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "unhashable";
  }
}

function extractConnectorRefs(result: unknown): {
  externalId?: string;
  externalUrl?: string;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const obj = result as Record<string, unknown>;
  const externalId =
    typeof obj.messageId === "string"
      ? obj.messageId
      : typeof obj.id === "string"
        ? obj.id
        : undefined;
  const externalUrl =
    typeof obj.webUrl === "string"
      ? obj.webUrl
      : typeof obj.url === "string"
        ? obj.url
        : undefined;
  return {
    ...(externalId ? { externalId } : {}),
    ...(externalUrl ? { externalUrl } : {}),
  };
}

function formatTeamsDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    `## ${agent.name}`,
    "",
    `**Status:** ${status}`,
    `**Tenant:** ${tenant.displayName}`,
    `**Trigger:** ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `**Queued:** ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`**Finding state:** ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(
      `**Model:** ${run.providerId}${run.model ? ` · ${run.model}` : ""}`,
    );
  }
  if (run.error) {
    lines.push("", "### Error", "", run.error);
  }
  if (run.summary) {
    lines.push("", "### Summary", "", run.summary);
  }
  if (run.steps.length > 0) {
    lines.push("", "### Pipeline", "");
    for (const step of run.steps) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
  }
  return lines.join("\n");
}

function formatWhatsAppDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord | undefined,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    "*OpenAdminOS run report*",
    "",
    `Agent: ${agent.name}`,
    `Status: ${status}`,
    `Tenant: ${tenant?.displayName ?? run.tenantId ?? "Unknown tenant"}`,
    `Trigger: ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `Queued: ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`Finding state: ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(`Model: ${run.providerId}${run.model ? ` · ${run.model}` : ""}`);
  }
  if (run.error) {
    lines.push("", "*Error*", truncateForDelivery(run.error, 1200));
  }
  if (run.summary) {
    lines.push("", "*Summary*", truncateForDelivery(run.summary, 2400));
  }
  if (run.steps.length > 0) {
    lines.push("", "*Pipeline*");
    for (const step of run.steps.slice(0, 12)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 12) {
      lines.push(`- ${run.steps.length - 12} more steps`);
    }
  }
  return lines.join("\n");
}

function formatOutlookDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    `## ${agent.name}`,
    "",
    `**Status:** ${status}`,
    `**Tenant:** ${tenant.displayName}`,
    `**Trigger:** ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `**Queued:** ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`**Finding state:** ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(
      `**Model:** ${run.providerId}${run.model ? ` · ${run.model}` : ""}`,
    );
  }
  if (run.error) {
    lines.push("", "### Error", "", truncateForDelivery(run.error, 2000));
  }
  if (run.summary) {
    lines.push("", "### Summary", "", truncateForDelivery(run.summary, 8000));
  }
  if (run.steps.length > 0) {
    lines.push("", "### Pipeline", "");
    for (const step of run.steps.slice(0, 20)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 20) {
      lines.push(`- ${run.steps.length - 20} more steps`);
    }
  }
  return lines.join("\n");
}

function formatChatDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord | undefined,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    "*OpenAdminOS run report*",
    "",
    `*Agent:* ${agent.name}`,
    `*Status:* ${status}`,
    `*Tenant:* ${tenant?.displayName ?? run.tenantId ?? "Unknown tenant"}`,
    `*Trigger:* ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `*Queued:* ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`*Finding state:* ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(`*Model:* ${run.providerId}${run.model ? ` · ${run.model}` : ""}`);
  }
  if (run.error) {
    lines.push("", "*Error*", truncateForDelivery(run.error, 1200));
  }
  if (run.summary) {
    lines.push("", "*Summary*", truncateForDelivery(run.summary, 2400));
  }
  if (run.steps.length > 0) {
    lines.push("", "*Pipeline*");
    for (const step of run.steps.slice(0, 12)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 12) {
      lines.push(`- ${run.steps.length - 12} more steps`);
    }
  }
  return lines.join("\n");
}

function formatPlainDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord | undefined,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    "OpenAdminOS run report",
    "",
    `Agent: ${agent.name}`,
    `Status: ${status}`,
    `Tenant: ${tenant?.displayName ?? run.tenantId ?? "Unknown tenant"}`,
    `Trigger: ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `Queued: ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`Finding state: ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(`Model: ${run.providerId}${run.model ? ` · ${run.model}` : ""}`);
  }
  if (run.error) {
    lines.push("", "Error", truncateForDelivery(run.error, 1200));
  }
  if (run.summary) {
    lines.push("", "Summary", truncateForDelivery(run.summary, 2400));
  }
  if (run.steps.length > 0) {
    lines.push("", "Pipeline");
    for (const step of run.steps.slice(0, 12)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 12) {
      lines.push(`- ${run.steps.length - 12} more steps`);
    }
  }
  return lines.join("\n");
}

function formatDeliveryEmailSubject(run: RunRecord, agent: AgentSummary): string {
  const status = run.status === "completed" ? "completed" : "failed";
  return `OpenAdminOS: ${agent.name} ${status}`;
}

function resolveRunTenant(
  persisted: PersistedState,
  run: RunRecord,
): TenantRecord | undefined {
  const tenantId = run.tenantId ?? persisted.activeTenantId;
  return tenantId
    ? persisted.tenants.find((candidate) => candidate.id === tenantId)
    : undefined;
}

function isRetryableDeliveryError(error: unknown): boolean {
  if (
    error instanceof ConnectorNotConfiguredError ||
    error instanceof ConnectorValidationError
  ) {
    return false;
  }
  if (error && typeof error === "object" && "recovery" in error) {
    const recovery = (error as { recovery?: unknown }).recovery;
    if (recovery === "retry") return true;
    if (recovery === "fatal" || recovery === "reconfigure" || recovery === "reauth") {
      return false;
    }
  }
  return true;
}

function truncateForDelivery(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function trimForPrompt(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 32)).trimEnd()}\n[truncated locally]`;
}

function whatsappWebStatusToConnectorStatus(
  status: WhatsAppWebStatus,
): ConnectorSummary["status"] {
  if (status.state === "connected") return "connected";
  if (status.state === "error") return "error";
  return "needs-setup";
}

function createLocalOnlyTenantSession(): TenantSession {
  return {
    tenantId: "local-device",
    username: "local-device",
    async acquireTokenForScopes(_scopes: string[]): Promise<string> {
      throw new Error(
        "This connector is not running with an active Microsoft 365 tenant session.",
      );
    },
  };
}

function fingerprintRunOutput(run: RunRecord): string {
  const source =
    run.result === undefined
      ? run.summary ?? ""
      : stableStringify(run.result);
  return source
    .replace(/\s+/g, " ")
    .replace(/["'`*_#>-]/g, "")
    .trim()
    .toLowerCase();
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}

async function checkOllama(provider: ProviderSummary): Promise<ProviderSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const endpoint = resolveOllamaEndpoint().replace(/\/$/, "");
  const endpointTrust = classifyOllamaEndpoint(endpoint);
  const trustedProvider = endpointTrust.isLocal
    ? provider
    : {
        ...provider,
        description:
          "Use an Ollama-compatible endpoint outside this device. Tenant prompts leave this device when active.",
        isLocal: false,
      };

  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ...trustedProvider,
        status: "error",
        detail: ollamaEndpointDetail(
          endpointTrust,
          `Ollama responded with HTTP ${response.status}`,
        ),
        models: [],
      };
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const models =
      payload.models
        ?.map((model) => model.name)
        .filter((name): name is string => Boolean(name)) ?? [];

    return {
      ...trustedProvider,
      status: "connected",
      detail: ollamaEndpointDetail(
        endpointTrust,
        models.length > 0
          ? `Running on ${endpoint}`
          : "Ollama is running but no models are installed",
      ),
      models,
      defaultModel: models[0],
    };
  } catch {
    return {
      ...trustedProvider,
      status: "not-installed",
      detail: ollamaEndpointDetail(
        endpointTrust,
        `Ollama is not reachable on ${endpoint}`,
      ),
      models: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAppleFoundation(provider: ProviderSummary): Promise<ProviderSummary> {
  const probe = await probeAppleFoundationLlm();
  if (!probe.installed) {
    return {
      ...provider,
      status: "not-installed",
      detail:
        probe.detail ??
        "Apple Foundation helper is not available. Build OpenAdminOS on a compatible Mac.",
      models: [],
    };
  }

  if (!probe.ready) {
    return {
      ...provider,
      status: "error",
      detail:
        probe.detail ??
        "Apple Intelligence Foundation Models are not available on this Mac.",
      models: probe.models,
      defaultModel: probe.defaultModel,
    };
  }

  return {
    ...provider,
    status: "connected",
    detail: appleFoundationProbeDetail(probe),
    models: probe.models,
    defaultModel: probe.defaultModel,
  };
}

function appleFoundationProbeDetail(
  probe: Awaited<ReturnType<typeof probeAppleFoundationLlm>>,
): string {
  const parts = [
    probe.detail ?? "Apple Intelligence Foundation Models available locally.",
  ];
  if (typeof probe.contextSize === "number") {
    parts.push(`Context window: ${probe.contextSize.toLocaleString()} tokens`);
  }
  if (probe.supportedLanguages && probe.supportedLanguages.length > 0) {
    parts.push(`${probe.supportedLanguages.length} supported locales`);
  }
  return parts.join(" · ");
}

function ollamaEndpointDetail(
  endpointTrust: { isLocal: boolean },
  detail: string,
): string {
  if (endpointTrust.isLocal) return detail;
  return `${detail}. Endpoint is not loopback; prompts leave this device if this provider is active.`;
}

async function checkCodex(provider: ProviderSummary): Promise<ProviderSummary> {
  const probe = await probeCodexLlm();
  if (!probe.installed) {
    return {
      ...provider,
      status: "not-installed",
      detail: probe.detail ?? "Codex CLI (`codex`) is not installed or not on PATH.",
      models: [],
    };
  }

  if (!probe.ready) {
    return {
      ...provider,
      status: "error",
      detail:
        probe.detail ??
        `Codex CLI is installed but not authenticated. Run \`codex login\` and try again.`,
      models: probe.models,
      defaultModel: probe.defaultModel,
    };
  }

  return {
    ...provider,
    status: "connected",
    detail: probe.detail ?? `Authenticated via ${probe.authPath}`,
    models: probe.models,
    defaultModel: probe.defaultModel,
  };
}


/**
 * Project the user-submitted values onto the manifest's declared settings,
 * coercing where it's safe (numeric string -> integer for type: integer)
 * and rejecting unrecognised types. Unknown ids are dropped.
 */
function sanitizeSettingsAgainstSchema(
  declared: TemplateSetting[],
  values: Record<string, unknown>,
  slug: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const def of declared) {
    if (!Object.prototype.hasOwnProperty.call(values, def.id)) continue;
    const raw = values[def.id];
    if (raw === undefined || raw === null) continue;

    switch (def.type) {
      case "integer": {
        const coerced = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(coerced) || !Number.isInteger(coerced)) {
          throw new Error(
            `updateAgentSettings(${slug}): setting "${def.id}" must be an integer (got ${JSON.stringify(raw)}).`,
          );
        }
        result[def.id] = coerced;
        break;
      }
      case "string": {
        if (typeof raw !== "string") {
          throw new Error(
            `updateAgentSettings(${slug}): setting "${def.id}" must be a string (got ${typeof raw}).`,
          );
        }
        result[def.id] = raw;
        break;
      }
      case "boolean": {
        if (typeof raw !== "boolean") {
          throw new Error(
            `updateAgentSettings(${slug}): setting "${def.id}" must be a boolean (got ${typeof raw}).`,
          );
        }
        result[def.id] = raw;
        break;
      }
      default: {
        // Unknown type in the manifest schema — accept the value as-is.
        // A separate slice tightens the schema with JSON Schema export.
        result[def.id] = raw;
      }
    }
  }
  return result;
}

// ─── NL2Agent helpers ─────────────────────────────────────────────────────

/**
 * System prompt for the natural-language → manifest pass. We give the
 * LLM the canonical JSON Schema inline (small and stable enough) and
 * two worked examples so it can pattern-match against the conventions
 * we use in the bundled agents. The temperature is kept low so output
 * stays close to the examples.
 */
type DraftSkillLike = { id: string; format: string; settings: unknown };

function collectGraphStepErrors(manifest: { skills: DraftSkillLike[] }): string[] {
  const errors: string[] = [];
  for (const skill of iterateDraftSkills(manifest.skills)) {
    if (skill.format === "graph") {
      const settings = skill.settings as {
        method?: string;
        path?: string;
        scopes?: string[];
      } | null;
      if (!settings || typeof settings.method !== "string" || typeof settings.path !== "string") {
        continue;
      }
      const result = validatePath(
        settings.method,
        settings.path,
        Array.isArray(settings.scopes) ? settings.scopes : [],
      );
      if (!result.ok) {
        errors.push(
          `graph step "${skill.id}": ${result.reason}${result.suggestion ? ` (${result.suggestion})` : ""}`,
        );
      }
      continue;
    }

    // Generic graph-write — same catalogue check as reads, but the
    // method+path come from the action template. The legacy
    // retire-managed-device kind has its own hardcoded contract and
    // is skipped here.
    if (skill.format === "write") {
      const settings = skill.settings as {
        kind?: string;
        scopes?: string[];
        actionTemplate?: {
          request?: { method?: string; path?: string };
        };
      } | null;
      if (!settings || settings.kind !== "graph-write") continue;
      const request = settings.actionTemplate?.request;
      if (!request || typeof request.method !== "string" || typeof request.path !== "string") {
        continue;
      }
      // The path is templated (e.g. `/users/{{ item.id }}`). The
      // catalogue treats `{...}` segments as wildcards, so we strip
      // Liquid placeholders to a `{}` token before lookup.
      const lookupPath = request.path.replace(/\{\{[^}]+\}\}/g, "{}");
      const result = validatePath(
        request.method,
        lookupPath,
        Array.isArray(settings.scopes) ? settings.scopes : [],
      );
      if (!result.ok) {
        errors.push(
          `write step "${skill.id}": ${result.reason}${result.suggestion ? ` (${result.suggestion})` : ""}`,
        );
      }
    }
  }
  return errors;
}

function collectConnectorStepErrors(manifest: {
  descriptor: {
    connectors?: Array<{
      id: string;
      capabilities: Array<{ id: string; version: number }>;
    }>;
  };
  skills: DraftSkillLike[];
}): string[] {
  const errors: string[] = [];
  const requirements = new Map(
    (manifest.descriptor.connectors ?? []).map((connector) => [
      connector.id,
      connector,
    ]),
  );

  for (const skill of iterateDraftSkills(manifest.skills)) {
    if (skill.format !== "connector") continue;
    const settings = skill.settings as {
      connector?: string;
      capability?: string;
      version?: number;
    } | null;
    if (!settings?.connector || !settings.capability) continue;

    const requirement = requirements.get(settings.connector);
    if (!requirement) {
      errors.push(
        `connector step "${skill.id}": descriptor.connectors must declare "${settings.connector}".`,
      );
      continue;
    }

    const version = settings.version ?? 1;
    const hasCapability = requirement.capabilities.some(
      (capability) =>
        capability.id === settings.capability && capability.version === version,
    );
    if (!hasCapability) {
      errors.push(
        `connector step "${skill.id}": descriptor.connectors.${settings.connector} must declare capability "${settings.capability}" version ${version}.`,
      );
    }
  }

  return errors;
}

function* iterateDraftSkills(skills: DraftSkillLike[]): Iterable<DraftSkillLike> {
  for (const skill of skills) {
    yield skill;
    if (skill.format !== "map") continue;
    const settings = skill.settings as { do?: DraftSkillLike[] } | null;
    if (Array.isArray(settings?.do)) {
      yield* iterateDraftSkills(settings.do);
    }
  }
}

const WRITEY_KEYWORDS = [
  "disable",
  "delete",
  "remove",
  "retire",
  "wipe",
  "revoke",
  "reset",
  "assign",
  "unassign",
  "update",
  "patch",
  "create",
  "add",
  "enable",
  "block",
  "unblock",
  "restore",
];

function promptLooksWritey(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return WRITEY_KEYWORDS.some((keyword) =>
    new RegExp(`\\b${keyword}\\b`).test(lower),
  );
}

function validateAgentDraftSource(
  yamlSource: string,
  reservedSlugs: string[] = [],
): AgentDraft {
  const source = typeof yamlSource === "string" ? yamlSource.trim() : "";
  if (source.length === 0) {
    return {
      yamlSource: "",
      validationErrors: ["Manifest YAML is empty."],
    };
  }

  let manifest: AgentDraft["manifest"];
  const validationErrors: string[] = [];
  try {
    manifest = parseAgentTemplate(source);
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      validationErrors.push(error.message);
    } else if (error instanceof Error) {
      validationErrors.push(error.message);
    } else {
      validationErrors.push(String(error));
    }
  }

  if (manifest && !manifest.skills.some((skill) => skill.format === "llm")) {
    validationErrors.push(
      "Manifest has no `format: llm` step. OpenAdminOS requires every agent to invoke the LLM at least once — add a summary or rationale step.",
    );
    manifest = undefined;
  }

  if (manifest) {
    const reserved = new Set(reservedSlugs);
    const slug = manifest.descriptor.id;
    if (!AGENT_SLUG_RE.test(slug)) {
      validationErrors.push(
        `Slug "${slug}" is invalid. Use lowercase letters, numbers, and single hyphens only, for example "inactive-device-review".`,
      );
      manifest = undefined;
    } else if (reserved.has(slug)) {
      validationErrors.push(
        `Slug "${slug}" is already used by another agent. Try "${suggestAvailableSlug(slug, reserved)}" instead.`,
      );
      manifest = undefined;
    }
  }

  if (manifest) {
    const semanticErrors = [
      ...collectGraphStepErrors(manifest),
      ...collectConnectorStepErrors(manifest),
    ];
    if (semanticErrors.length > 0) {
      validationErrors.push(...semanticErrors);
      manifest = undefined;
    }
  }

  return validationErrors.length > 0
    ? { yamlSource: source, validationErrors }
    : { yamlSource: `${source}\n`, manifest, validationErrors: [] };
}

function assertValidAgentSlug(slug: string): void {
  if (!AGENT_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid agent slug "${slug}". Use lowercase letters, numbers, and single hyphens only.`,
    );
  }
}

function safeUserAgentDirectory(userAgentsDir: string, slug: string): string {
  assertValidAgentSlug(slug);
  const root = resolve(userAgentsDir);
  const target = resolve(root, slug);
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${sep}`) || rel.length === 0) {
    throw new Error(`Invalid user agent directory for slug "${slug}".`);
  }
  return target;
}

function collectManifestScopes(manifest: AgentTemplate): string[] {
  const scopes = new Set<string>();
  for (const skill of iterateDraftSkills(manifest.skills)) {
    if (skill.format === "graph" || skill.format === "write") {
      const settings = skill.settings as { scopes?: string[] };
      if (Array.isArray(settings.scopes)) {
        for (const scope of settings.scopes) scopes.add(scope);
      }
    }
  }
  return [...scopes].sort();
}

function preflightConnectorRequirements(
  manifest: AgentTemplate,
): AgentDraftPreflightResult["checks"] {
  const requirements = manifest.descriptor.connectors ?? [];
  if (requirements.length === 0) {
    return [
      {
        id: "connectors",
        label: "Connectors",
        status: "pass",
        detail: "No connector egress declared.",
      },
    ];
  }

  const registered = new Map(
    listRegisteredConnectors().map((descriptor) => [
      descriptor.id,
      descriptor,
    ]),
  );

  return requirements.map((requirement) => {
    const descriptor = registered.get(requirement.id);
    if (!descriptor) {
      return {
        id: `connector:${requirement.id}`,
        label: `Connector: ${requirement.id}`,
        status: "fail",
        detail: "Connector is not registered in this OpenAdminOS build.",
      };
    }

    const missing = requirement.capabilities.filter(
      (needed) =>
        !descriptor.capabilities.some(
          (actual) =>
            actual.id === needed.id && actual.version === needed.version,
        ),
    );
    if (missing.length > 0) {
      return {
        id: `connector:${requirement.id}`,
        label: `Connector: ${descriptor.name}`,
        status: "fail",
        detail: `Missing capability ${missing.map((cap) => `${cap.id}@${cap.version}`).join(", ")}.`,
      };
    }

    return {
      id: `connector:${requirement.id}`,
      label: `Connector: ${descriptor.name}`,
      status: requirement.required ? "warn" : "pass",
      detail: requirement.required
        ? "Required connector is supported by this build. Configure and test it from Connectors before running this agent."
        : "Optional connector is understood by this build.",
    };
  });
}

function buildAgentReadme(manifest: AgentTemplate): string {
  const scopes = collectManifestScopes(manifest);
  const connectors = manifest.descriptor.connectors ?? [];
  return `# ${manifest.descriptor.name}

${manifest.descriptor.description}

## Mode

${manifest.descriptor.mode === "write" ? "Write agent. Every write action pauses for typed confirmation before Graph changes are applied." : "Read-only agent. It does not mutate tenant state."}

## Graph permissions

${scopes.length > 0 ? scopes.map((scope) => `- \`${scope}\``).join("\n") : "- None declared"}

## Connectors

${connectors.length > 0 ? connectors.map((connector) => `- \`${connector.id}\` (${connector.required ? "required" : "optional"})`).join("\n") : "- None"}

## Local-first note

This bundle was exported from OpenAdminOS. It includes only agent source files and metadata. It does not include tenant data, prompts, run results, provider settings, tokens, or secrets.
`;
}

function buildCommunityAgentReadme(
  manifest: AgentTemplate,
  metadata: AgentCommunitySubmissionMetadata,
): string {
  const scopes = collectManifestScopes(manifest);
  const connectors = manifest.descriptor.connectors ?? [];
  return `# ${metadata.name.trim() || manifest.descriptor.name}

${metadata.description.trim() || manifest.descriptor.description}

## Maintainer

- ${metadata.maintainerName.trim() || "Not provided"}
- Support: ${metadata.supportUrl.trim() || "Not provided"}

## Mode

${manifest.descriptor.mode === "write" ? "Write agent. Every write action pauses for typed confirmation before Graph changes are applied." : "Read-only agent. It does not mutate tenant state."}

## Graph permissions

${scopes.length > 0 ? scopes.map((scope) => `- \`${scope}\``).join("\n") : "- None declared"}

## Connectors

${connectors.length > 0 ? connectors.map((connector) => `- \`${connector.id}\` (${connector.required ? "required" : "optional"})`).join("\n") : "- None"}

## Privacy and egress

${metadata.privacyNotes.trim() || "No additional privacy or egress notes provided."}

## Changelog

${metadata.changelog.trim() || "- Initial community submission."}

## Submission note

This bundle was prepared by OpenAdminOS for public community review. It includes only agent source files and metadata. It does not include tenant data, prompts, run results, provider settings, tokens, or secrets.
`;
}

function buildAgentBundleMetadata(manifest: AgentTemplate) {
  return {
    schema: "openadminos-agent-bundle/v1",
    exportedAt: new Date(0).toISOString(),
    agent: {
      id: manifest.descriptor.id,
      name: manifest.descriptor.name,
      version: manifest.descriptor.version,
      mode: manifest.descriptor.mode,
      category: manifest.descriptor.category,
      scopes: collectManifestScopes(manifest),
      connectors: manifest.descriptor.connectors ?? [],
    },
    files: ["manifest.yaml", "README.md", "metadata.json"],
    excludes: [
      "tenant data",
      "run history",
      "prompts",
      "provider settings",
      "tokens",
      "secrets",
    ],
  };
}

function buildCommunitySubmissionMetadata(
  manifest: AgentTemplate,
  metadata: AgentCommunitySubmissionMetadata,
) {
  return {
    schema: "openadminos-agent-community-submission/v1",
    submittedAt: new Date(0).toISOString(),
    agent: {
      id: manifest.descriptor.id,
      name: metadata.name.trim() || manifest.descriptor.name,
      description: metadata.description.trim() || manifest.descriptor.description,
      version: manifest.descriptor.version,
      mode: manifest.descriptor.mode,
      category: metadata.category || manifest.descriptor.category,
      scopes: collectManifestScopes(manifest),
      connectors: manifest.descriptor.connectors ?? [],
    },
    maintainer: {
      name: metadata.maintainerName.trim(),
      supportUrl: metadata.supportUrl.trim(),
    },
    privacyNotes: metadata.privacyNotes.trim(),
    changelog: metadata.changelog.trim(),
    excludes: [
      "tenant data",
      "run history",
      "prompts",
      "provider settings",
      "tokens",
      "secrets",
    ],
  };
}

function buildAgentCommunitySubmissionReview(
  yamlSource: string,
  metadata: AgentCommunitySubmissionMetadata,
  draft: AgentDraft,
): AgentCommunitySubmissionReview {
  const checks: AgentCommunitySubmissionReview["checks"] = [];
  const manifest = draft.manifest;

  checks.push({
    id: "metadata-name",
    label: "Agent name",
    status: metadata.name.trim().length >= 3 ? "pass" : "fail",
    detail:
      metadata.name.trim().length >= 3
        ? "Name is present."
        : "Agent name is missing or too short.",
    fix: "Use a clear public name, for example `Inactive device reviewer`.",
  });
  checks.push({
    id: "metadata-description",
    label: "Description",
    status: metadata.description.trim().length >= 20 ? "pass" : "fail",
    detail:
      metadata.description.trim().length >= 20
        ? "Description is present."
        : "Description needs enough context for maintainers.",
    fix: "Describe what the agent reads, what it reports, and when an admin should use it.",
  });
  checks.push({
    id: "metadata-maintainer",
    label: "Maintainer",
    status: metadata.maintainerName.trim().length >= 2 ? "pass" : "fail",
    detail:
      metadata.maintainerName.trim().length >= 2
        ? "Maintainer name is present."
        : "Maintainer name is required for review follow-up.",
    fix: "Add your display name or organization name.",
  });
  checks.push(validateSupportUrl(metadata.supportUrl));
  checks.push({
    id: "license",
    label: "License",
    status: metadata.licenseConfirmed ? "pass" : "fail",
    detail: metadata.licenseConfirmed
      ? "MIT contribution confirmation is checked."
      : "Community submissions must be contributed under the project license.",
    fix: "Confirm that you can submit this agent under the MIT license.",
  });
  checks.push({
    id: "privacy-notes",
    label: "Privacy notes",
    status: metadata.privacyNotes.trim().length >= 10 ? "pass" : "fail",
    detail:
      metadata.privacyNotes.trim().length >= 10
        ? "Privacy and egress notes are present."
        : "Privacy and egress notes are missing.",
    fix: "State what data the agent reads and whether it uses connectors or hosted providers.",
  });

  if (!manifest) {
    checks.push({
      id: "manifest",
      label: "Manifest",
      status: "fail",
      detail: draft.validationErrors.join("; ") || "Manifest failed validation.",
      fix: "Open Edit, fix the YAML validation errors, then run QA again.",
    });
    return finalizeCommunitySubmissionReview(yamlSource, metadata, undefined, checks);
  }

  checks.push({
    id: "manifest",
    label: "Manifest",
    status: draft.validationErrors.length === 0 ? "pass" : "fail",
    detail:
      draft.validationErrors.length === 0
        ? "Schema, Graph endpoints, scopes, connector declarations, and LLM-step checks pass."
        : draft.validationErrors.join("; "),
    fix: "Open Edit, fix the YAML validation errors, then run QA again.",
  });
  checks.push({
    id: "metadata-category",
    label: "Category",
    status: metadata.category === manifest.descriptor.category ? "pass" : "fail",
    detail:
      metadata.category === manifest.descriptor.category
        ? "Submission category matches the manifest."
        : `Submission category "${metadata.category}" does not match manifest category "${manifest.descriptor.category}".`,
    fix: "Edit the manifest descriptor.category or choose the matching category before submitting.",
  });

  const writeSteps = manifest.skills.filter((skill) => skill.format === "write");
  checks.push({
    id: "write-confirmation",
    label: "Write confirmation",
    status:
      manifest.descriptor.mode === "write" && writeSteps.length === 0 ? "fail" : "pass",
    detail:
      writeSteps.length > 0
        ? `${writeSteps.length} write step(s) will use typed confirmation.`
        : manifest.descriptor.mode === "write"
          ? "Write agent declares no write step."
          : "Read-only agent has no write steps.",
    fix: "Declare write actions with a confirmation phrase, or change the manifest mode to read.",
  });

  const connectors = manifest.descriptor.connectors ?? [];
  checks.push({
    id: "connectors",
    label: "Connector declarations",
    status: connectors.length > 0 ? "warn" : "pass",
    detail:
      connectors.length > 0
        ? `${connectors.length} connector declaration(s) will be highlighted for maintainer review.`
        : "No connector egress declared.",
    fix: "If connector egress is not intentional, remove the connector declaration and steps.",
  });

  const highRiskScopes = collectManifestScopes(manifest).filter(isHighRiskScope);
  checks.push({
    id: "security-scopes",
    label: "Security flags",
    status:
      highRiskScopes.length > 0 || writeSteps.length > 0 || connectors.length > 0
        ? "warn"
        : "pass",
    detail:
      highRiskScopes.length > 0
        ? `High-risk scope(s) require maintainer review: ${highRiskScopes.join(", ")}.`
        : writeSteps.length > 0
          ? "Write actions require maintainer review."
          : connectors.length > 0
            ? "External connector egress requires maintainer review."
            : "No high-risk scopes, write actions, or connector egress detected.",
    fix: "Keep scopes as narrow as possible and explain why each write or connector action is needed.",
  });

  const secretMatches = findSecretLikeValues(
    [
      yamlSource,
      metadata.name,
      metadata.description,
      metadata.maintainerName,
      metadata.supportUrl,
      metadata.privacyNotes,
      metadata.changelog,
    ].join("\n"),
  );
  checks.push({
    id: "secrets",
    label: "Secret scan",
    status: secretMatches.length === 0 ? "pass" : "fail",
    detail:
      secretMatches.length === 0
        ? "No obvious token, key, password, or tenant-id values found."
        : `Possible secret-like text found: ${secretMatches.join(", ")}.`,
    fix: "Remove tokens, tenant IDs, client secrets, API keys, and environment-specific values before submitting.",
  });

  const readme = buildCommunityAgentReadme(manifest, metadata);
  checks.push({
    id: "readme",
    label: "README",
    status: readme.length > 200 ? "pass" : "fail",
    detail:
      readme.length > 200
        ? "README can be generated from the agent and metadata."
        : "README is too short for review.",
    fix: "Fill in description, privacy notes, and changelog, then run QA again.",
  });

  checks.push({
    id: "public-issue",
    label: "Public issue",
    status: "pass",
    detail: "Submission will create a public GitHub issue for maintainer review.",
  });

  return finalizeCommunitySubmissionReview(yamlSource, metadata, manifest, checks);
}

function finalizeCommunitySubmissionReview(
  yamlSource: string,
  metadata: AgentCommunitySubmissionMetadata,
  manifest: AgentTemplate | undefined,
  checks: AgentCommunitySubmissionReview["checks"],
): AgentCommunitySubmissionReview {
  const fallbackName = metadata.name.trim() || "New agent";
  const issueTitle = `[New Agent] ${manifest?.descriptor.name ?? fallbackName}`;
  const readmeMarkdown = manifest
    ? buildCommunityAgentReadme(manifest, metadata)
    : `# ${fallbackName}\n\n${metadata.description.trim()}\n`;
  const metadataJson = JSON.stringify(
    manifest
      ? buildCommunitySubmissionMetadata(manifest, metadata)
      : { schema: "openadminos-agent-community-submission/v1", agent: { name: fallbackName } },
    null,
    2,
  );
  const issueBody = buildCommunityIssueBody({
    metadata,
    manifest,
    yamlSource,
    readmeMarkdown,
    metadataJson,
    checks,
  });
  const blockingFailures = checks.some((check) => check.status === "fail");
  const bodyTooLarge = issueBody.length > 58_000;
  if (bodyTooLarge) {
    checks.push({
      id: "issue-size",
      label: "Issue size",
      status: "fail",
      detail: "Submission is too large for a GitHub issue.",
      fix: "Shorten long prompt text, comments, descriptions, or embedded examples in the manifest.",
    });
  }
  return {
    ok: !blockingFailures && !bodyTooLarge,
    checks,
    issueTitle,
    issueBody,
    package: {
      manifestYaml: `${yamlSource.trimEnd()}\n`,
      readmeMarkdown,
      metadataJson: `${metadataJson}\n`,
    },
  };
}

function validateSupportUrl(
  supportUrl: string,
): AgentCommunitySubmissionReview["checks"][number] {
  const trimmed = supportUrl.trim();
  if (trimmed.startsWith("@") && trimmed.length > 1) {
    return {
      id: "support",
      label: "Support contact",
      status: "pass",
      detail: "GitHub handle is present.",
    };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "https:" && parsed.hostname.length > 0) {
      return {
        id: "support",
        label: "Support contact",
        status: "pass",
        detail: "Support URL is valid.",
      };
    }
  } catch {
    // handled below
  }
  return {
    id: "support",
    label: "Support contact",
    status: "fail",
    detail: "Support contact must be a GitHub handle or HTTPS URL.",
    fix: "Use `@handle` or an HTTPS URL maintainers can use for follow-up.",
  };
}

function buildCommunityIssueBody(input: {
  metadata: AgentCommunitySubmissionMetadata;
  manifest: AgentTemplate | undefined;
  yamlSource: string;
  readmeMarkdown: string;
  metadataJson: string;
  checks: AgentCommunitySubmissionReview["checks"];
}): string {
  const manifest = input.manifest;
  const scopes = manifest ? collectManifestScopes(manifest) : [];
  const connectors = manifest?.descriptor.connectors ?? [];
  const writeSteps = manifest?.skills.filter((skill) => skill.format === "write") ?? [];
  const checkLines = input.checks
    .map((check) => `- [${check.status === "fail" ? " " : "x"}] ${check.label}: ${check.detail}`)
    .join("\n");
  return `## Summary

${input.metadata.description.trim()}

## Metadata

- Name: ${input.metadata.name.trim()}
- Category: ${input.metadata.category}
- Maintainer: ${input.metadata.maintainerName.trim()}
- Support: ${input.metadata.supportUrl.trim()}
- License confirmed: ${input.metadata.licenseConfirmed ? "yes" : "no"}

## Agent

- Slug: ${manifest?.descriptor.id ?? "Unavailable"}
- Version: ${manifest?.descriptor.version ?? "Unavailable"}
- Mode: ${manifest?.descriptor.mode ?? "Unavailable"}
- Graph scopes: ${scopes.length > 0 ? scopes.map((scope) => `\`${scope}\``).join(", ") : "None declared"}
- Write steps: ${writeSteps.length}
- Connectors: ${connectors.length > 0 ? connectors.map((connector) => `\`${connector.id}\``).join(", ") : "None"}

## Privacy and egress

${input.metadata.privacyNotes.trim()}

## Changelog

${input.metadata.changelog.trim() || "- Initial community submission."}

## Local QA

${checkLines}

## Submitted files

<details>
<summary>manifest.yaml</summary>

\`\`\`yaml
${input.yamlSource.trimEnd()}
\`\`\`
</details>

<details>
<summary>README.md</summary>

\`\`\`md
${input.readmeMarkdown.trimEnd()}
\`\`\`
</details>

<details>
<summary>metadata.json</summary>

\`\`\`json
${input.metadataJson.trimEnd()}
\`\`\`
</details>

## Exclusion statement

This submission was prepared by OpenAdminOS. It must not include tenant data, prompts, run history, provider settings, tokens, or secrets.
`;
}

function isHighRiskScope(scope: string): boolean {
  return (
    scope.includes("ReadWrite") ||
    scope.includes("Privileged") ||
    scope.endsWith(".All") && /Directory|User|Application/.test(scope)
  );
}

function findSecretLikeValues(source: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ["password", /\bpassword\s*[:=]\s*["']?[^"'\s]{6,}/i],
    ["secret", /\b(client[_-]?secret|secret)\s*[:=]\s*["']?[^"'\s]{8,}/i],
    ["api key", /\b(api[_-]?key|token)\s*[:=]\s*["']?[^"'\s]{12,}/i],
    ["tenant id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
    ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ];
  const matches = new Set<string>();
  for (const [label, pattern] of patterns) {
    if (pattern.test(source)) matches.add(label);
  }
  return [...matches];
}

function suggestAvailableSlug(baseSlug: string, reservedSlugs: Set<string>): string {
  const base = baseSlug.replace(/-\d+$/, "") || "custom-agent";
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}-${i}`;
    if (!reservedSlugs.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function formatCandidates(candidates: EndpointSummary[]): string {
  if (candidates.length === 0) return "(none)";
  return candidates
    .map((ep) => {
      const scope =
        ep.scopesDelegated.length > 0
          ? ep.scopesDelegated[0]
          : "(no delegated scope documented)";
      const summary = ep.summary ? ` — ${ep.summary}` : "";
      return `- ${ep.method} ${ep.path} | scope: ${scope}${summary}`;
    })
    .join("\n");
}

function buildNl2AgentSystemPrompt(
  readCandidates: EndpointSummary[],
  writeCandidates: EndpointSummary[] = [],
  reservedSlugs: string[] = [],
): string {
  const readBlock =
    readCandidates.length === 0
      ? "(No catalogue match for this prompt. Pick `GET /deviceManagement/managedDevices` if no better fit exists — it is always available.)"
      : formatCandidates(readCandidates);

  const writeBlock =
    writeCandidates.length === 0
      ? ""
      : `\n\nCandidate write endpoints (use these for a \`graph-write\` step — declare the listed scope):\n${formatCandidates(writeCandidates)}`;

  const reservedSlugBlock =
    reservedSlugs.length === 0
      ? "(none)"
      : reservedSlugs.slice(0, 80).map((slug) => `- ${slug}`).join("\n");

  return `You generate Agent Template manifests for OpenAdminOS — a desktop tool that runs AI agents against a Microsoft 365 tenant.

The manifest is a YAML document with three top-level keys: descriptor, skills, definition.

Hard rules:
- mode is "read" unless the user explicitly asks for a destructive (write) agent.
- category must be one of: devices, apps, policies, compliance, updates.
- Slug ids are lower-case hyphen-separated, e.g. "find-inactive-devices".
- Do not reuse any reserved slug listed below. Pick a specific new slug such as "inactive-device-risk-review" rather than "test-agent".
- New user-authored drafts start at version: 0.1.0. Use SemVer exactly.
- Skill ids are lower-case snake_case, e.g. "load_devices".
- Graph steps: pick the closest match from the candidate endpoints listed below. Do not invent endpoints — if none of the candidates fit, fall back to GET /deviceManagement/managedDevices. Always declare the scope shown alongside the endpoint.
- Query values must be YAML strings, including numeric-looking OData values. Example: $top: "25".
- Transform kinds available: group-by-age, filter-by-age, count-by-field, group-by-field, sort-by, correlate-stale-devices.
- Use definition.settings for user-adjustable values. Reference them as {{ settings.settingId }}. Supported setting types: string, integer, boolean.
- Use a scheduled trigger only when the user asks for recurring checks. Always include a manual trigger too.
- Use a map step when the user asks for per-item triage/rationale/classification. Put the per-item LLM step inside settings.do and add a small limit, e.g. limit: 25.
- Use LLM inputs when the prompt consumes multiple prior outputs: inputs: { devices: "{{ load_devices.output }}", counts: "{{ by_state.output }}" }.
- Use connector steps only when the user explicitly asks to send/post results to Teams. Then merge a descriptor.connectors array into the single top-level descriptor and use a connector step with capability post-channel-message version 1.
- EVERY agent MUST include at least one step with format: llm. This is what makes it an agent rather than a deterministic query — the LLM writes the headline summary an admin reads. Do not gate it with "when:". The runtime preflights the provider and fails the run if one isn't connected, so the gate is unnecessary and misleading.
- definition.result.summary MUST reference the LLM step's output, e.g.: {{ summarize.output.text | default("Summary unavailable.") }}. Do not put raw counts in the summary line — those belong in result.data.
- Write-action kinds available: \`graph-write\` (the generic kind — any POST/PATCH/PUT/DELETE Graph endpoint, with typed-confirmation diff) and \`retire-managed-device\` (legacy alias for POST /deviceManagement/managedDevices/{id}/retire). Always prefer \`graph-write\` for new agents. For write agents, the LLM step should explain the planned actions in plain language and the write step's actionTemplate.label / actionTemplate.description should make every individual action self-explanatory. \`severity: destructive\` is the safe default unless the action is plainly reversible.
- The confirmationPhrase must spell out the operation count and noun in CAPS, e.g. "DISABLE {{ actions | size }} GUEST ACCOUNTS" or "REVOKE {{ actions | size }} SESSIONS". This is what the admin types to approve the plan.
- Templating uses Liquid-subset {{ path.expr | filter }}. Filters available: size, total, sample(n), default("…"), join(", ").
- Always include a top-level "# yaml-language-server: $schema=../../schemas/agent-template.schema.json" comment.

Reserved slugs you must not use:
${reservedSlugBlock}

Candidate Microsoft Graph read endpoints for this prompt (pick from these for graph steps — declare the listed scope):
${readBlock}${writeBlock}

Reference example — read agent, bucketed by compliance state, LLM summary as headline:

# yaml-language-server: $schema=../../schemas/agent-template.schema.json
descriptor:
  id: compliance-overview
  name: Compliance overview
  description: Counts Intune-managed devices by compliance state and writes a plain-language posture summary.
  version: 0.1.0
  author:
    name: OpenAdminOS
    handle: openadminos
    verified: false
  category: compliance
  mode: read
  preferredModel: llama3.1:8b
skills:
  - id: load_devices
    format: graph
    label: Load managed device inventory
    detail: Reads managedDevices from the active tenant.
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      select: [id, deviceName, userPrincipalName, operatingSystem, complianceState, lastSyncDateTime]
      scopes:
        - DeviceManagementManagedDevices.Read.All
  - id: by_state
    format: transform
    label: Count devices by compliance state
    settings:
      kind: count-by-field
      source: "{{ load_devices.output }}"
      field: complianceState
      buckets: [compliant, noncompliant, unknown]
  - id: summarize
    format: llm
    label: Summarize compliance posture
    detail: Two-sentence executive summary plus one prioritised action.
    settings:
      system: >-
        You are a Microsoft 365 administrator's assistant. Be concise and
        factual. Two sentences plus one prioritised action. Never invent
        numbers — use only the figures you are given.
      prompt: |-
        Total devices: {{ load_devices.output | size }}.
        Compliant: {{ by_state.output.compliant }}.
        Noncompliant: {{ by_state.output.noncompliant }}.
        Unknown: {{ by_state.output.unknown }}.

        Write an executive summary. Lead with the biggest risk, then one
        short prioritised action.
      temperature: 0.2
      maxTokens: 200
definition:
  triggers:
    - id: manual
      kind: manual
  result:
    summary: '{{ summarize.output.text | default("Summary unavailable.") }}'
    data:
      total: "{{ load_devices.output | size }}"
      counts: "{{ by_state.output }}"
      llmModel: "{{ summarize.output.model }}"

Pattern snippet — per-item map step with an inner LLM classifier:

  - id: triage_items
    format: map
    label: Classify each risky item
    settings:
      source: "{{ load_items.output }}"
      as: item
      limit: 25
      do:
        - id: classify
          format: llm
          label: Classify this item
          settings:
            system: You are a Microsoft 365 administrator's assistant. Return concise JSON-like text.
            prompt: |-
              Classify this item as likely false positive, likely issue, or unclear.
              Item: {{ item }}
            temperature: 0.1
            maxTokens: 180

Pattern snippet — optional Teams connector delivery when explicitly requested:

descriptor:
  connectors:
    - id: teams
      minVersion: 1.0.0
      required: false
      capabilities:
        - id: post-channel-message
          version: 1
skills:
  - id: post_to_teams
    format: connector
    label: Post report to Teams
    when: ctx.connectors.teams.available
    settings:
      connector: teams
      capability: post-channel-message
      version: 1
      args:
        markdown: "{{ summarize.output.text }}"

Reference example — write agent using graph-write to disable inactive guest users:

# yaml-language-server: $schema=../../schemas/agent-template.schema.json
descriptor:
  id: disable-inactive-guests
  name: Disable inactive guest accounts
  description: Disables guest accounts that have not signed in for 90+ days after typed diff confirmation.
  version: 0.1.0
  author:
    name: OpenAdminOS
    handle: openadminos
    verified: false
  category: policies
  mode: write
  preferredModel: llama3.1:8b
skills:
  - id: load_guests
    format: graph
    label: Load guest accounts
    settings:
      method: GET
      path: /users
      query:
        $filter: "userType eq 'Guest'"
      select: [id, displayName, userPrincipalName, accountEnabled, signInActivity]
      scopes:
        - User.Read.All
        - AuditLog.Read.All
  - id: stale
    format: transform
    label: Pick guests inactive for 90+ days
    settings:
      kind: filter-by-age
      source: "{{ load_guests.output }}"
      timestampField: signInActivity.lastSignInDateTime
      inactiveDaysAtLeast: 90
  - id: explain_plan
    format: llm
    label: Explain the disable plan
    settings:
      system: You are a Microsoft 365 administrator's assistant. Be concise and factual. Never invent numbers.
      prompt: |-
        About to disable {{ stale.output | size }} guest accounts that have
        not signed in for 90+ days. Write a one-paragraph rationale a
        manager could read before approving.
      temperature: 0.2
      maxTokens: 200
  - id: disable_guests
    format: write
    label: Disable inactive guest accounts
    settings:
      kind: graph-write
      source: "{{ stale.output }}"
      confirmationPhrase: "DISABLE {{ actions | size }} GUEST ACCOUNTS"
      scopes:
        - User.ReadWrite.All
      actionTemplate:
        label: "Disable {{ item.userPrincipalName }}"
        description: "Last sign-in {{ item.signInActivity.lastSignInDateTime | default('never') }}"
        severity: destructive
        request:
          method: PATCH
          path: "/users/{{ item.id }}"
          body:
            accountEnabled: false
definition:
  triggers:
    - id: manual
      kind: manual
  result:
    summary: '{{ explain_plan.output.text | default("Summary unavailable.") }}'
    data:
      total: "{{ stale.output | size }}"
      llmModel: "{{ explain_plan.output.model }}"

When the user's description is vague, pick sensible defaults and continue — don't ask clarifying questions. When you cannot fulfil a request inside the available endpoints / transforms, choose the closest supported shape rather than inventing new mechanisms.

Output: a single YAML manifest. Nothing else.`;
}

function buildNl2AgentRepairPrompt(
  originalDescription: string,
  failedDraft: AgentDraft,
): string {
  return `Repair this OpenAdminOS manifest.yaml so it passes validation.

Original user description:
"""
${originalDescription}
"""

Validation errors:
${failedDraft.validationErrors.map((error) => `- ${error}`).join("\n")}

YAML to repair:
"""
${failedDraft.yamlSource}
"""

Return ONLY the corrected YAML manifest. Do not include commentary, headings, or markdown fences.`;
}

function stripCodeFences(source: string): string {
  // The LLM sometimes wraps output in \`\`\`yaml fences despite the system
  // prompt. Strip a leading and trailing fence if present so the
  // parser sees pure YAML.
  let s = source.trim();
  if (s.startsWith("\`\`\`")) {
    const firstNewline = s.indexOf("\n");
    if (firstNewline >= 0) s = s.slice(firstNewline + 1);
    else s = s.slice(3);
  }
  if (s.endsWith("\`\`\`")) {
    s = s.slice(0, -3);
  }
  return s.trim();
}

function sha256(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function buildAgentProvenance(input: {
  agent: RegistryAgentSummary;
  installedAt: string;
  updatedAt?: string;
  manifestText?: string;
  manifestSha256?: string;
  source?: "registry" | "bundled" | "user";
}): NonNullable<AgentSummary["provenance"]> {
  const source =
    input.source ??
    (input.agent.manifestUrl
      ? "registry"
      : input.agent.registryPath?.includes("user-agents")
        ? "user"
        : "bundled");
  return {
    source,
    ...(input.agent.manifestUrl ? { manifestUrl: input.agent.manifestUrl } : {}),
    ...(input.agent.registryPath ? { registryPath: input.agent.registryPath } : {}),
    ...(input.manifestSha256
      ? { manifestSha256: input.manifestSha256 }
      : input.manifestText
        ? { manifestSha256: sha256(input.manifestText) }
        : {}),
    installedVersion: input.agent.version,
    installedAt: input.installedAt,
    ...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
    ...(input.agent.manifestUrl
      ? { registryRef: extractRegistryRef(input.agent.manifestUrl) }
      : {}),
    ...(input.agent.minAppVersion ? { minAppVersion: input.agent.minAppVersion } : {}),
  };
}

function withAgentCompatibility<T extends { minAppVersion?: string; name?: string }>(
  agent: T,
  appVersion: string,
): T & { compatibility: NonNullable<AgentSummary["compatibility"]> } {
  const minAppVersion = agent.minAppVersion ?? "0.1.0";
  const supported = compareSemver(appVersion, minAppVersion) >= 0;
  return {
    ...agent,
    minAppVersion,
    compatibility: {
      supported,
      appVersion,
      minAppVersion,
      ...(supported
        ? {}
        : {
            reason: `${agent.name ?? "This agent"} requires OpenAdminOS ${minAppVersion} or newer. You are running ${appVersion}.`,
          }),
    },
  };
}

function assertAgentCompatible(
  agent: { name?: string; compatibility?: AgentSummary["compatibility"] },
  action: "install" | "run" | "update" | "review",
): void {
  if (agent.compatibility?.supported !== false) return;
  const verb =
    action === "install"
      ? "install"
      : action === "run"
        ? "run"
        : action === "update"
          ? "update"
          : "review updates for";
  throw new Error(
    `Update OpenAdminOS to ${agent.compatibility.minAppVersion} before you ${verb} ${agent.name ?? "this agent"}. Current version: ${agent.compatibility.appVersion}.`,
  );
}

function buildAgentUpdateReview(input: {
  previous: AgentSummary;
  target: RegistryAgentSummary;
  parsedManifest: ReturnType<typeof parseAgentTemplate>;
  manifestText: string;
  manifestSha256: string;
}): AgentUpdateReview {
  const changes: AgentUpdateTrustChange[] = [];
  const previousScopes = new Set(input.previous.scopes);
  const nextScopes = new Set([
    ...input.target.scopes,
    ...collectTemplateScopes(input.parsedManifest.skills),
  ]);
  const addedScopes = [...nextScopes].filter((scope) => !previousScopes.has(scope)).sort();
  if (addedScopes.length > 0) {
    changes.push({
      id: "graph-scopes-added",
      label: "New Graph permissions",
      severity: addedScopes.some(isHighRiskGraphScope) ? "danger" : "warn",
      detail: `Adds ${addedScopes.length} Graph scope${addedScopes.length === 1 ? "" : "s"}: ${addedScopes.join(", ")}.`,
      before: input.previous.scopes.join(", ") || "none",
      after: [...nextScopes].sort().join(", ") || "none",
    });
  }

  const nextWriteKinds = collectWriteKinds(input.parsedManifest.skills);
  if (input.previous.mode !== "write" && input.target.mode === "write") {
    changes.push({
      id: "write-mode-added",
      label: "Write actions enabled",
      severity: "danger",
      detail:
        "This update changes the agent from read-only to write-capable. Runs will require diff confirmation before applying changes.",
      before: input.previous.mode,
      after: input.target.mode,
    });
  } else if (input.previous.mode === "write" && nextWriteKinds.length > 0) {
    changes.push({
      id: "write-actions-reviewed",
      label: "Write action template changed",
      severity: "warn",
      detail: `Review the updated write action kind${nextWriteKinds.length === 1 ? "" : "s"}: ${nextWriteKinds.join(", ")}.`,
      after: nextWriteKinds.join(", "),
    });
  }

  const previousConnectors = new Set(
    (input.previous.connectors ?? []).map((connector) => connector.id),
  );
  const nextConnectors = new Set(
    (input.parsedManifest.descriptor.connectors ?? []).map((connector) => connector.id),
  );
  const addedConnectors = [...nextConnectors]
    .filter((connector) => !previousConnectors.has(connector))
    .sort();
  if (addedConnectors.length > 0) {
    changes.push({
      id: "connector-egress-added",
      label: "New connector egress",
      severity: "danger",
      detail: `Adds external connector access: ${addedConnectors.join(", ")}.`,
      before: [...previousConnectors].sort().join(", ") || "none",
      after: [...nextConnectors].sort().join(", ") || "none",
    });
  }

  const previousMin = input.previous.provenance?.minAppVersion ?? "0.1.0";
  const nextMin = input.target.minAppVersion ?? previousMin;
  if (compareSemver(nextMin, previousMin) > 0) {
    changes.push({
      id: "min-app-version-raised",
      label: "Minimum app version raised",
      severity: "warn",
      detail: `Requires OpenAdminOS ${nextMin} or newer.`,
      before: previousMin,
      after: nextMin,
    });
  }

  if (input.previous.provenance?.manifestSha256 && input.previous.provenance.manifestSha256 !== input.manifestSha256) {
    changes.push({
      id: "manifest-hash-changed",
      label: "Manifest digest changed",
      severity: "info",
      detail: `New SHA-256 digest ${input.manifestSha256.slice(0, 12)}…`,
      before: input.previous.provenance.manifestSha256.slice(0, 12),
      after: input.manifestSha256.slice(0, 12),
    });
  }

  return {
    slug: input.target.slug,
    fromVersion: input.previous.version,
    toVersion: input.target.version,
    manifestUrl: input.target.manifestUrl ?? "",
    manifestSha256: input.manifestSha256,
    requiresConfirmation: changes.some(
      (change) => change.severity === "warn" || change.severity === "danger",
    ),
    changes:
      changes.length > 0
        ? changes
        : [
            {
              id: "metadata-only",
              label: "Metadata-only update",
              severity: "info",
              detail:
                "No new Graph scopes, write actions, connector egress, or app-version requirements detected.",
            },
          ],
  };
}

function collectTemplateScopes(skills: AgentTemplate["skills"]): string[] {
  const scopes = new Set<string>();
  const visit = (steps: AgentTemplate["skills"]): void => {
    for (const step of steps) {
      const value = (step as { settings?: { scopes?: unknown; do?: unknown } }).settings?.scopes;
      if (Array.isArray(value)) {
        for (const scope of value) {
          if (typeof scope === "string") scopes.add(scope);
        }
      }
      const nested = (step as { settings?: { do?: unknown } }).settings?.do;
      if (Array.isArray(nested)) visit(nested as AgentTemplate["skills"]);
    }
  };
  visit(skills);
  return [...scopes];
}

function collectWriteKinds(skills: AgentTemplate["skills"]): string[] {
  const kinds = new Set<string>();
  const visit = (steps: AgentTemplate["skills"]): void => {
    for (const step of steps) {
      if (step.format === "write") {
        kinds.add(step.settings.kind);
      }
      const nested = (step as { settings?: { do?: unknown } }).settings?.do;
      if (Array.isArray(nested)) visit(nested as AgentTemplate["skills"]);
    }
  };
  visit(skills);
  return [...kinds].sort();
}

function isHighRiskGraphScope(scope: string): boolean {
  return /ReadWrite|Privileged|\.All$/i.test(scope) && !/Read\.All$/i.test(scope);
}

function extractRegistryRef(manifestUrl: string): string | undefined {
  const match = manifestUrl.match(/githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//);
  return match?.[1];
}

function sanitizeGraphResources(
  resources: GraphCacheResourceKind[] | undefined,
): GraphCacheResourceKind[] {
  const allowed = new Set(GRAPH_CACHE_RESOURCES.map((entry) => entry.resource));
  const selected = (resources && resources.length > 0
    ? resources
    : GRAPH_CACHE_RESOURCES.map((entry) => entry.resource)
  ).filter((resource): resource is GraphCacheResourceKind => allowed.has(resource));
  return [...new Set(selected)];
}

function tenantNamesById(tenants: TenantRecord[]): Map<string, string> {
  return new Map(tenants.map((tenant) => [tenant.id, tenant.displayName]));
}

function normalizeTenantGroupName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("Tenant group name is required.");
  if (trimmed.length > 80) throw new Error("Tenant group name is too long.");
  return trimmed;
}

function normalizeWorkspaceTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new Error("Workspace title is required.");
  if (trimmed.length > 140) throw new Error("Workspace title is too long.");
  return trimmed;
}

function normalizeWorkspaceInstructions(instructions: string): string {
  const trimmed = instructions.trim();
  if (trimmed.length > 10_000) {
    throw new Error("Workspace instructions are too long.");
  }
  return trimmed;
}

function resolveTenantGroups(scope: TenantScope, groups: TenantGroup[]): TenantGroup[] {
  const groupIds = new Set(
    scope.kind === "selected" || scope.kind === "all" ? scope.groupIds ?? [] : [],
  );
  return groups.filter((group) => groupIds.has(group.id));
}

function resolveTenantScopeIds(input: {
  scope: TenantScope;
  groups: TenantGroup[];
  tenants: TenantRecord[];
  activeTenantId?: string;
}): string[] {
  const known = new Set(input.tenants.map((tenant) => tenant.id));
  if (input.scope.kind === "all") {
    return input.tenants.map((tenant) => tenant.id);
  }
  const selected = new Set<string>();
  if (input.scope.kind === "active") {
    if (input.activeTenantId && known.has(input.activeTenantId)) {
      selected.add(input.activeTenantId);
    }
  } else {
    for (const tenantId of input.scope.tenantIds) {
      if (!known.has(tenantId)) throw new Error(`Unknown tenant selected: ${tenantId}`);
      selected.add(tenantId);
    }
  }
  for (const group of input.groups) {
    for (const tenantId of group.tenantIds) {
      if (known.has(tenantId)) selected.add(tenantId);
    }
  }
  return [...selected];
}

function isWindowsCompliancePrompt(prompt: string): boolean {
  return /\b(windows|device|devices|compliant|non-?compliant|compliance)\b/i.test(prompt);
}

function isGraphCacheStatusStale(status: GraphCacheResourceStatus): boolean {
  if (status.lastError) return false;
  if (!status.refreshedAt || status.rows === 0) return true;
  const refreshedMs = Date.parse(status.refreshedAt);
  if (!Number.isFinite(refreshedMs)) return true;
  return Date.now() - refreshedMs > 6 * 60 * 60 * 1000;
}

function newestRefreshedAt(statuses: GraphCacheResourceStatus[]): string | undefined {
  return statuses
    .map((status) => status.refreshedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
}

function tenantReadinessStatus(input: {
  missingScopes: string[];
  staleResources: GraphCacheResourceKind[];
  errors: string[];
  hasRows: boolean;
}): TenantReadinessStatus {
  if (input.missingScopes.length > 0) return "missing-scopes";
  if (input.errors.some((error) => /throttl|429|too many requests/i.test(error))) {
    return "throttled";
  }
  if (input.errors.some((error) => /expired|interaction required|login/i.test(error))) {
    return "expired";
  }
  if (input.errors.length > 0 && !input.hasRows) return "failed";
  if (input.staleResources.length > 0 || !input.hasRows) return "stale";
  return "ready";
}

function readinessWarnings(input: {
  status: TenantReadinessStatus;
  staleResources: GraphCacheResourceKind[];
  errors: string[];
}): string[] {
  const warnings: string[] = [];
  if (input.status === "stale") {
    warnings.push(
      input.staleResources.length > 0
        ? `${input.staleResources.length} resource cache needs refresh.`
        : "No local cache rows yet.",
    );
  }
  if (input.errors.length > 0) warnings.push(input.errors[0]!);
  return warnings;
}

function readinessRecovery(status: TenantReadinessStatus): string {
  const copy: Record<TenantReadinessStatus, string> = {
    ready: "Ready to run.",
    stale: "Run can refresh cache before answering.",
    expired: "Reconnect this tenant before including it.",
    "missing-scopes": "Grant the missing delegated Graph scopes, then retry.",
    throttled: "Wait for Microsoft Graph throttling to clear or remove this tenant.",
    skipped: "Tenant is skipped for this run.",
    failed: "Review the cached error or remove this tenant from the run.",
  };
  return copy[status];
}

function emptyMultiTenantSummary(): MultiTenantChatJob["summary"] {
  return {
    tenantsScanned: 0,
    failedTenants: 0,
    skippedTenants: 0,
    staleTenants: 0,
    windowsDevices: 0,
    compliant: 0,
    nonCompliant: 0,
    unknown: 0,
  };
}

function updateJobTenantProgress(
  job: MultiTenantChatJob,
  tenantId: string,
  patch: Partial<MultiTenantChatJob["progress"][number]>,
): MultiTenantChatJob {
  return {
    ...job,
    progress: job.progress.map((entry) =>
      entry.tenantId === tenantId ? { ...entry, ...patch } : entry,
    ),
    updatedAt: new Date().toISOString(),
  };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index];
      index += 1;
      if (item !== undefined) {
        await worker(item);
      }
    }
  });
  await Promise.all(workers);
}

function normalizeMultiTenantDeviceRow(input: {
  row: unknown;
  tenantId: string;
  tenantName: string;
  sourceRefreshedAt?: string;
}): MultiTenantDeviceRow | undefined {
  if (!isRecord(input.row)) return undefined;
  const deviceName = stringValue(input.row.deviceName) ?? stringValue(input.row.displayName);
  const operatingSystem = stringValue(input.row.operatingSystem) ?? "Unknown";
  if (!deviceName) return undefined;
  const lastSyncDateTime = stringValue(input.row.lastSyncDateTime);
  const stale = lastSyncDateTime
    ? Date.now() - Date.parse(lastSyncDateTime) > 7 * 24 * 60 * 60 * 1000
    : true;
  return {
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    deviceId: stringValue(input.row.id),
    deviceName,
    complianceState:
      stringValue(input.row.complianceState) ??
      stringValue(input.row.complianceStatus) ??
      "unknown",
    operatingSystem,
    osVersion: stringValue(input.row.osVersion),
    lastSyncDateTime,
    owner:
      stringValue(input.row.userPrincipalName) ??
      stringValue(input.row.emailAddress) ??
      stringValue(input.row.owner),
    sourceRefreshedAt: input.sourceRefreshedAt,
    stale,
  };
}

function buildTenantComparison(input: {
  tenant: TenantScopePreflight["tenants"][number];
  rows: MultiTenantDeviceRow[];
}): MultiTenantTenantComparison {
  let compliant = 0;
  let nonCompliant = 0;
  let unknown = 0;
  for (const row of input.rows) {
    const state = normalizeComplianceState(row.complianceState);
    if (state === "compliant") compliant += 1;
    else if (state === "non-compliant") nonCompliant += 1;
    else unknown += 1;
  }
  return {
    tenantId: input.tenant.tenantId,
    tenantName: input.tenant.tenantName,
    status: input.tenant.status === "stale" ? "stale" : "ready",
    windowsDevices: input.rows.length,
    compliant,
    nonCompliant,
    unknown,
    lastRefresh: newestString(input.rows.map((row) => row.sourceRefreshedAt)),
    warnings: input.tenant.warnings,
  };
}

function normalizeComplianceState(value: string): "compliant" | "non-compliant" | "unknown" {
  const normalized = value.toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "compliant") return "compliant";
  if (normalized === "noncompliant" || normalized === "non-compliant") {
    return "non-compliant";
  }
  return "unknown";
}

function buildMultiTenantSummary(
  comparisons: MultiTenantTenantComparison[],
): MultiTenantChatJob["summary"] {
  return comparisons.reduce(
    (summary, tenant) => ({
      tenantsScanned: summary.tenantsScanned + 1,
      failedTenants:
        summary.failedTenants +
        (["failed", "expired", "missing-scopes", "throttled"].includes(tenant.status)
          ? 1
          : 0),
      skippedTenants: summary.skippedTenants + (tenant.status === "skipped" ? 1 : 0),
      staleTenants: summary.staleTenants + (tenant.status === "stale" ? 1 : 0),
      windowsDevices: summary.windowsDevices + tenant.windowsDevices,
      compliant: summary.compliant + tenant.compliant,
      nonCompliant: summary.nonCompliant + tenant.nonCompliant,
      unknown: summary.unknown + tenant.unknown,
    }),
    emptyMultiTenantSummary(),
  );
}

function buildMultiTenantDossierMarkdown(input: {
  prompt: string;
  providerName: string;
  model?: string;
  generatedAt: string;
  summary: MultiTenantChatJob["summary"];
  comparisons: MultiTenantTenantComparison[];
  rows: MultiTenantDeviceRow[];
}): string {
  const lines = [
    "# Multi-tenant Intune Chat dossier",
    "",
    `Generated: ${input.generatedAt}`,
    `Provider: ${input.providerName}${input.model ? ` · ${input.model}` : ""}`,
    `Query: ${input.prompt}`,
    "",
    "## Summary",
    "",
    `- Tenants scanned: ${input.summary.tenantsScanned}`,
    `- Failed tenants: ${input.summary.failedTenants}`,
    `- Stale tenants: ${input.summary.staleTenants}`,
    `- Windows devices: ${input.summary.windowsDevices}`,
    `- Compliant: ${input.summary.compliant}`,
    `- Non-compliant: ${input.summary.nonCompliant}`,
    `- Unknown: ${input.summary.unknown}`,
    "",
    "## Tenant Comparison",
    "",
    "| Tenant | Status | Windows | Compliant | Non-compliant | Unknown | Last refresh |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const tenant of input.comparisons) {
    lines.push(
      `| ${tenant.tenantName} | ${tenant.status} | ${tenant.windowsDevices} | ${tenant.compliant} | ${tenant.nonCompliant} | ${tenant.unknown} | ${tenant.lastRefresh ?? "unknown"} |`,
    );
  }
  lines.push("", "## Device Rows", "");
  lines.push("| Tenant | Device | Compliance | OS | OS version | Last sync | Owner |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of input.rows) {
    lines.push(
      `| ${row.tenantName} | ${row.deviceName} | ${row.complianceState} | ${row.operatingSystem} | ${row.osVersion ?? ""} | ${row.lastSyncDateTime ?? ""} | ${row.owner ?? ""} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function summarizeMultiTenantResult(
  summary: MultiTenantChatJob["summary"],
  comparisons: MultiTenantTenantComparison[],
): string {
  const caveats = comparisons
    .filter((tenant) => tenant.status !== "ready")
    .map((tenant) => `${tenant.tenantName}: ${tenant.status}`);
  const caveatText =
    caveats.length > 0
      ? ` Caveats: ${caveats.join("; ")}.`
      : " No tenant failures were recorded.";
  return `Across ${summary.tenantsScanned} tenant${summary.tenantsScanned === 1 ? "" : "s"}, cached Intune data shows ${summary.windowsDevices} Windows devices: ${summary.compliant} compliant, ${summary.nonCompliant} non-compliant, and ${summary.unknown} unknown.${caveatText}`;
}

function assertConversationTenant(
  conversation: IntuneChatConversation,
  activeTenantId: string,
): void {
  if (conversation.scopeKind === "multi-tenant") {
    throw new Error(
      "This is a multi-tenant result conversation. Start a new active-tenant conversation for follow-up prompts.",
    );
  }
  if (conversation.tenantId && conversation.tenantId !== activeTenantId) {
    throw new Error(
      "This conversation belongs to a different tenant. Switch to that tenant or start a new conversation.",
    );
  }
}

function newestString(values: (string | undefined)[]): string | undefined {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPlannedChatRows(
  store: IntelligenceSqliteStore,
  input: {
    tenantId: string;
    question: string;
    generatedAt: string;
    resources: GraphCacheResourceKind[];
    searchTerms: string[];
    limitPerResource: number;
  },
): Record<GraphCacheResourceKind, unknown[]> {
  const rows = store.readGraphRows({
    tenantId: input.tenantId,
    resources: input.resources,
    searchTerms: input.searchTerms,
    limitPerResource: input.limitPerResource,
  });
  const staleSyncDays = staleManagedDeviceSyncThresholdDays(input.question);
  if (staleSyncDays !== undefined && input.resources.includes("managedDevices")) {
    rows.managedDevices = store.readManagedDevicesLastSyncBefore({
      tenantId: input.tenantId,
      thresholdIso: thresholdIsoDaysBefore(input.generatedAt, staleSyncDays),
      limit: input.limitPerResource,
    });
  }
  return rows;
}

const GRAPH_CACHE_PAGE_LIMIT = 10;
const GRAPH_CACHE_ROW_LIMIT = 1000;

interface GraphCacheRequestPage {
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
}

interface GraphCollectionPage {
  rows: unknown[];
  nextLink?: string;
}

async function fetchGraphCachePages(
  graph: RunGraphApi,
  request: GraphCacheRequestPage,
): Promise<{ rows: unknown[]; pages: number; pageLimitReached: boolean }> {
  const rows: unknown[] = [];
  let pages = 0;
  let nextRequest: GraphCacheRequestPage | undefined = request;
  let pendingNextLink: string | undefined;

  while (
    nextRequest &&
    pages < GRAPH_CACHE_PAGE_LIMIT &&
    rows.length < GRAPH_CACHE_ROW_LIMIT
  ) {
    const response = await graph.request({
      method: "GET",
      path: nextRequest.path,
      ...(nextRequest.query && Object.keys(nextRequest.query).length > 0
        ? { query: nextRequest.query }
        : {}),
      ...(nextRequest.headers ? { headers: nextRequest.headers } : {}),
    });
    const page = unwrapGraphCollectionPage(response);
    pages += 1;
    const remainingRows = GRAPH_CACHE_ROW_LIMIT - rows.length;
    rows.push(...page.rows.slice(0, remainingRows));
    pendingNextLink = page.nextLink;
    nextRequest = page.nextLink
      ? graphCacheRequestFromNextLink(page.nextLink, request.headers)
      : undefined;
  }

  return {
    rows,
    pages,
    pageLimitReached: Boolean(pendingNextLink),
  };
}

function graphCacheRequestFromNextLink(
  nextLink: string,
  headers: Record<string, string> | undefined,
): GraphCacheRequestPage {
  const url = new URL(nextLink, "https://graph.microsoft.com");
  const path = url.pathname.replace(/^\/(?:beta|v1\.0)(?=\/)/, "");
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    query[key] = value;
  }
  return {
    path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(headers ? { headers } : {}),
  };
}

function buildChatProgressSteps(input: {
  refreshResources: GraphCacheResourceKind[];
  refreshResults: GraphCacheRefreshResourceResult[];
  activeResource?: GraphCacheResourceKind;
  cacheCheckStatus: IntuneChatProgressStep["status"];
  contextStatus: IntuneChatProgressStep["status"];
  modelStatus: IntuneChatProgressStep["status"];
}): IntuneChatProgressStep[] {
  const resultsByResource = new Map(
    input.refreshResults.map((result) => [result.resource, result]),
  );
  const steps: IntuneChatProgressStep[] = [
    {
      id: "cache-check",
      label: "Check cached tenant data",
      status: input.cacheCheckStatus,
    },
  ];

  for (const resource of input.refreshResources) {
    const result = resultsByResource.get(resource);
    const definition = definitionForResource(resource);
    steps.push({
      id: `refresh-${resource}`,
      label: `Refresh ${definition.label}`,
      status: result
        ? result.ok
          ? "completed"
          : "failed"
        : input.activeResource === resource
          ? "active"
          : "pending",
      ...(result
        ? {
            detail: result.ok
              ? graphCacheRefreshDetail(result)
              : result.error,
          }
        : {}),
    });
  }

  steps.push(
    {
      id: "context-pack",
      label: "Build answer context",
      status: input.contextStatus,
    },
    {
      id: "model-answer",
      label: "Generate response",
      status: input.modelStatus,
    },
  );
  return steps;
}

function graphCacheRefreshDetail(result: GraphCacheRefreshResourceResult): string {
  const rowLabel = `${result.rows.toLocaleString()} row${result.rows === 1 ? "" : "s"} cached`;
  const pageLabel =
    typeof result.pages === "number" && result.pages > 1
      ? ` across ${result.pages.toLocaleString()} pages`
      : "";
  return result.pageLimitReached
    ? `${rowLabel}${pageLabel} · capped`
    : `${rowLabel}${pageLabel}`;
}

function estimateChatProgressPercent(steps: IntuneChatProgressStep[]): number {
  if (steps.length === 0) return 0;
  const score = steps.reduce((sum, step) => {
    if (step.status === "completed" || step.status === "failed") return sum + 1;
    if (step.status === "active") return sum + 0.45;
    return sum;
  }, 0);
  return Math.max(5, Math.min(100, Math.round((score / steps.length) * 100)));
}

function unwrapGraphCollectionPage(response: unknown): GraphCollectionPage {
  if (Array.isArray(response)) return { rows: response };
  if (
    typeof response === "object" &&
    response !== null &&
    Array.isArray((response as { value?: unknown }).value)
  ) {
    const record = response as { value: unknown[]; "@odata.nextLink"?: unknown };
    return {
      rows: record.value,
      nextLink:
        typeof record["@odata.nextLink"] === "string"
          ? record["@odata.nextLink"]
          : undefined,
    };
  }
  return { rows: response === undefined || response === null ? [] : [response] };
}

interface IntuneChatProviderBudget {
  limitPerResource: number;
  maxTokens: number;
  answerPackLimits: NonNullable<Parameters<typeof buildAnswerPack>[0]["limits"]>;
}

function intuneChatProviderBudget(providerId: ProviderId): IntuneChatProviderBudget {
  if (providerId === "apple-foundation") {
    return {
      limitPerResource: 12,
      maxTokens: 512,
      answerPackLimits: {
        profile: "apple-foundation-small-context",
        maxRowsReadPerResource: 12,
        maxSampleRowsPerResource: 6,
        maxFindingSampleRows: 6,
        maxAgentSuggestions: 2,
      },
    };
  }
  return {
    limitPerResource: 40,
    maxTokens: 900,
    answerPackLimits: {
      profile: "default",
      maxRowsReadPerResource: 40,
      maxSampleRowsPerResource: 20,
      maxFindingSampleRows: 20,
    },
  };
}

function buildIntuneChatSystemPrompt(isLocalProvider: boolean): string {
  return [
    "You are OpenAdminOS Intune Chat.",
    "Answer Microsoft 365 admin questions only from the retrieved tenant context supplied by the host.",
    "If the context is missing, stale, partial, or has Graph errors, say that plainly.",
    "Do not invent tenant state, counts, users, devices, policies, or remediation results.",
    "Do not perform or imply Graph writes from chat. For changes, tell the admin to run an installed write agent so confirmation remains enforced.",
    isLocalProvider
      ? "The selected provider is local; keep wording consistent with local-only trust."
      : "The selected provider is hosted; be explicit when tenant context is being used to produce the answer.",
    "Use concise admin-facing prose. No hype, no exclamation marks.",
  ].join("\n");
}

function withSelfTrainingOverlay(base: RunLlmApi, overlay: string): RunLlmApi {
  const composeSystem = (system: string | undefined) =>
    [system, overlay].filter((part): part is string => Boolean(part)).join("\n\n");
  return {
    get available() {
      return base.available;
    },
    get defaultModel() {
      return base.defaultModel;
    },
    complete: (options) =>
      base.complete({
        ...options,
        system: composeSystem(options.system),
      }),
    async *stream(options) {
      yield* base.stream({
        ...options,
        system: composeSystem(options.system),
      });
    },
  };
}

function stableSuggestionId(tenantId: string, agentSlug: string, text: string): string {
  return `suggestion_${createHash("sha256")
    .update(`${tenantId}:${agentSlug}:${text}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function buildIntuneChatSources(input: {
  cacheStatus: GraphCacheStatus["resources"];
  plannedResources: GraphCacheResourceKind[];
  refreshedResources: Set<GraphCacheResourceKind>;
}): NonNullable<IntuneChatMessage["sources"]> {
  return input.cacheStatus
    .filter((status) => input.plannedResources.includes(status.resource))
    .map((status) => {
      const request = pathForResource(status.resource);
      return {
        resource: status.resource,
        label: status.label,
        rows: status.rows,
        pages: status.pages,
        pageLimitReached: status.pageLimitReached,
        refreshedAt: status.refreshedAt,
        source: input.refreshedResources.has(status.resource)
          ? "live" as const
          : "cache" as const,
        path: request.path,
        ...(request.select ? { select: request.select } : {}),
        ...(request.query ? { query: request.query } : {}),
        ...(status.lastError ? { error: status.lastError } : {}),
      };
    });
}

function normalizeChatConversationTitle(title: string): string {
  const normalized = chatTitleForPrompt(title);
  if (!normalized.trim()) {
    throw new Error("Conversation title is required.");
  }
  return normalized;
}

function hashTenantId(tenantId: string): string {
  return createHash("sha256").update(tenantId).digest("hex").slice(0, 24);
}

function buildSelfTrainingYaml(input: {
  agentSlug: string;
  tenantKey: string;
  updatedAt: string;
  suggestions: SelfTrainingSuggestion[];
}): string {
  const lines = [
    "schemaVersion: 1",
    `agentSlug: ${quoteYaml(input.agentSlug)}`,
    `tenantKey: ${quoteYaml(input.tenantKey)}`,
    "enabled: true",
    `updatedAt: ${quoteYaml(input.updatedAt)}`,
    "",
    "instructions:",
  ];
  if (input.suggestions.length === 0) {
    lines.push("  []");
  } else {
    for (const suggestion of input.suggestions) {
      lines.push(`  - id: ${quoteYaml(suggestion.id)}`);
      lines.push("    status: active");
      lines.push(`    source: ${quoteYaml(suggestion.source)}`);
      lines.push(`    createdAt: ${quoteYaml(suggestion.createdAt)}`);
      lines.push("    text: |-");
      lines.push(...indentBlock(suggestion.text, 6));
    }
  }
  lines.push("", "metadata:");
  lines.push(`  acceptedSuggestions: ${input.suggestions.length}`);
  lines.push("  note: Approved local self-training only. This file cannot add scopes, change mode, or bypass confirmation.");
  return `${lines.join("\n")}\n`;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}

function indentBlock(value: string, spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return value.split(/\r?\n/).map((line) => `${prefix}${line}`);
}

export const __agentDraftTestUtils = {
  validateAgentDraftSource,
  buildNl2AgentSystemPrompt,
  buildAgentCommunitySubmissionReview,
};
