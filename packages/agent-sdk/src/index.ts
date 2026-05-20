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

/**
 * Distribution tier — separates true agents (multi-source reasoning,
 * judgment, write actions) from dashboards (single-source LLM-narrated
 * reports). Default is `agent`; only set `dashboard` when the manifest
 * is honestly a report and not something a PowerShell script can't do.
 */
export type AgentTier = "agent" | "dashboard";

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
  tier: AgentTier;
  scopes: string[];
  author: AgentAuthor;
  version: string;
  preferredModel?: string;
  graphOperations?: GraphOperation[];
  /**
   * Egress dependencies declared by this agent. Validated against the
   * host's registered connectors at manifest load; required connectors
   * that are unknown or unsatisfiable fail the run before queue. See
   * `Connector abstraction` in docs/SPEC.md §2.
   */
  connectors?: AgentConnectorRequirement[];
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

export interface StartRunOptions {
  /**
   * Pin the run to a specific tenant id at queue time. Omit to default to
   * whichever tenant is active when the run is queued. The run will fail
   * preflight if no tenant resolves — runs cannot proceed without a
   * connected tenant.
   */
  tenantId?: string;
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
  /** ISO timestamp of the last successful registry index refresh. Null until first fetch. */
  lastRegistryRefresh: string | null;
  /** Human-readable error from the most recent registry fetch attempt. Null when clean. */
  registryRefreshError: string | null;
  /** Registry source URL in use (may differ from default if overridden in Settings). */
  registrySource: string;
}

/** The host OS, normalized for renderer use. */
export type HostPlatform = "macos" | "windows" | "linux" | "unknown";

export interface OpenAgentsApi {
  /**
   * The host operating system, normalized to a small union for
   * renderer-side conditional UI (install instructions, keyboard
   * shortcut hints, etc.). Resolved at preload time; never changes.
   */
  platform: HostPlatform;
  getAppState(): Promise<AppState>;
  listRegistryAgents(): Promise<RegistryAgentSummary[]>;
  refreshRegistry(): Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }>;
  /**
   * Persist a new registry source URL and trigger an immediate refresh
   * against it. Returns the same shape as `refreshRegistry()` so the
   * renderer can react to fetch failures (e.g. typo'd URL).
   */
  setRegistrySource(
    url: string,
  ): Promise<{ error: string | null; fromCache: boolean; cachedAt: string | null }>;
  listInstalledAgents(): Promise<AgentSummary[]>;
  listAgents(): Promise<AgentSummary[]>;
  listProviders(): Promise<ProviderSummary[]>;
  /**
   * Returns every connector registered in the host, with its
   * persisted config and last health-check outcome.
   */
  listConnectors(): Promise<ConnectorSummary[]>;
  /**
   * Builds the named connector with the active tenant and runs its
   * `healthCheck`. Triggers per-capability incremental consent via
   * MSAL if the connector requests scopes the cache cannot satisfy.
   * Persists the outcome before returning the updated summary.
   */
  testConnector(id: string): Promise<ConnectorSummary>;
  /**
   * Persist per-install configuration for the named connector. The
   * host validates the payload shape (defensively coerced to a plain
   * object) and stores it under `PersistedState.connectors[id].config`.
   * Returns the updated summary so the renderer can refresh in place.
   */
  setConnectorConfig(
    id: string,
    config: Record<string, unknown>,
  ): Promise<ConnectorSummary>;
  /**
   * Reads the list of teams the signed-in admin has joined, via the
   * Teams connector's `list-teams` capability. Used by the Connectors
   * page channel picker.
   */
  listConnectorTeams(connectorId: string): Promise<ConnectorTeamRef[]>;
  /**
   * Reads channels for a given team via the connector's
   * `list-channels` capability. Used by the channel picker.
   */
  listConnectorChannels(
    connectorId: string,
    teamId: string,
  ): Promise<ConnectorChannelRef[]>;
  /**
   * Subscribe to confirmation requests fired by the runtime when a
   * `notify`/`mutating`/`destructive` connector capability is about
   * to execute. The renderer is expected to show a confirmation
   * modal and call `respondToConnectorConfirm(requestId, decision)`.
   */
  onConnectorConfirmRequest(
    listener: (request: PendingConnectorConfirmation) => void,
  ): () => void;
  /**
   * Resolves the pending confirmation identified by `requestId` with
   * the supplied decision. Calling with an unknown id is a no-op.
   */
  respondToConnectorConfirm(
    requestId: string,
    decision: PendingConnectorDecision,
  ): Promise<void>;
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

