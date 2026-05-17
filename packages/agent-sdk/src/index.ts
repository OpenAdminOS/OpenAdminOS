export type ProviderId =
  | "ollama"
  | "lm-studio"
  | "anthropic"
  | "openai"
  | "azure-openai";

export type ProviderStatus = "connected" | "available" | "not-installed" | "error";

export interface ProviderSummary {
  id: ProviderId;
  name: string;
  description: string;
  isLocal: boolean;
  status: ProviderStatus;
  detail?: string;
  models: string[];
  defaultModel?: string;
}

export type AgentMode = "read" | "write";

export type AgentCategory =
  | "devices"
  | "apps"
  | "policies"
  | "compliance"
  | "updates";

export interface AgentAuthor {
  name: string;
  handle?: string;
  url?: string;
  verified?: boolean;
}

export type GraphHttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface GraphOperation {
  method: GraphHttpMethod;
  path: string;
  select?: string[];
  notes?: string;
}

export interface AgentContract {
  id: string;
  slug: string;
  name: string;
  description: string;
  mode: AgentMode;
  category: AgentCategory;
  scopes: string[];
  author: AgentAuthor;
  version: string;
  preferredModel?: string;
  graphOperations?: GraphOperation[];
}

export interface AgentSummary extends AgentContract {
  installedAt: string;
  registryId?: string;
  registryPath?: string;
  lastRunAt?: string;
  /**
   * Per-install overrides for the agent's `definition.settings[]` block.
   * Values are validated against the manifest's declared types at write
   * time and merged on top of YAML defaults at run time. Undefined or
   * missing keys fall back to the manifest default.
   */
  settings?: Record<string, unknown>;
  /**
   * Per-install run schedule. When `enabled`, the host fires the agent
   * automatically every `intervalSeconds` while the app is running.
   * Schedules do not persist across app shutdown — runs only fire while
   * the user has Open Agents open. Absent / disabled = manual-only.
   */
  schedule?: AgentSchedule;
}

export interface AgentSchedule {
  enabled: boolean;
  intervalSeconds: number;
  /** When the scheduler last fired this agent. Updated by the host. */
  lastScheduledRunAt?: string;
}

export interface RegistryAgentSummary extends AgentContract {
  registryId: string;
  registryPath?: string;
  installs?: number;
}

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting-confirmation"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled";

export type RunDataSource = "graph" | "synthetic";

export interface StartRunOptions {
  /**
   * Pin the run to a specific tenant id at queue time. Pass `null` to force
   * synthetic mode regardless of the currently-active tenant. Omit to default
   * to whichever tenant is active when the run is queued.
   */
  tenantId?: string | null;
  /**
   * Pin the run to a specific LLM provider id, overriding the globally
   * active provider for this run only. The provider must be known and
   * implemented; unknown / unimplemented ids throw at queue time. Omit
   * to default to the active provider.
   */
  providerId?: ProviderId;
  /**
   * Pin the run to a specific model name within the chosen provider,
   * overriding the agent's preferredModel and the user's globally-
   * pinned active model. The model must be installed for the provider;
   * unknown names throw at queue time. Omit to use the resolved
   * default per the agent's manifest and provider settings.
   */
  model?: string;
}

export interface TenantRecord {
  id: string;
  displayName: string;
  username: string;
  homeAccountId: string;
  addedAt: string;
  lastUsedAt?: string;
}

export type RunStepStatus = "pending" | "running" | "completed" | "failed";

export interface RunStepThinking {
  text: string;
  model: string;
  streaming: boolean;
}

export interface RunStepRecord {
  id: string;
  runId: string;
  label: string;
  status: RunStepStatus;
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
  thinking?: RunStepThinking;
}

export type RunLogLevel = "debug" | "info" | "warn" | "error";

export interface RunLogRecord {
  id: string;
  runId: string;
  timestamp: string;
  level: RunLogLevel;
  message: string;
  stepId?: string;
  metadata?: Record<string, unknown>;
}

