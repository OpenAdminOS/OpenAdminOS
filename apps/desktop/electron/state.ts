import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  acquireTokenSilent,
  compareSemver,
  createGraphAdapter,
  createCodexLlm,
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
  ManifestValidationError,
  removeAccount,
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
  RequestedScope,
  RunGraphApi,
  RunLlmApi,
  RunLogLevel,
  ProviderTestResult,
  StartRunOptions,
  AgentTemplate,
  TemplateSetting,
  TenantRecord,
  TenantSession,
} from "@openadminos/agent-sdk";
import {
  deriveTrustState,
  providerCatalog,
  type AgentSchedule,
  type AgentSummary,
  type AgentTeamsDelivery,
  type AppState,
  type ProviderId,
  type ProviderSummary,
  type RegistryAgentSummary,
  type RunRecord,
} from "@openadminos/agent-sdk";
import type { PublicClientApplication } from "@azure/msal-node";

import { SafeStorageTokenCacheStore } from "./secret-store.js";
import { requestConnectorConfirmation } from "./connector-confirm-bridge.js";
import {
  searchEndpoints,
  validatePath,
  type EndpointSummary,
} from "./graph-catalog.js";
import {
  DEFAULT_REGISTRY_SOURCE,
  refreshRegistry,
  type RegistryIndexEntry,
} from "./registry-client.js";

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
  /** User-overridable registry source URL. */
  registrySource?: string;
}

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
   * Base URL for the install-stats aggregator. Pass `""` to disable
   * the POST entirely (the recommended setting for dev builds so we
   * don't pollute production counters). Defaults to the official
   * deployment URL.
   */
  statsApiUrl?: string;
  /** Version string POSTed alongside install events, e.g. `0.1.5`. */
  appVersion?: string;
  /** Writable userData directory used for the registry cache. */
  userDataPath?: string;
}

