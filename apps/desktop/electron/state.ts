import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  acquireTokenSilent,
  createGraphAdapter,
  createMsalClient,
  createOllamaLlm,
  createQueuedRun,
  createSyntheticGraph,
  executeApply,
  executePlan,
  executeRun,
  findRegistryAgentById,
  listAllRegistryAgents,
  loadAgentManifestPreview,
  noopLlm,
  parseAgentTemplate,
  ManifestValidationError,
  removeAccount,
  runInteractiveFlow,
  toInstalledAgent,
  type TokenCacheStorage,
} from "@openagents/runtime";
import type {
  AgentDraft,
  AgentManifestPreview,
  AgentTemplate,
  RunDataSource,
  RunGraphApi,
  RunLlmApi,
  StartRunOptions,
  TemplateSetting,
  TenantRecord,
} from "@openagents/agent-sdk";
import {
  deriveTrustState,
  providerCatalog,
  type AgentSummary,
  type AppState,
  type ProviderId,
  type ProviderSummary,
  type RegistryAgentSummary,
  type RunRecord,
} from "@openagents/agent-sdk";
import type { PublicClientApplication } from "@azure/msal-node";

import { EncryptedSecretStore } from "./secret-store.js";

interface PersistedState {
  activeProviderId: ProviderId;
  installedAgents: AgentSummary[];
  runs: RunRecord[];
  tenants: TenantRecord[];
  activeTenantId?: string;
  realWritesEnabled: boolean;
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
  realWritesEnabled: false,
};

const providerIds = new Set<ProviderId>(
  providerCatalog.map((provider) => provider.id),
);

export interface AppStateStoreOptions {
  filePath: string;
  tokenStore: EncryptedSecretStore;
  openBrowser?(url: string): Promise<void>;
  /**
   * Writable directory where user-authored agents (NL2Agent output)
   * live. Each child is `<slug>/manifest.yaml` + `<slug>/manifest.json`.
   * When omitted, only bundled agents are visible to the registry.
   */
  userAgentsDir?: string;
}

export class AppStateStore {
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly filePath: string;
  private readonly tokenStore: EncryptedSecretStore;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly userAgentsDir: string | undefined;
  private msalClient: PublicClientApplication | undefined;

  constructor(options: AppStateStoreOptions | string, legacyTokenStore?: EncryptedSecretStore) {
    if (typeof options === "string") {
      this.filePath = options;
      this.tokenStore =
        legacyTokenStore ?? new EncryptedSecretStore(`${options}.tokens.bin`);
      this.openBrowser = async () => undefined;
      this.userAgentsDir = undefined;
    } else {
      this.filePath = options.filePath;
      this.tokenStore = options.tokenStore;
      this.openBrowser = options.openBrowser ?? (async () => undefined);
      this.userAgentsDir = options.userAgentsDir;
    }
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

    const state: AppState = {
      activeProviderId: activeProvider?.id ?? "ollama",
      providers,
      registryAgents: this.listRegistryAgents(),
      installedAgents: persisted.installedAgents,
      runs: persisted.runs,
      trust: deriveTrustState({ provider: activeProvider, activeTenant }),
      tenants: persisted.tenants,
      realWritesEnabled: persisted.realWritesEnabled,
    };
    if (persisted.activeTenantId) {
      state.activeTenantId = persisted.activeTenantId;
    }
    return state;
  }

  async setRealWritesEnabled(enabled: boolean): Promise<AppState> {
    if (typeof enabled !== "boolean") {
      throw new Error(`setRealWritesEnabled requires a boolean, got ${typeof enabled}.`);
    }
    await this.serialize(async () => {
      const persisted = await this.read();
      await this.write({
        ...persisted,
        realWritesEnabled: enabled,
      });
    });
    return this.getAppState();
  }

  listRegistryAgents(): RegistryAgentSummary[] {
    return listAllRegistryAgents(this.userAgentsDir);
  }

  async getAgentManifest(slug: string): Promise<AgentManifestPreview | undefined> {
    // Prefer the on-disk metadata from the registry (it has the correct
    // registryPath) so the preview can label the source location.
    const registryAgent = this.listRegistryAgents().find(
      (agent) => agent.slug === slug || agent.id === slug,
    );
    if (registryAgent) {
      return loadAgentManifestPreview(registryAgent);
    }
    // Fall back to an installed agent for the rare case where it's no
    // longer in the registry but still in user state.
    const persisted = await this.read();
    const installed = persisted.installedAgents.find(
      (agent) => agent.slug === slug || agent.id === slug,
    );
    return installed ? loadAgentManifestPreview(installed) : undefined;
  }