export interface RunRecord {
  id: string;
  agentSlug: string;
  status: RunStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  confirmedAt?: string;
  rejectedAt?: string;
  providerId?: ProviderId;
  model?: string;
  summary?: string;
  result?: unknown;
  error?: string;
  steps: RunStepRecord[];
  logs: RunLogRecord[];
  plan?: WritePlan;
  dataSource?: RunDataSource;
  tenantId?: string;
  /**
   * Accumulated LLM token usage for this run (summed across all LLM
   * calls). Absent when no LLM step has run yet, or when the provider
   * doesn't report token telemetry.
   */
  tokens?: LlmTokenUsage;
}

export interface TrustState {
  label: string;
  detail: string;
  isLocal: boolean;
  dataSource: RunDataSource;
  tenantDisplayName?: string;
}

export interface AppState {
  activeProviderId: ProviderId;
  /**
   * User-picked model override per provider. Renderer-visible mirror of
   * the host's persisted preference; populated for every provider the
   * user has explicitly chosen a model for.
   */
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
  providers: ProviderSummary[];
  registryAgents: RegistryAgentSummary[];
  installedAgents: AgentSummary[];
  runs: RunRecord[];
  trust: TrustState;
  tenants: TenantRecord[];
  activeTenantId?: string;
}

export interface OpenAgentsApi {
  getAppState(): Promise<AppState>;
  listRegistryAgents(): Promise<RegistryAgentSummary[]>;
  listInstalledAgents(): Promise<AgentSummary[]>;
  listAgents(): Promise<AgentSummary[]>;
  listProviders(): Promise<ProviderSummary[]>;
  installAgent(agentId: string): Promise<AppState>;
  /**
   * Remove an installed agent. Bundled / registry-sourced agents are
   * removed from the user's installed list (the registry copy is
   * untouched). User-authored agents persisted under the user-agents
   * directory are deleted entirely.
   */
  uninstallAgent(slug: string): Promise<AppState>;
  setActiveProvider(id: ProviderId): Promise<AppState>;
  /**
   * Pin the active model for the given provider. Pass `null` to revert
   * to "whichever model the provider reports first". The host validates
   * the model belongs to the provider's installed list.
   */
  setActiveModel(providerId: ProviderId, model: string | null): Promise<AppState>;
  startRun(agentSlug: string, options?: StartRunOptions): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | undefined>;
  confirmRun(runId: string, phrase: string): Promise<RunRecord>;
  rejectRun(runId: string): Promise<RunRecord>;
  /**
   * Soft-cancel a running or queued run. The run is immediately marked
   * as `cancelled` in state and the UI stops receiving progress
   * updates. In-flight LLM and Graph calls finish in the background
   * (no abort plumbing yet), but their output is discarded.
   */
  cancelRun(runId: string): Promise<RunRecord>;
  listTenants(): Promise<TenantRecord[]>;
  connectTenant(): Promise<AppState>;
  setActiveTenant(id: string): Promise<AppState>;
  disconnectTenant(id: string): Promise<AppState>;
  getAgentManifest(slug: string): Promise<AgentManifestPreview | undefined>;
  /**
   * Persist per-install overrides for the named agent's
   * `definition.settings[]` block. Values are validated against the
   * manifest schema (type-coerced where it's a safe widening; rejected
   * with a thrown error otherwise). Unknown setting ids are dropped.
   */
  updateAgentSettings(
    slug: string,
    values: Record<string, unknown>,
  ): Promise<AppState>;
  /**
   * Persist a per-install run schedule for the named agent. Pass `null`
   * to remove the schedule (i.e. revert to manual-only). The host's
   * in-process scheduler fires the agent every `intervalSeconds` while
   * the app is open.
   */
  updateAgentSchedule(slug: string, schedule: AgentSchedule | null): Promise<AppState>;
  /**
   * Generate a draft `manifest.yaml` from a natural-language description
   * using the active LLM provider. Returns the YAML source as a string
   * — validation against the schema lives in the host but the renderer
   * may surface any validation errors raised. Throws if no LLM provider
   * is configured.
   */
  draftAgentManifest(prompt: string): Promise<AgentDraft>;
  /**
   * Persist a user-authored agent (typically the output of
   * `draftAgentManifest` after the user has reviewed it) to the
   * writable user-agents directory. The agent appears in the registry
   * immediately, ready to install.
   */
  saveAgentDraft(yamlSource: string): Promise<AppState>;
  /**
   * Open an http/https URL in the user's default browser. Other
   * schemes are rejected by the host. Used for "open docs" / "view
   * source" affordances.
   */
  openExternal(url: string): Promise<void>;
  /**
   * Prompt the user for a save location and write the supplied text
   * content to it. Returns the chosen path or a cancelled flag.
   */
  saveTextFile(args: SaveTextFileArgs): Promise<SaveTextFileResult>;
  /**
   * Current auto-updater state. Used by the renderer to surface an
   * "update ready" banner without waiting for the native dialog.
   */
  getUpdateState(): Promise<UpdateState>;
  /**
   * Subscribe to auto-updater state changes. The supplied callback
   * fires whenever the main-process updater transitions states. The
   * returned function unsubscribes the listener.
   */
  onUpdateStateChanged(listener: (state: UpdateState) => void): () => void;
  /**
   * Subscribe to "focus this run" requests from the main process —
   * fired e.g. when the user clicks an OS-level run-completion
   * notification. The renderer should navigate to the named run.
   */
  onFocusRun(listener: (runId: string) => void): () => void;
  /**
   * Subscribe to navigation requests from the main process — e.g.
   * when the user picks an item from the native application menu.
   */
  onNavigate(listener: (path: string) => void): () => void;
  /**
   * Trigger an immediate quit + install when the updater has a
   * downloaded update on disk. No-op otherwise.
   */
  applyUpdateNow(): Promise<void>;
}