export class AppStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;
  private readonly tokenStore: TokenCacheStorage;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly userAgentsDir: string | undefined;
  private readonly onRunFinished: ((run: RunRecord) => void) | undefined;
  private readonly statsApiUrl: string;
  private readonly appVersion: string;
  private readonly userDataPath: string | undefined;
  private msalClient: PublicClientApplication | undefined;
  // Soft-cancel set. While a run id is here, progress snapshots from
  // the runtime are dropped so the run stays in "cancelled" state. The
  // background driver eventually returns; we don't (yet) plumb an
  // AbortSignal through the runtime to interrupt it mid-flight.
  private readonly cancelledRunIds = new Set<string>();

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
      this.statsApiUrl = "";
      this.appVersion = "0.0.0";
      this.userDataPath = undefined;
    } else {
      this.filePath = options.filePath;
      this.tokenStore = options.tokenStore;
      this.openBrowser = options.openBrowser ?? (async () => undefined);
      this.userAgentsDir = options.userAgentsDir;
      this.onRunFinished = options.onRunFinished;
      this.statsApiUrl =
        typeof options.statsApiUrl === "string"
          ? options.statsApiUrl
          : DEFAULT_STATS_API_URL;
      this.appVersion = options.appVersion ?? "0.0.0";
      this.userDataPath = options.userDataPath;
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

  private agentUpdatesRoot(): string | undefined {
    return this.userDataPath ? join(this.userDataPath, "agent-updates") : undefined;
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
   * remote registry will serve once it's public; this dual-source
   * approach means the app works in private preview today and
   * transparently switches to remote when the repo is flipped public.
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
    const result = await refreshRegistry(this.userDataPath, registrySource);

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
  ): Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }> {
    await this.serialize(async () => {
      const current = await this.read();
      const next = { ...current, registrySource: url };
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

  private getMsalClient(): PublicClientApplication {
    if (this.msalClient) return this.msalClient;
    const cacheStorage: TokenCacheStorage = {
      read: () => this.tokenStore.read(),
      write: (serialized) => this.tokenStore.write(serialized),
    };
    this.msalClient = createMsalClient({ storage: cacheStorage });
    return this.msalClient;
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
      trust: deriveTrustState({ provider: activeProvider, activeTenant }),
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
    if (!tenant) {
      throw new Error(
        "No tenant connected. Connect a Microsoft 365 tenant before testing connectors.",
      );
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

    const storedConfig =
      persisted.connectors?.[connectorId]?.config ?? {};

    const buildContext = {
      tenant: tenantSession,
      config: storedConfig,
      secrets: noSecrets,
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
        status = health.healthy ? "connected" : "error";
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
      map[id] = entry.config ?? {};
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
    if (!tenant) {
      throw new Error(
        "No tenant connected. Connect a Microsoft 365 tenant before invoking connectors.",
      );
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
    const config = persisted.connectors?.[connectorId]?.config ?? {};
    const instance = await factory.build({
      tenant: tenantSession,
      config,
      secrets: noSecrets,
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
      const userPinnedModel =
        persisted.activeModelByProviderId?.[providerId] ?? undefined;
      let model: string | undefined;
      if (typeof options.model === "string" && options.model.length > 0) {
        if (knownModels.length > 0 && !knownModels.includes(options.model)) {
          const recovery =
            activeProvider?.id === "ollama"
              ? ` Pull it with \`ollama pull ${options.model}\` and try again.`
              : " Pick one of the models reported by the provider and try again.";
          throw new Error(
            `Model "${options.model}" is not available for ${activeProvider?.name ?? providerId}.${recovery}`,
          );
        }
        model = options.model;
      } else if (
        agent.preferredModel &&
        knownModels.includes(agent.preferredModel)
      ) {
        model = agent.preferredModel;
      } else if (userPinnedModel && knownModels.includes(userPinnedModel)) {
        model = userPinnedModel;
      } else {
        model = activeProvider?.defaultModel;
      }

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

    void this.driveRun({
      run: queued.queuedRun,
      agent: queued.agent,
      providerId: queued.providerId,
      model: queued.model,
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
      const model = run.model ?? activeProvider?.defaultModel;

      return { agent, providerId, model, updated };
    });

    void this.driveApply({
      run: transition.updated,
      agent: transition.agent,
      providerId: transition.providerId,
      model: transition.model,
      plan: transition.updated.plan!,
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
      const llm = await this.buildLlm(input.providerId, input.model);
      const selection = await this.buildGraph(input.run.tenantId, input.agent.scopes);
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
      const llm = await this.buildLlm(input.providerId, input.model);
      const selection = await this.buildGraph(input.run.tenantId, input.agent.scopes);
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
      void this.deliverRunToTeams(deliveryCandidate);
    }
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

  private async deliverRunToTeams(run: RunRecord): Promise<void> {
    const persisted = await this.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.teams;
    if (!agent || !shouldDeliverRunToTeams(run, delivery)) return;

    const tenantId = run.tenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((candidate) => candidate.id === tenantId)
      : undefined;
    if (!tenant) {
      await this.appendRunLog(run.id, "warn", "Teams delivery skipped: no tenant session available.");
      return;
    }

    const factory = findConnectorFactory("teams");
    if (!factory) {
      await this.appendRunLog(run.id, "warn", "Teams delivery skipped: Teams connector is not registered.");
      return;
    }

    const baseConfig = persisted.connectors?.teams?.config ?? {};
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

    const instance = await factory.build({
      tenant: tenantSession,
      config,
      secrets: noSecrets,
      log: () => undefined,
      idempotencyKeyFor: (stepId, iteration) =>
        `${run.id}:teams-delivery:${stepId}:${iteration}`,
    });

    try {
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
      await capabilities.postChannelMessage({
        ...(delivery?.useDefaultTarget === false && delivery.teamId
          ? { teamId: delivery.teamId }
          : {}),
        ...(delivery?.useDefaultTarget === false && delivery.channelId
          ? { channelId: delivery.channelId }
          : {}),
        markdown: formatTeamsDeliveryMessage(run, agent, tenant),
      });
      await this.appendRunLog(run.id, "info", "Run report delivered to Microsoft Teams.", {
        connectorId: "teams",
      });
    } catch (error) {
      await this.appendRunLog(
        run.id,
        "warn",
        `Teams delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        { connectorId: "teams" },
      );
    } finally {
      await instance.dispose().catch(() => undefined);
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
      if (typeof parsed.registrySource === "string" && parsed.registrySource.length > 0) {
        state.registrySource = parsed.registrySource;
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

function removeEmptyDelivery(
  delivery: NonNullable<AgentSummary["delivery"]>,
): AgentSummary["delivery"] {
  return delivery.teams ? delivery : undefined;
}

function shouldDeliverRunToTeams(
  run: RunRecord,
  delivery: AgentTeamsDelivery | undefined,
): delivery is AgentTeamsDelivery {
  if (!delivery?.enabled) return false;
  if (run.status !== "completed" && run.status !== "failed") return false;
  if (run.trigger === "schedule") {
    if (delivery.includeScheduledRuns === false) return false;
    if (delivery.notifyOnChangeOnly === true && run.changeState === "unchanged") {
      return false;
    }
  } else if (delivery.includeManualRuns === false) {
    return false;
  }
  if (run.status === "completed" && delivery.notifyOnSuccess === false) return false;
  if (run.status === "failed" && delivery.notifyOnFailure !== true) return false;
  return true;
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
  const endpoint = (process.env.OPENAGENTS_OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ...provider,
        status: "error",
        detail: `Ollama responded with HTTP ${response.status}`,
        models: [],
      };
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const models =
      payload.models
        ?.map((model) => model.name)
        .filter((name): name is string => Boolean(name)) ?? [];

    return {
      ...provider,
      status: "connected",
      detail:
        models.length > 0
          ? `Running on ${endpoint}`
          : "Ollama is running but no models are installed",
      models,
      defaultModel: models[0],
    };
  } catch {
    return {
      ...provider,
      status: "not-installed",
      detail: `Ollama is not reachable on ${endpoint}`,
      models: [],
    };
  } finally {
    clearTimeout(timeout);
  }
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

export const __agentDraftTestUtils = {
  validateAgentDraftSource,
  buildNl2AgentSystemPrompt,
  buildAgentCommunitySubmissionReview,
};