  async listAgents(): Promise<AgentSummary[]> {
    const persisted = await this.read();
    return persisted.installedAgents;
  }

  async listProviders(): Promise<ProviderSummary[]> {
    return Promise.all(
      providerCatalog.map(async (provider) => {
        if (provider.id !== "ollama") {
          return provider;
        }

        return checkOllama(provider);
      }),
    );
  }

  /**
   * Persist per-install overrides for an agent's `definition.settings[]`.
   * The manifest is the source of truth for the legal key set and type
   * for each value: unknown keys are silently dropped, ill-typed values
   * throw before any persist. A missing manifest (e.g. the agent doesn't
   * ship a YAML template) is a no-op — code-based agents have no
   * declared settings surface in v0.1.
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
      if (preview.kind !== "agent-template") {
        throw new Error(
          `updateAgentSettings: agent "${slug}" is code-based and does not declare configurable settings in v0.1.`,
        );
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

    const system = NL2AGENT_SYSTEM_PROMPT;
    const userTurn = `Draft a manifest.yaml for the following Open Agents agent description.

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

    const yamlSource = stripCodeFences(completion.text).trim();

    let manifest: AgentDraft["manifest"];
    const validationErrors: string[] = [];
    try {
      manifest = parseAgentTemplate(yamlSource);
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        validationErrors.push(error.message);
      } else if (error instanceof Error) {
        validationErrors.push(error.message);
      } else {
        validationErrors.push(String(error));
      }
    }

    return validationErrors.length > 0
      ? { yamlSource, validationErrors }
      : { yamlSource, manifest, validationErrors: [] };
  }

  /**
   * Persist a user-authored agent under `userAgentsDir/<slug>/`. The
   * slug comes from the manifest's `descriptor.id`. Writes:
   *   - `manifest.yaml` (the source of truth for runtime behaviour)
   *   - `manifest.json` (registry metadata projected from the manifest
   *     so qa-graph and the registry walker can find the agent without
   *     re-parsing the YAML)
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

    let manifest;
    try {
      manifest = parseAgentTemplate(yamlSource);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`saveAgentDraft: manifest failed schema validation: ${message}`);
    }

    const slug = manifest.descriptor.id;
    const bundledSlugs = new Set(
      listAllRegistryAgents(undefined).map((agent) => agent.slug),
    );
    if (bundledSlugs.has(slug)) {
      throw new Error(
        `saveAgentDraft: slug "${slug}" is already taken by a bundled agent. Choose a different descriptor.id.`,
      );
    }

    const agentDir = join(this.userAgentsDir, slug);
    if (existsSync(agentDir)) {
      throw new Error(
        `saveAgentDraft: an agent named "${slug}" already exists in your user-agents directory.`,
      );
    }

    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "manifest.yaml"), `${yamlSource.trimEnd()}\n`, "utf8");
    await writeFile(
      join(agentDir, "manifest.json"),
      `${JSON.stringify(projectManifestJson(manifest), null, 2)}\n`,
      "utf8",
    );

    return this.getAppState();
  }

  async installAgent(agentId: string): Promise<AppState> {
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

      const registryAgent = findRegistryAgentById(agentId, this.userAgentsDir);
      if (!registryAgent) {
        throw new Error(`Unknown registry agent: ${agentId}`);
      }

      await this.write({
        ...persisted,
        installedAgents: [
          ...persisted.installedAgents,
          toInstalledAgent(registryAgent, new Date()),
        ],
      });
    });

    return this.getAppState();
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

  async listTenants(): Promise<TenantRecord[]> {
    const persisted = await this.read();
    return persisted.tenants;
  }

  async connectTenant(): Promise<AppState> {
    const client = this.getMsalClient();
    const result = await runInteractiveFlow({
      client,
      openBrowser: this.openBrowser,
    });

    if (!result.account) {
      throw new Error("Microsoft sign-in did not return an account.");
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

    return this.getAppState();
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

      const providers = await this.listProviders();
      const activeProvider =
        providers.find((provider) => provider.id === persisted.activeProviderId) ??
        providers[0];
      const providerId = activeProvider?.id ?? persisted.activeProviderId;
      const model = activeProvider?.defaultModel;

      // Resolve the effective tenant at queue time:
      //   - explicit null  -> synthetic for this run regardless of active tenant
      //   - explicit id    -> validate it exists and pin it
      //   - omitted        -> default to currently-active tenant (if any)
      let pinnedTenantId: string | null;
      if (options.tenantId === null) {
        pinnedTenantId = null;
      } else if (typeof options.tenantId === "string") {
        const exists = persisted.tenants.some((tenant) => tenant.id === options.tenantId);
        if (!exists) {
          throw new Error(`Tenant not connected: ${options.tenantId}`);
        }
        pinnedTenantId = options.tenantId;
      } else {
        pinnedTenantId = persisted.activeTenantId ?? null;
      }

      const queuedRun = createQueuedRun({ agent, providerId, model });
      if (pinnedTenantId) {
        queuedRun.tenantId = pinnedTenantId;
        queuedRun.dataSource = "graph";
      } else {
        queuedRun.dataSource = "synthetic";
      }

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
    if (providerId !== "ollama") {
      return noopLlm;
    }
    const providers = await this.listProviders();
    const ollama = providers.find((provider) => provider.id === "ollama");
    if (!ollama || ollama.status !== "connected") {
      return noopLlm;
    }
    const defaultModel = model ?? ollama.defaultModel ?? ollama.models[0];
    const options: { defaultModel?: string } = {};
    if (defaultModel) {
      options.defaultModel = defaultModel;
    }
    return createOllamaLlm(options);
  }

  private async buildGraph(pinnedTenantId?: string): Promise<{
    graph: RunGraphApi;
    dataSource: RunDataSource;
    tenantId?: string;
  }> {
    const persisted = await this.read();
    const tenantId = pinnedTenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((t) => t.id === tenantId)
      : undefined;
    if (!tenant) {
      return { graph: createSyntheticGraph(), dataSource: "synthetic" };
    }
    const client = this.getMsalClient();
    return {
      graph: createGraphAdapter({
        tokenProvider: async () => {
          const result = await acquireTokenSilent({
            client,
            homeAccountId: tenant.homeAccountId,
          });
          return result.accessToken;
        },
      }),
      dataSource: "graph",
      tenantId: tenant.id,
    };
  }

  private stampDataSource(
    run: RunRecord,
    selection: { dataSource: RunDataSource; tenantId?: string },
  ): RunRecord {
    const next: RunRecord = { ...run, dataSource: selection.dataSource };
    if (selection.tenantId) {
      next.tenantId = selection.tenantId;
    } else if ("tenantId" in next) {
      delete next.tenantId;
    }
    return next;
  }

  // Real writes are only permitted when: (a) the run resolved to a real
  // tenant Graph adapter (dataSource === "graph") AND (b) the user has
  // explicitly toggled the global "Enable real Graph writes" setting.
  // Synthetic runs never pass real writes through, regardless of the
  // toggle, because there's no tenant to write against.
  private async resolveRealWrites(selection: { dataSource: RunDataSource }): Promise<boolean> {
    if (selection.dataSource !== "graph") return false;
    const persisted = await this.read();
    return persisted.realWritesEnabled === true;
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
      const selection = await this.buildGraph(input.run.tenantId);
      const realWrites = await this.resolveRealWrites(selection);
      const stampedRun = this.stampDataSource(input.run, selection);
      await this.persistRunSnapshot(stampedRun);
      await driver({
        run: stampedRun,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        llm,
        graph: selection.graph,
        realWrites,
        onProgress: (next) =>
          this.persistRunSnapshot(this.stampDataSource(next, selection)),
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
      const selection = await this.buildGraph(input.run.tenantId);
      const realWrites = await this.resolveRealWrites(selection);
      await executeApply({
        run: input.run,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        plan: input.plan,
        llm,
        graph: selection.graph,
        realWrites,
        onProgress: (next) =>
          this.persistRunSnapshot(this.stampDataSource(next, selection)),
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

  private persistRunSnapshot(run: RunRecord): Promise<void> {
    return this.serialize(async () => {
      const persisted = await this.read();
      const exists = persisted.runs.some((existing) => existing.id === run.id);
      const nextRuns = exists
        ? persisted.runs.map((existing) => (existing.id === run.id ? run : existing))
        : [run, ...persisted.runs];
      await this.write({ ...persisted, runs: nextRuns });
    });
  }

  private async read(): Promise<PersistedState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;

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
          ? parsed.installedAgents
          : defaultState.installedAgents,
        runs: Array.isArray(parsed.runs) ? parsed.runs : defaultState.runs,
        tenants,
        // Default to false for older state files written before real-writes
        // existed; the user must explicitly opt in via Settings.
        realWritesEnabled:
          typeof parsed.realWritesEnabled === "boolean"
            ? parsed.realWritesEnabled
            : defaultState.realWritesEnabled,
      };
      if (activeTenantId) {
        state.activeTenantId = activeTenantId;
      }
      return state;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        await this.write(defaultState);
      }

      return defaultState;
    }
  }

  private async write(state: PersistedState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && providerIds.has(value as ProviderId);
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
const NL2AGENT_SYSTEM_PROMPT = `You generate Agent Template manifests for Open Agents — a desktop tool that runs AI agents against a Microsoft 365 tenant.

The manifest is a YAML document with three top-level keys: descriptor, skills, definition.

Hard rules:
- mode is "read" unless the user explicitly asks for a destructive (write) agent.
- category must be one of: devices, apps, policies, compliance, updates.
- Slug ids are lower-case hyphen-separated, e.g. "find-inactive-devices".
- Skill ids are lower-case snake_case, e.g. "load_devices".
- For v0.1, the only Graph endpoint available is GET /deviceManagement/managedDevices. Do not invent other endpoints.
- Transform kinds available: group-by-age, filter-by-age, count-by-field.
- LLM steps are optional; when included, gate them with: when: ctx.llm.available
- Write-action kinds available: retire-managed-device.
- Templating uses Liquid-subset {{ path.expr | filter }}. Filters available: size, total, sample(n), default("…"), join(", ").
- Always include a top-level "# yaml-language-server: $schema=../../schemas/agent-template.schema.json" comment.

Reference example — find-inactive-devices (read mode, bucketed by age):

# yaml-language-server: $schema=../../schemas/agent-template.schema.json
descriptor:
  id: find-inactive-devices
  name: Find inactive devices
  description: Surfaces Intune-managed devices that have not synced recently, grouped by inactivity window.
  version: 1.0.0
  author:
    name: OpenAgents
    handle: openagents
    verified: false
  category: devices
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
      select: [id, deviceName, userPrincipalName, operatingSystem, lastSyncDateTime, complianceState]
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
definition:
  triggers:
    - id: manual
      kind: manual
  result:
    summary: "{{ by_state.output.noncompliant }} noncompliant of {{ load_devices.output | size }} devices."
    data:
      total: "{{ load_devices.output | size }}"
      counts: "{{ by_state.output }}"

When the user's description is vague, pick sensible defaults and continue — don't ask clarifying questions. When you cannot fulfil a request inside the available endpoints / transforms, choose the closest supported shape rather than inventing new mechanisms.

Output: a single YAML manifest. Nothing else.`;

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

/**
 * Project the parsed Agent Template manifest into a minimal
 * manifest.json that the registry walker (and qa-graph) can consume
 * without re-parsing the YAML. The registry uses manifest.json for
 * fast metadata reads; the YAML drives runtime behaviour.
 */
function projectManifestJson(manifest: AgentTemplate): Record<string, unknown> {
  const scopes = new Set<string>();
  const graphOps: Array<Record<string, unknown>> = [];
  for (const skill of manifest.skills) {
    if (skill.format === "graph") {
      for (const scope of skill.settings.scopes ?? []) scopes.add(scope);
      const op: Record<string, unknown> = {
        method: skill.settings.method,
        path: skill.settings.path,
      };
      if (skill.settings.select && skill.settings.select.length > 0) {
        op.select = skill.settings.select;
      }
      graphOps.push(op);
    } else if (skill.format === "write") {
      for (const scope of skill.settings.scopes ?? []) scopes.add(scope);
    }
  }

  return {
    id: manifest.descriptor.id,
    slug: manifest.descriptor.id,
    name: manifest.descriptor.name,
    description: manifest.descriptor.description,
    mode: manifest.descriptor.mode,
    category: manifest.descriptor.category,
    version: manifest.descriptor.version,
    author: manifest.descriptor.author,
    scopes: [...scopes],
    ...(manifest.descriptor.preferredModel
      ? { preferredModel: manifest.descriptor.preferredModel }
      : {}),
    ...(graphOps.length > 0 ? { graphOperations: graphOps } : {}),
  };
}