export interface UpdateState {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  version?: string;
  message?: string;
}

export interface SaveTextFileArgs {
  suggestedName: string;
  content: string;
  /** OS-level file type filter, e.g. `[{ name: "JSON", extensions: ["json"] }]`. */
  filters?: { name: string; extensions: string[] }[];
}

export interface SaveTextFileResult {
  canceled: boolean;
  filePath?: string;
}

/**
 * Output of a draft-agent generation pass. The renderer feeds this
 * straight into a Manifest Preview (`kind: "agent-template"`) so the
 * user reviews the same surface they'd see post-install.
 */
export interface AgentDraft {
  /** Raw YAML emitted by the LLM. Always present. */
  yamlSource: string;
  /**
   * Parsed + schema-validated manifest. Only present when the YAML is
   * structurally valid; `validationErrors` populated otherwise.
   */
  manifest?: AgentTemplate;
  /** Empty when valid; one entry per schema violation otherwise. */
  validationErrors: string[];
}

/**
 * Renderer-friendly snapshot of an agent's manifest, used by the Agent
 * detail screen to render a transparency-first preview of what the
 * agent actually does. Every agent ships a declarative YAML pipeline;
 * `manifest` is the parsed structure and `sourceText` is the raw YAML
 * for the "View raw" affordance.
 */
export interface AgentManifestPreview {
  kind: "agent-template";
  registryPath?: string;
  manifest: AgentTemplate;
  sourceText: string;
}

export type AgentDefinition = AgentContract &
  Partial<Pick<RegistryAgentSummary, "registryId" | "registryPath" | "installs">>;

// ─── Agent Template types ─────────────────────────────────────────────────
//
// An Agent Template is a declarative YAML pipeline of steps (skills). The
// runtime interprets the manifest top-to-bottom; each step's output is
// stored under its `id` and available to later steps via templating
// (`{{ step_id.output }}`). No code execution — the only side effects an
// agent can have are the Graph calls and LLM calls it declares.

export type TemplateStepFormat = "graph" | "transform" | "llm" | "write";

