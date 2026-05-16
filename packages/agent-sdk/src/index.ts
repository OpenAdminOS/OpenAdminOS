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
}

export interface RegistryAgentSummary extends AgentContract {
  registryId: string;
  registryPath?: string;
  installs?: number;
  rating?: number;
}

export type RunStatus =
  | "queued"
  | "running"
  | "awaiting-confirmation"
  | "completed"
  | "failed"
  | "rejected";

export type RunDataSource = "graph" | "synthetic";

export interface StartRunOptions {
  /**
   * Pin the run to a specific tenant id at queue time. Pass `null` to force
   * synthetic mode regardless of the currently-active tenant. Omit to default
   * to whichever tenant is active when the run is queued.
   */
  tenantId?: string | null;
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
  providers: ProviderSummary[];
  registryAgents: RegistryAgentSummary[];
  installedAgents: AgentSummary[];
  runs: RunRecord[];
  trust: TrustState;
  tenants: TenantRecord[];
  activeTenantId?: string;
  /**
   * Global toggle that gates whether write-mode agents may call real
   * Microsoft Graph mutating endpoints. Default `false`. Even when `true`,
   * every write run still pauses for typed diff confirmation; this toggle
   * only controls whether the approved `apply` phase actually hits Graph
   * or emits a simulated trace.
   */
  realWritesEnabled: boolean;
}

export interface OpenAgentsApi {
  getAppState(): Promise<AppState>;
  listRegistryAgents(): Promise<RegistryAgentSummary[]>;
  listInstalledAgents(): Promise<AgentSummary[]>;
  listAgents(): Promise<AgentSummary[]>;
  listProviders(): Promise<ProviderSummary[]>;
  installAgent(agentId: string): Promise<AppState>;
  setActiveProvider(id: ProviderId): Promise<AppState>;
  startRun(agentSlug: string, options?: StartRunOptions): Promise<RunRecord>;
  getRun(id: string): Promise<RunRecord | undefined>;
  confirmRun(runId: string, phrase: string): Promise<RunRecord>;
  rejectRun(runId: string): Promise<RunRecord>;
  listTenants(): Promise<TenantRecord[]>;
  connectTenant(): Promise<AppState>;
  setActiveTenant(id: string): Promise<AppState>;
  disconnectTenant(id: string): Promise<AppState>;
  setRealWritesEnabled(enabled: boolean): Promise<AppState>;
}

export type AgentDefinition = AgentContract &
  Partial<Pick<RegistryAgentSummary, "registryId" | "registryPath" | "installs" | "rating">>;

// ─── Tier 1 manifest types ─────────────────────────────────────────────────
//
// Tier 1 agents are declared as a YAML pipeline of `skills`. The runtime
// interprets the manifest top-to-bottom; each skill's output is stored under
// its `id` and available to later skills via templating (`{{ skill_id.output }}`).
// No code execution — the only side effects an agent can have are the Graph
// calls and LLM calls it declares.

export type Tier1SkillFormat = "graph" | "transform" | "llm";

export interface Tier1GraphSkill {
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

export interface Tier1TransformSkill {
  id: string;
  format: "transform";
  label: string;
  detail?: string;
  settings: Record<string, unknown> & { kind: string; source: string };
}

export interface Tier1LlmSkill {
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

export type Tier1Skill = Tier1GraphSkill | Tier1TransformSkill | Tier1LlmSkill;

export type Tier1TriggerKind = "manual" | "scheduled";

export interface Tier1Trigger {
  id: string;
  kind: Tier1TriggerKind;
  /** Only consulted when `kind: scheduled`; ignored in v0.1. */
  intervalSeconds?: number;
}

export interface Tier1SettingDef {
  id: string;
  label: string;
  type: "string" | "integer" | "boolean";
  default?: unknown;
  description?: string;
  hint?: string;
  required?: boolean;
}

export interface Tier1ResultShape {
  summary: string;
  data?: Record<string, unknown>;
}

export interface Tier1Manifest {
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
  skills: Tier1Skill[];
  definition: {
    settings?: Tier1SettingDef[];
    triggers?: Tier1Trigger[];
    result: Tier1ResultShape;
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
   * connected + real-writes toggle ON) is surfaced via `RunContext.realWrites`;
   * agents should branch on that flag before calling this method.
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

export interface LlmCompletion {
  text: string;
  model: string;
}

export interface LlmStreamChunk {
  delta: string;
  accumulated: string;
  done: boolean;
  model: string;
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
   * Whether write actions invoked via `ctx.graph.*` will hit real Graph.
   *
   * `true`  — a tenant is connected AND the user has flipped the global
   *           "Enable real Graph writes" toggle ON. Destructive operations
   *           in `apply` should call the real Graph methods.
   * `false` — no tenant connected, OR the toggle is OFF. `apply` should
   *           emit a log line describing what *would* have happened and
   *           skip the destructive call so the synthetic / blocked mode
   *           remains honest about not touching the tenant.
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
    ? `real tenant ${activeTenant.displayName}`
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