export type TemplateStepFormat = "graph" | "transform" | "llm" | "map" | "write" | "connector";

export interface GraphStep {
  id: string;
  format: "graph";
  label: string;
  detail?: string;
  settings: {
    method: GraphHttpMethod;
    path: string;
    select?: string[];
    /** Additional `$`-prefixed OData query params (filter, top, orderby, ...). */
    query?: Record<string, string>;
    /** Optional extra HTTP headers (e.g. `ConsistencyLevel: eventual`). */
    headers?: Record<string, string>;
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
 * Iterates over a source array and runs an inner pipeline once per item.
 * Used to express per-item LLM reasoning (e.g. risky sign-in triage,
 * stale-guest cleanup rationale) where the LLM needs to look at each
 * row individually with shared context.
 *
 * The current item is bound to `settings.as` inside each iteration. The
 * final sub-step's output is collected into an array as the map step's
 * own output. Sub-steps may reference outer-pipeline outputs too — the
 * inner context inherits from the outer context.
 */
export interface MapStep {
  id: string;
  format: "map";
  label: string;
  detail?: string;
  settings: {
    /** Liquid expression resolving to an array. */
    source: string;
    /** Variable name the current item is bound to inside `do`. */
    as: string;
    /** Inner pipeline; runs once per item. */
    do: TemplateStep[];
    /** Optional cap on the number of items processed (LLM-cost guard). */
    limit?: number;
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
  /**
   * For `kind: "graph-write"`: the Graph request to send when this
   * action is approved. Path and body are templated per source item.
   * Body is optional (DELETE typically omits it; some POSTs do too).
   */
  request?: {
    method: WriteHttpMethod;
    path: string;
    body?: unknown;
  };
}

export type WriteHttpMethod = "POST" | "PATCH" | "PUT" | "DELETE";

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

/**
 * Invokes a connector capability inside a YAML pipeline. The runtime
 * resolves `connector` against the agent's declared connector
 * requirements (typed `ctx.connectors[id]`) and calls the named
 * `capability` method with the templated `args` payload.
 *
 * Capability `kind` is read from the connector descriptor and gates
 * confirmation: `notify`+ capabilities trigger the preview-and-send
 * modal, `read` capabilities run inline.
 */
export interface ConnectorStep {
  id: string;
  format: "connector";
  label: string;
  detail?: string;
  /**
   * Optional gating expression. The interpreter supports the literal
   * string `ctx.connectors.<id>.available` for v0.1 — when set, the
   * step is skipped (logged) if the named connector was not built at
   * preflight (typically because it's declared as optional and the
   * user has not configured it).
   */
  when?: string;
  settings: {
    /** Connector id, must match an `AgentConnectorRequirement.id`. */
    connector: string;
    /** Capability id within the connector (kebab-case, e.g. 'post-channel-message'). */
    capability: string;
    /** Capability version (defaults to 1 if omitted). */
    version?: number;
    /**
     * Templated args passed to the capability method. Each leaf
     * string is run through the template engine before invocation.
     */
    args: Record<string, unknown>;
  };
}

export type TemplateStep =
  | GraphStep
  | TransformStep
  | LlmStep
  | MapStep
  | WriteStep
  | ConnectorStep;

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
    /**
     * Distribution tier. Optional in source manifests; defaults to
     * `agent` at parse time. Set to `dashboard` only for single-source
     * LLM-narrated reports — see {@link AgentTier}.
     */
    tier?: AgentTier;
    mode: AgentMode;
    preferredModel?: string;
    /**
     * Connector dependencies declared by this agent. Loaded into
     * `AgentContract.connectors` at manifest parse time; the runtime
     * preflights each entry against the host's registered connectors
     * before queuing the run.
     */
    connectors?: AgentConnectorRequirement[];
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
  /**
   * Generic Graph GET. Used by the agent-template interpreter for any
   * path beyond the legacy hardcoded `/deviceManagement/managedDevices`
   * fast path. Returns the parsed JSON response body; callers are
   * expected to unwrap `value` for collection endpoints themselves.
   */
  request(input: GraphRequestInput): Promise<unknown>;
}

export interface GraphRequestInput {
  method: "GET" | WriteHttpMethod;
  path: string;
  /** Map of `$select`, `$filter`, `$top`, etc. Encoded into the URL. */
  query?: Record<string, string>;
  /** Optional `ConsistencyLevel: eventual` etc. */
  headers?: Record<string, string>;
  /**
   * JSON-serializable body for POST/PATCH/PUT. Ignored for GET/DELETE.
   * Serialized with `JSON.stringify` and sent with
   * `Content-Type: application/json`.
   */
  body?: unknown;
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
   * Egress connectors built for this run. Keyed by connector id; only the
   * connectors the agent declared in its manifest are populated. Required
   * connectors are guaranteed defined (preflight rejected the run
   * otherwise); optional connectors may be `undefined` and must be
   * checked before use.
   *
   * Connector packages augment `ConnectorRegistry` via TypeScript
   * declaration merging — `ctx.connectors.teams` is fully typed when
   * `@openagents/connector-teams` is installed in the workspace.
   *
   * Optional in the type so the v0.1.x runtime (which has no connector
   * support yet) compiles unchanged. The v0.2 runtime always populates
   * this — call sites in agents that declare connectors can rely on it
   * because preflight rejects runs missing required connectors.
   */
  connectors?: ConnectorAccessor;
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
   * Always `true` in production because runs require a connected tenant
   * — the typed diff confirmation is the user-facing gate, not this
   * flag. Kept as a parameter so unit tests / fixtures can pass
   * `false` and exercise apply logic without a tenant.
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
  /**
   * For `graph-write` actions: the fully-rendered Graph request the
   * runtime will fire when the user approves the plan. Path and body
   * are already resolved against the source item; no further
   * templating happens at apply time.
   */
  request?: {
    method: WriteHttpMethod;
    path: string;
    body?: unknown;
  };
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

  const tenantSegment = activeTenant
    ? `tenant ${activeTenant.displayName}`
    : "no tenant";

  if (!provider) {
    const base: TrustState = {
      label: "Provider not configured",
      detail: "Select a provider before running agents.",
      isLocal: true,
    };
    if (activeTenant) base.tenantDisplayName = activeTenant.displayName;
    return base;
  }

  if (provider.isLocal) {
    const detail = activeTenant
      ? `Tenant data stays on this device. Prompts use ${provider.name} locally.`
      : `Prompts use ${provider.name} locally.`;
    const base: TrustState = {
      label: `Local ${provider.name} · ${tenantSegment}`,
      detail,
      isLocal: true,
    };
    if (activeTenant) base.tenantDisplayName = activeTenant.displayName;
    return base;
  }

  const detail = activeTenant
    ? `Tenant data is read from Microsoft Graph. Prompts are sent to ${provider.name}.`
    : `Prompts are sent to ${provider.name}.`;
  const base: TrustState = {
    label: `Hosted ${provider.name} · ${tenantSegment}`,
    detail,
    isLocal: false,
  };
  if (activeTenant) base.tenantDisplayName = activeTenant.displayName;
  return base;
}

export function defineAgent<const TAgent extends AgentModule>(
  agent: TAgent,
): TAgent {
  return agent;
}

// ─── Connector abstraction ────────────────────────────────────────────────
//
// See docs/SPEC.md §2 "Connector abstraction" for the full design rationale,
// confirmation tiers, and trust model. The types below are the contract the
// runtime and per-connector packages implement against. No runtime injection
// yet — `RunContext.connectors` is optional and stays undefined in the
// v0.1.x runtime; the v0.2 runtime populates it after preflight.

export type ConnectorAuthSource =
  | "graph-delegated"
  | "graph-application"
  | "external";

export type CapabilityKind = "read" | "notify" | "mutating" | "destructive";

export interface ConnectorTrust {
  /**
   * Short label, e.g. "Microsoft Teams · {tenant}". The literal
   * `{tenant}` token is substituted by the runtime with the active
   * tenant's display name when surfacing this in the status strip.
   */
  label: string;
  /** One sentence on where data actually goes when capabilities are invoked. */
  detail: string;
  /** True for `graph-delegated` / `graph-application`; false for `external`. */
  staysInTenant: boolean;
}

export interface CapabilityDescriptor {
  /** Stable identifier, lowercase kebab-case. */
  id: string;
  /**
   * SemVer major version. Minor and patch increments are non-breaking
   * and do not require a new major. Agents pin a major via
   * `AgentConnectorRequirement.capabilities[].version`; the runtime
   * accepts any minor/patch of the same major.
   */
  version: number;
  kind: CapabilityKind;
  /**
   * Subset of `ConnectorDescriptor.scopes` required to invoke this
   * capability. Used to compute the MSAL consent set when the agent
   * is installed and to fail preflight with a precise missing-scope
   * error when consent is incomplete.
   */
  scopes: string[];
  /**
   * Optional per-capability overrides for the connector-level trust
   * label. Used when one capability has materially different egress
   * (e.g. a connector that both posts to Teams and opens a webhook).
   */
  trust?: Partial<ConnectorTrust>;
}

export interface ConnectorDescriptor {
  id: string;
  name: string;
  /** SemVer of the connector implementation. */
  version: string;
  authSource: ConnectorAuthSource;
  /** Union of every capability's scope set. Used for MSAL consent computation. */
  scopes: string[];
  capabilities: CapabilityDescriptor[];
  /**
   * JSON Schema (draft-07) describing per-install configuration. The
   * Connectors page renders the setup form from this schema — no
   * per-connector UI code is required for routine config like channel
   * pickers or instance URLs.
   */
  configSchema?: object;
  trust: ConnectorTrust;
}

export type ConnectorStatus =
  | "connected"
  | "needs-setup"
  | "needs-scope"
  | "error";

export interface ConnectorInstance<TCapabilities> {
  descriptor: ConnectorDescriptor;
  status: ConnectorStatus;
  capabilities: TCapabilities;
  /**
   * Cheap, side-effect-free reachability probe. Called at preflight; a
   * `healthy: false` result fails the run with the supplied message
   * surfaced as a designed remediation tile.
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }>;
  /** Called once at run finish, success or failure. */
  dispose(): Promise<void>;
}

/**
 * Subset of the tenant session exposed to connectors. Connectors with
 * `authSource: "graph-delegated"` use `acquireTokenForScopes` to mint a
 * scoped Graph token. `external` connectors ignore the token surface
 * and read credentials from `ConnectorBuildContext.secrets` instead.
 */
export interface TenantSession {
  tenantId: string;
  username: string;
  /** Mints a Graph token covering the requested scope set. Implementations cache per scope set. */
  acquireTokenForScopes(scopes: string[]): Promise<string>;
}

/**
 * Keychain-backed secret accessor. Connectors with
 * `authSource: "external"` read and write here under their own id
 * namespace. The runtime rejects access outside the connector's own
 * namespace; cross-connector secret leakage is structurally impossible.
 */
export interface SecretAccessor {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ConnectorBuildContext {
  tenant: TenantSession;
  /** Validated against `ConnectorDescriptor.configSchema` before `build` is called. */
  config: Record<string, unknown>;
  secrets: SecretAccessor;
  log: (level: RunLogLevel, message: string, metadata?: Record<string, unknown>) => void;
  /**
   * Runtime-supplied idempotency key generator. Stable across retries
   * for the same `(stepId, iteration)`, so connectors that honor remote
   * idempotency (Graph `Idempotency-Key`, ServiceNow correlation IDs)
   * do not duplicate side effects when a step is re-executed after a
   * recoverable failure.
   */
  idempotencyKeyFor(stepId: string, iteration: number): string;
}

export interface ConnectorFactory<TCapabilities> {
  descriptor: ConnectorDescriptor;
  build(ctx: ConnectorBuildContext): Promise<ConnectorInstance<TCapabilities>>;
}

/**
 * Empty registry interface, populated by each connector package via
 * TypeScript declaration merging:
 *
 * ```ts
 * declare module '@openagents/agent-sdk' {
 *   interface ConnectorRegistry {
 *     teams: TeamsConnectorCapabilities;
 *   }
 * }
 * ```
 *
 * `ConnectorAccessor` narrows to the augmented keys, so `ctx.connectors.teams`
 * is fully typed only when `@openagents/connector-teams` is installed in
 * the workspace. The SDK has no awareness of the known connector list.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ConnectorRegistry {}

/**
 * Typed accessor for `RunContext.connectors`. Required connectors are
 * guaranteed populated by preflight; optional connectors may be
 * `undefined` at access time and the agent must branch. Keys are
 * narrowed to the augmented `ConnectorRegistry` interface.
 */
export type ConnectorAccessor = {
  readonly [K in keyof ConnectorRegistry]?: ConnectorInstance<ConnectorRegistry[K]>;
};

export interface AgentConnectorRequirement {
  /**
   * Connector id as a plain string. Validated against the host's
   * registered connectors at manifest load — typed narrowing happens
   * at the `ctx.connectors[id]` access point, not here, so YAML
   * manifests can declare ids the consuming workspace doesn't statically
   * know about.
   */
  id: string;
  /**
   * Minimum acceptable connector implementation version (SemVer). The
   * runtime accepts any installed connector version that is `>= minVersion`
   * within the same major.
   */
  minVersion: string;
  capabilities: { id: string; version: number }[];
  /**
   * When `true`, preflight fails the run if the connector is
   * unconfigured or unhealthy. When `false`, `ctx.connectors[id]` may
   * be `undefined` at run time and the agent must branch on its
   * presence.
   */
  required: boolean;
}

// ─── Connector errors ─────────────────────────────────────────────────────
//
// Connector implementations throw these typed errors; the runtime maps
// `recovery` values to designed UI remediations. Generic `Error` throws
// are wrapped by the runtime in `ConnectorRemoteError` with
// `recovery: 'fatal'` so every failure has a designed state.

export type ConnectorRecovery = "retry" | "reauth" | "reconfigure" | "fatal";

export interface ConnectorErrorArgs {
  connectorId: string;
  capabilityId?: string;
  cause?: unknown;
}

export abstract class ConnectorError extends Error {
  abstract readonly recovery: ConnectorRecovery;
  readonly connectorId: string;
  readonly capabilityId: string | undefined;

  constructor(message: string, args: ConnectorErrorArgs) {
    super(
      message,
      args.cause !== undefined ? { cause: args.cause } : undefined,
    );
    this.name = new.target.name;
    this.connectorId = args.connectorId;
    this.capabilityId = args.capabilityId;
  }
}

export class ConnectorAuthError extends ConnectorError {
  readonly recovery = "reauth" as const;
}

export interface ConnectorScopeErrorArgs extends ConnectorErrorArgs {
  missingScopes: string[];
}

export class ConnectorScopeError extends ConnectorError {
  readonly recovery = "reauth" as const;
  readonly missingScopes: readonly string[];

  constructor(message: string, args: ConnectorScopeErrorArgs) {
    super(message, args);
    this.missingScopes = [...args.missingScopes];
  }
}

export interface ConnectorRateLimitErrorArgs extends ConnectorErrorArgs {
  retryAfterMs: number;
}

export class ConnectorRateLimitError extends ConnectorError {
  readonly recovery = "retry" as const;
  readonly retryAfterMs: number;

  constructor(message: string, args: ConnectorRateLimitErrorArgs) {
    super(message, args);
    this.retryAfterMs = args.retryAfterMs;
  }
}

export class ConnectorNotConfiguredError extends ConnectorError {
  readonly recovery = "reconfigure" as const;
}

export interface ConnectorRemoteErrorArgs extends ConnectorErrorArgs {
  recovery: "retry" | "fatal";
  statusCode?: number;
}

export class ConnectorRemoteError extends ConnectorError {
  readonly recovery: "retry" | "fatal";
  readonly statusCode: number | undefined;

  constructor(message: string, args: ConnectorRemoteErrorArgs) {
    super(message, args);
    this.recovery = args.recovery;
    this.statusCode = args.statusCode;
  }
}

export class ConnectorValidationError extends ConnectorError {
  readonly recovery = "fatal" as const;
}

// ─── Connector audit ──────────────────────────────────────────────────────

export interface ConnectorAuditEntry {
  runId: string;
  stepId: string;
  /** Connector id, e.g. 'teams'. */
  connector: string;
  /** `${capabilityId}@${version}`, e.g. 'post-channel-message@1'. */
  capability: string;
  kind: CapabilityKind;
  idempotencyKey: string;
  /** Human-readable egress location, surfaced in the audit log export. */
  egressTarget: string;
  /** SHA-256 of the redacted args payload; used to detect duplicate sends. */
  argsDigest: string;
  status: "success" | "failure";
  durationMs: number;
  externalId?: string;
  externalUrl?: string;
  /** Subclass name of the thrown `ConnectorError`, when status is 'failure'. */
  errorClass?: string;
  errorMessage?: string;
}

/**
 * Symmetric counterpart to `defineAgent`. Locks the capability type at
 * the call site so connector packages can preserve full type
 * information for the registry augmentation pattern.
 */
export function defineConnector<TCapabilities>(
  factory: ConnectorFactory<TCapabilities>,
): ConnectorFactory<TCapabilities> {
  return factory;
}

/**
 * Wire-serializable payload sent from the main process to the
 * renderer when a `notify`/`mutating`/`destructive` capability is
 * about to fire. Fields mirror `ConnectorInvocationInfo` from the
 * runtime, plus a `requestId` the renderer echoes back in
 * `respondToConnectorConfirm`.
 */
export interface PendingConnectorConfirmation {
  requestId: string;
  runId: string;
  stepId: string;
  connectorId: string;
  connectorName: string;
  capability: CapabilityDescriptor;
  args: unknown;
  egressTarget: string;
  idempotencyKey: string;
  /**
   * Markdown source of the body. The modal renders this into a
   * Teams-equivalent React tree client-side (no innerHTML mount) so
   * the user sees a faithful approximation of how the message will
   * land in the destination.
   */
  bodyPreview?: string;
  /** Best-effort label for the egress target ("Team A · #it-ops"). */
  targetLabel?: string;
}

export type PendingConnectorDecision =
  | { approved: true }
  | { approved: false; reason: string };

/**
 * Renderer-facing summary of a registered connector. Surfaces the
 * descriptor plus any host-tracked state (persisted config, last
 * health-check outcome). The Connectors page consumes this directly.
 */
/** Lightweight team reference returned by `listConnectorTeams`. */
export interface ConnectorTeamRef {
  id: string;
  displayName: string;
}

/** Lightweight channel reference returned by `listConnectorChannels`. */
export interface ConnectorChannelRef {
  id: string;
  displayName: string;
  membershipType?: "standard" | "private" | "shared" | "unknown";
}

export interface ConnectorSummary {
  descriptor: ConnectorDescriptor;
  /**
   * Persisted per-install configuration. Validated against
   * `descriptor.configSchema` by the host before storage.
   */
  config: Record<string, unknown>;
  /**
   * Last known status. `unknown` means no health check has been
   * performed yet — the renderer surfaces this as a neutral pill
   * until the user clicks "Test connection".
   */
  status: ConnectorStatus | "unknown";
  lastTestedAt?: string;
  lastTestMessage?: string;
}