export interface GraphStep {
  id: string;
  format: "graph";
  label: string;
  detail?: string;
  settings: {
    method: GraphHttpMethod;
    path: string;
    select?: string[];
    scopes: string[];
  };
}

export interface TransformStep {
  id: string;
  format: "transform";
  label: string;
  detail?: string;
  settings: Record<string, unknown> & { kind: string; source: string };
}

export interface LlmStep {
  id: string;
  format: "llm";
  label: string;
  detail?: string;
  /**
   * Optional gating expression. The interpreter supports the literal string
   * `ctx.llm.available` for v0.1 — when set, the skill is skipped (logged)
   * if no LLM provider is configured for the run.
   */
  when?: "ctx.llm.available";
  inputs?: Record<string, string>;
  settings: {
    system?: string;
    prompt: string;
    temperature?: number;
    maxTokens?: number;
  };
}

/**
 * Templated `WriteAction` definition. The runtime renders this template
 * once per `source` item to produce the `actions[]` of a `WritePlan`.
 * `metadata` carries handler-specific fields (e.g. `deviceId` for
 * `retire-managed-device`); the runtime's action-kind handler reads
 * those fields when executing the approved action.
 */
export interface WriteActionTemplate {
  label: string;
  description?: string;
  severity?: WriteActionSeverity;
  metadata?: Record<string, string>;
}

/**
 * Produces a `WritePlan` from a pipeline state. The runtime pauses the
 * run at `awaiting-confirmation` after rendering the plan; on confirm,
 * the runtime iterates `plan.actions` and dispatches each one to the
 * handler registered for `settings.kind`. There is no separate "apply
 * step" in the YAML — the apply phase is implicit and lives in the
 * runtime's action-kind handler registry.
 */
export interface WriteStep {
  id: string;
  format: "write";
  label: string;
  detail?: string;
  settings: {
    /**
     * The action kind the runtime should dispatch each action to.
     * v0.1 supports: "retire-managed-device".
     */
    kind: string;
    /** Liquid expression that resolves to an array of items. */
    source: string;
    /** Per-item template applied to each `source` item. */
    actionTemplate: WriteActionTemplate;
    /**
     * The phrase the user must type verbatim to confirm. Templated
     * — usually parameterised on the action count, e.g.
     * `"RETIRE {{ items | size }} DEVICES"`.
     */
    confirmationPhrase: string;
    /** Optional plan-level summary. Templated. */
    summary?: string;
    /**
     * Graph scopes required to apply actions of this kind. Concatenated
     * with the scopes declared on graph steps when the runtime reports
     * the agent's effective scope set.
     */
    scopes?: string[];
  };
}

export type TemplateStep = GraphStep | TransformStep | LlmStep | WriteStep;

export type TemplateTriggerKind = "manual" | "scheduled";

export interface TemplateTrigger {
  id: string;
  kind: TemplateTriggerKind;
  /** Only consulted when `kind: scheduled`; ignored in v0.1. */
  intervalSeconds?: number;
}

export interface TemplateSetting {
  id: string;
  label: string;
  type: "string" | "integer" | "boolean";
  default?: unknown;
  description?: string;
  hint?: string;
  required?: boolean;
}

export interface TemplateResult {
  summary: string;
  data?: Record<string, unknown>;
}

export interface AgentTemplate {
  descriptor: {
    id: string;
    name: string;
    description: string;
    version: string;
    author: AgentAuthor;
    category: AgentCategory;
    mode: AgentMode;
    preferredModel?: string;
  };
  skills: TemplateStep[];
  definition: {
    settings?: TemplateSetting[];
    triggers?: TemplateTrigger[];
    result: TemplateResult;
  };
}

export interface ManagedDeviceRecord {
  id: string;
  deviceName: string;
  userPrincipalName: string;
  operatingSystem: string;
  osVersion?: string;
  lastSyncDateTime: string;
  enrolledDateTime: string;
  complianceState: "compliant" | "noncompliant" | "unknown";
}

export interface RunGraphApi {
  listManagedDevices(): Promise<ManagedDeviceRecord[]>;
  /**
   * Calls `POST /deviceManagement/managedDevices/{managedDevice-id}/retire`.
   * Destructive — only invoke after the user has approved a `WritePlan`
   * via typed diff confirmation. The runtime's policy gating (tenant
   * connected) is surfaced via `RunContext.realWrites`; agents should
   * branch on that flag before calling this method.
   */
  retireManagedDevice(deviceId: string): Promise<void>;
}

export interface LlmOptions {
  prompt: string;
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmTokenUsage {
  /** Tokens consumed parsing the prompt + system message. */
  promptTokens?: number;
  /** Tokens generated in the response. */
  completionTokens?: number;
  /** Sum of prompt + completion when known; some providers report only this. */
  totalTokens?: number;
}

export interface LlmCompletion {
  text: string;
  model: string;
  tokenUsage?: LlmTokenUsage;
}

export interface LlmStreamChunk {
  delta: string;
  accumulated: string;
  done: boolean;
  model: string;
  /**
   * Populated by providers that emit token-count telemetry in their
   * final stream chunk (Ollama: `prompt_eval_count` + `eval_count`).
   * Earlier chunks omit this; consumers should only trust the last
   * chunk's value.
   */
  tokenUsage?: LlmTokenUsage;
}

export interface RunLlmApi {
  readonly available: boolean;
  readonly defaultModel?: string;
  /**
   * Caller MUST check `available` first. When `available` is `false` both
   * `complete()` and `stream()` will throw before any I/O is performed.
   */
  complete(options: LlmOptions): Promise<LlmCompletion>;
  stream(options: LlmOptions): AsyncIterable<LlmStreamChunk>;
}

export interface RunContextOptions {
  agent: AgentDefinition;
  providerId: ProviderId;
  model?: string;
}

export interface RunContext {
  agent: AgentDefinition;
  providerId: ProviderId;
  model?: string;
  graph: RunGraphApi;
  llm: RunLlmApi;
  /**
   * Resolved install-time settings. The host merges the user's persisted
   * overrides (from `AgentSummary.settings`) on top of the manifest's
   * declared defaults before building the context, so the interpreter
   * always sees a complete, type-coerced settings map.
   *
   * Code-based agents are free to read this map but may also ignore it.
   * The agent template interpreter consults it via `resolveSettings`.
   */
  settings?: Record<string, unknown>;
  /**
   * Whether write actions invoked via `ctx.graph.*` will hit real Graph.
   *
   * `true`  — a tenant is connected. Destructive operations in `apply`
   *           should call the real Graph methods after the user has
   *           approved the run via typed diff confirmation.
   * `false` — synthetic mode (no tenant connected). `apply` should emit
   *           a log line describing what *would* have happened and skip
   *           the destructive call so synthetic mode stays honest about
   *           not touching a tenant.
   *
   * Read-only operations (`listManagedDevices`) ignore this flag and
   * always reflect the active data source.
   */
  realWrites: boolean;
  log(level: RunLogLevel, message: string, metadata?: Record<string, unknown>): void;
  step<T>(
    label: string,
    detail: string | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T>;
}

export interface AgentRunResult {
  summary: string;
  result?: unknown;
}

export type WriteActionSeverity = "default" | "destructive";

export interface WriteAction {
  id: string;
  kind: string;
  label: string;
  description?: string;
  severity?: WriteActionSeverity;
  metadata?: Record<string, unknown>;
}

export interface WritePlan {
  summary: string;
  confirmationPhrase: string;
  actions: WriteAction[];
}

export interface ReadAgentModule extends AgentDefinition {
  mode: "read";
  run(ctx: RunContext): Promise<AgentRunResult>;
}

export interface WriteAgentModule extends AgentDefinition {
  mode: "write";
  plan(ctx: RunContext): Promise<WritePlan>;
  apply(ctx: RunContext, plan: WritePlan): Promise<AgentRunResult>;
}

export type AgentModule = ReadAgentModule | WriteAgentModule;

// TODO(uli): only the `ollama` provider has a working runtime adapter as
// of v0.1.x. LM Studio + the three hosted providers below are kept in the
// catalog as forward-compat placeholders but flagged "Coming in 0.2" by
// the renderer (see apps/desktop/src/shared/providers.ts) until adapters
// + keytar-backed credential storage land.
export const providerCatalog: readonly ProviderSummary[] = [
  {
    id: "ollama",
    name: "Ollama",
    description:
      "Run open-source models locally. Tenant data and prompts stay on this machine.",
    isLocal: true,
    status: "available",
    detail: "Waiting for connection check",
    models: [],
  },
  {
    id: "lm-studio",
    name: "LM Studio",
    description:
      "Use LM Studio's local OpenAI-compatible server for private model runs.",
    isLocal: true,
    status: "not-installed",
    detail: "Connection check not implemented yet",
    models: [],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description:
      "Hosted Claude models. Tenant prompts leave this device when active.",
    isLocal: false,
    status: "not-installed",
    detail: "Hosted provider setup is not implemented yet",
    models: [],
  },
  {
    id: "openai",
    name: "OpenAI",
    description:
      "Hosted OpenAI models. Tenant prompts leave this device when active.",
    isLocal: false,
    status: "not-installed",
    detail: "Hosted provider setup is not implemented yet",
    models: [],
  },
  {
    id: "azure-openai",
    name: "Azure OpenAI",
    description:
      "Hosted Azure OpenAI deployments using the organization's Azure boundary.",
    isLocal: false,
    status: "not-installed",
    detail: "Hosted provider setup is not implemented yet",
    models: [],
  },
];

export interface DeriveTrustStateInput {
  provider: ProviderSummary | undefined;
  activeTenant?: TenantRecord | undefined;
}

export function deriveTrustState(
  providerOrInput: ProviderSummary | undefined | DeriveTrustStateInput,
  legacyTenant?: TenantRecord | undefined,
): TrustState {
  const isInputObject =
    providerOrInput !== undefined &&
    typeof providerOrInput === "object" &&
    "provider" in (providerOrInput as object);
  const provider = isInputObject
    ? (providerOrInput as DeriveTrustStateInput).provider
    : (providerOrInput as ProviderSummary | undefined);
  const activeTenant = isInputObject
    ? (providerOrInput as DeriveTrustStateInput).activeTenant
    : legacyTenant;

  const dataSource: RunDataSource = activeTenant ? "graph" : "synthetic";
  const tenantSegment = activeTenant
    ? `tenant ${activeTenant.displayName}`
    : "synthetic data";

  if (!provider) {
    const base: TrustState = {
      label: "Provider not configured",
      detail: "Select a provider before running agents.",
      isLocal: true,
      dataSource,
    };
    if (activeTenant) base.tenantDisplayName = activeTenant.displayName;
    return base;
  }

  if (provider.isLocal) {
    const detail = activeTenant
      ? `Tenant data stays on this device. Prompts use ${provider.name} locally.`
      : "Tenant data and prompts stay on this device.";
    const base: TrustState = {
      label: `Local ${provider.name} · ${tenantSegment}`,
      detail,
      isLocal: true,
      dataSource,
    };
    if (activeTenant) base.tenantDisplayName = activeTenant.displayName;
    return base;
  }

  const detail = activeTenant
    ? `Tenant data is read from Microsoft Graph. Prompts are sent to ${provider.name}.`
    : `Tenant data and prompts are sent to ${provider.name}.`;
  const base: TrustState = {
    label: `Hosted ${provider.name} · ${tenantSegment}`,
    detail,
    isLocal: false,
    dataSource,
  };
  if (activeTenant) base.tenantDisplayName = activeTenant.displayName;
  return base;
}

export function defineAgent<const TAgent extends AgentModule>(
  agent: TAgent,
): TAgent {
  return agent;
}
