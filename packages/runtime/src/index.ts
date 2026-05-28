import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentConnectorRequirement,
  AgentManifestPreview,
  AgentModule,
  AgentRunResult,
  AgentSummary,
  ConnectorAuditEntry,
  ConnectorAccessor,
  LlmStreamChunk,
  LlmTokenUsage,
  ProviderId,
  ReadAgentModule,
  RegistryAgentSummary,
  RunContext,
  RunGraphApi,
  RunLlmApi,
  RunLogLevel,
  RunLogRecord,
  RunRecord,
  RunStepThinking,
  SecretAccessor,
  TenantSession,
  WriteAgentModule,
  WritePlan,
} from "@openadminos/agent-sdk";

import { createOllamaLlm, noopLlm } from "./llm-ollama.js";
import { createCodexLlm, probeCodexLlm } from "./llm-codex.js";
import {
  parseAgentTemplate,
  agentTemplateToModule,
  agentTemplateToRegistrySummary,
} from "./agent-template.js";
import {
  disposeBuiltConnectors,
  noSecrets,
  preflightConnectors,
  wrapConnector,
  type BuiltConnector,
  type ConfirmationDecision,
  type ConnectorInvocationInfo,
} from "./connectors.js";

export { createOllamaLlm, noopLlm } from "./llm-ollama.js";
export { createCodexLlm, probeCodexLlm } from "./llm-codex.js";
export {
  createRegistryInstallCountPayload,
  type RegistryInstallCountPayload,
  type RegistryInstallCountPayloadInput,
} from "./install-stats.js";
export {
  ManifestValidationError,
  parseAgentTemplate,
  runAgentTemplate,
  runAgentTemplatePlan,
  runAgentTemplateApply,
  agentTemplateToModule,
} from "./agent-template.js";
export { renderTemplate, renderDeep } from "./template-engine.js";
export {
  acquireTokenSilent,
  createMsalClient,
  DEFAULT_AUTHORITY,
  DEFAULT_SCOPES,
  DEFAULT_SCOPE_METADATA,
  GRAPH_CLI_CLIENT_ID,
  removeAccount,
  runInteractiveFlow,
  type RequestedScopeMetadata,
  type TokenCacheStorage,
} from "./msal.js";
export {
  createGraphAdapter,
  type GraphAdapterLogger,
  type GraphAdapterOptions,
} from "./graph-adapter.js";
export {
  detectEntraTier,
  probeSubscribedSkus,
  classifySkus,
  extractRelevantLicenses,
  tenantSatisfiesRequirement,
} from "./entra-tier.js";
export { createTenantSession } from "./msal.js";
export {
  disposeBuiltConnectors,
  findConnectorFactory,
  listRegisteredConnectors,
  noSecrets,
  preflightConnectors,
  wrapConnector,
  type BuiltConnector,
  type ConfirmationDecision,
  type ConnectorInvocationInfo,
} from "./connectors.js";

const builtInRegistryRoot = "agents";

export function listBuiltInRegistryAgents(): RegistryAgentSummary[] {
  const agentsRoot = findAgentsRoot();
  const agents = listAgentsInRoot(agentsRoot, { absolutePaths: false });
  const stats = loadAgentStats(dirname(agentsRoot));
  if (!stats) return agents;
  return agents.map((agent) => {
    const entry = stats[agent.slug];
    return entry && typeof entry.installs === "number"
      ? { ...agent, installs: entry.installs }
      : agent;
  });
}

interface AgentStatsEntry {
  installs?: number;
  installs7d?: number;
}

/**
 * Read `<root>/stats/agents.json` next to the bundled `agents/`
 * directory. Returns `null` when the file is absent or malformed —
 * stats are non-critical, so we never throw from this path.
 */
function loadAgentStats(root: string): Record<string, AgentStatsEntry> | null {
  const statsPath = join(root, "stats", "agents.json");
  if (!existsSync(statsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(statsPath, "utf8")) as {
      agents?: Record<string, AgentStatsEntry>;
    };
    if (parsed && typeof parsed === "object" && parsed.agents && typeof parsed.agents === "object") {
      return parsed.agents;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * List every agent visible to the runtime — both the bundled set under
 * `agents/` (read-only, ships with the app) and any user-authored
 * agents written to `userAgentsRoot` (writable, populated by NL2Agent
 * etc.). When `userAgentsRoot` doesn't exist or has no agent
 * directories, the result is identical to `listBuiltInRegistryAgents()`.
 *
 * Bundled and user agents are merged and de-duplicated by slug — a
 * user-authored agent with the same slug as a bundled one shadows the
 * bundled one. This matches the precedent set by the loader, which
 * prefers the user dir when both define the same slug.
 */
export function listAllRegistryAgents(
  userAgentsRoot?: string,
): RegistryAgentSummary[] {
  const builtin = listBuiltInRegistryAgents();
  if (!userAgentsRoot || !existsSync(userAgentsRoot)) {
    return builtin;
  }

  const user = listAgentsInRoot(userAgentsRoot, { absolutePaths: true });
  const bySlug = new Map<string, RegistryAgentSummary>();
  for (const agent of builtin) bySlug.set(agent.slug, agent);
  for (const agent of user) bySlug.set(agent.slug, agent); // user shadows builtin
  return [...bySlug.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function listAgentsInRoot(
  agentsRoot: string,
  options: { absolutePaths: boolean },
): RegistryAgentSummary[] {
  if (!existsSync(agentsRoot)) return [];
  return readdirSync(agentsRoot)
    .map((entryName) => join(agentsRoot, entryName))
    .filter((entryPath) => {
      try {
        return statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((agentPath) => existsSync(join(agentPath, "manifest.yaml")))
    .map((agentPath) =>
      loadRegistrySummaryFromYaml(agentPath, {
        absoluteRegistryPath: options.absolutePaths,
      }),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function findRegistryAgentById(
  id: string,
  userAgentsRoot?: string,
): RegistryAgentSummary | undefined {
  return listAllRegistryAgents(userAgentsRoot).find(
    (agent) => agent.id === id || agent.registryId === id || agent.slug === id,
  );
}

export function toInstalledAgent(
  agent: RegistryAgentSummary,
  installedAt: Date | string,
): AgentSummary {
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    category: agent.category,
    tier: agent.tier ?? "agent",
    requiresEntraTier: agent.requiresEntraTier ?? "free",
    scopes: agent.scopes,
    author: agent.author,
    version: agent.version,
    preferredModel: agent.preferredModel,
    registryId: agent.registryId,
    registryPath: agent.registryPath,
    graphOperations: agent.graphOperations,
    ...(agent.connectors && agent.connectors.length > 0
      ? { connectors: agent.connectors }
      : {}),
    installedAt: normalizeIsoDate(installedAt, "installedAt"),
  };
}

export function createQueuedRun(input: {
  agent: RegistryAgentSummary | AgentSummary;
  providerId: ProviderId;
  model?: string;
}): RunRecord {
  const now = new Date().toISOString();
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    id: runId,
    agentSlug: input.agent.slug,
    status: "queued",
    queuedAt: now,
    providerId: input.providerId,
    model: input.model,
    summary: `${input.agent.name} is queued.`,
    steps: [],
    logs: [
      buildLog(runId, "info", `Queued ${input.agent.name}.`, now),
    ],
  };
}

/**
 * Factory that builds the run-scoped Graph adapter. The runtime invokes
 * it once per phase, passing its per-step logger so the adapter can
 * emit start/end log entries that attach to whichever step is active
 * when the Graph call fires. Hosts wire this through
 * `(log) => createGraphAdapter({ tokenProvider, log })`.
 */
export type CreateGraphAdapter = (
  log: (
    level: RunLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ) => void,
) => RunGraphApi;

export interface ExecuteRunInput {
  run: RunRecord;
  agent: AgentSummary;
  providerId: ProviderId;
  model?: string;
  llm?: RunLlmApi;
  createGraph: CreateGraphAdapter;
  /**
   * Whether the agent is allowed to call destructive Graph methods
   * during this run. The per-write typed diff confirmation is the
   * user-facing gate. Defaults to `false` so unconfigured callers
   * cannot accidentally perform real writes.
   */
  realWrites?: boolean;
  /**
   * Tenant session for connector use. Required when the agent
   * declares any connectors with `authSource: 'graph-delegated'`.
   * Built via `createTenantSession({ msalClient, ... })`.
   */
  tenant?: TenantSession;
  /**
   * Per-connector configuration overrides (keyed by connector id).
   * Validated against each connector's `configSchema` before
   * `factory.build()` is called.
   */
  connectorConfigs?: Record<string, Record<string, unknown>>;
  /**
   * Optional per-connector secret accessor (only used by connectors
   * with `authSource: 'external'`). When omitted, a no-op accessor
   * is supplied; `external` connectors will fail to initialize.
   */
  connectorSecretsFor?: (connectorId: string) => SecretAccessor;
  /**
   * Called before every `notify`/`mutating`/`destructive` capability
   * invocation. The wrapper aborts the call when this returns
   * `{ approved: false }`. Phase 6 wires this to the preview-and-send
   * modal; in this phase, callers that omit it auto-approve with an
   * info-level log entry.
   */
  confirmCapability?: (
    info: ConnectorInvocationInfo,
  ) => Promise<ConfirmationDecision>;
  /**
   * Receives a structured audit entry for every capability call
   * (success or failure). The host appends these to the run record
   * for surfacing in the timeline and audit log export.
   */
  onConnectorAudit?: (entry: ConnectorAuditEntry) => void;
  onProgress(run: RunRecord): void | Promise<void>;
}

export interface ExecuteApplyInput extends ExecuteRunInput {
  plan: WritePlan;
}

interface PhaseHandle {
  getWorking(): RunRecord;
  setWorking(update: (run: RunRecord) => RunRecord): RunRecord;
  emit(): Promise<void>;
  ctx: RunContext;
  /** Built connectors awaiting disposal at end of phase. */
  builtConnectors: BuiltConnector[];
}

async function createPhaseHandle(
  input: ExecuteRunInput,
  initialOverrides: Partial<RunRecord>,
  startupLog: string,
): Promise<PhaseHandle> {
  const startedAt = new Date().toISOString();
  let working: RunRecord = {
    ...input.run,
    ...initialOverrides,
    logs: [
      ...input.run.logs,
      buildLog(input.run.id, "info", startupLog, startedAt),
    ],
  };
  await input.onProgress(working);

  let currentStepId: string | null = null;

  const baseLlm = input.llm ?? noopLlm;
  const llm = wrapLlmWithThinking(baseLlm, {
    getCurrentStepId: () => currentStepId,
    updateStepThinking: (stepId, update) => {
      working = {
        ...working,
        steps: working.steps.map((step) =>
          step.id === stepId
            ? { ...step, thinking: update(step.thinking) }
            : step,
        ),
      };
      void input.onProgress(working);
    },
    updateLiveSummary: (text, streaming) => {
      const liveSummary = cleanLiveLlmText(text);
      if (liveSummary.length === 0) return;
      working = {
        ...working,
        liveSummary,
        summary: streaming ? liveSummary : working.summary,
      };
      void input.onProgress(working);
    },
    accumulateTokens: (usage) => {
      working = { ...working, tokens: mergeTokenUsage(working.tokens, usage) };
      void input.onProgress(working);
    },
  });

  const logFn = (
    level: RunLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ) => {
    working = appendLog(working, level, message, currentStepId, metadata);
    void input.onProgress(working);
  };

  const requirements = (input.agent.connectors ?? []) as readonly AgentConnectorRequirement[];
  let connectorAccessor: ConnectorAccessor | undefined;
  let builtConnectors: BuiltConnector[] = [];
  if (requirements.length > 0) {
    if (!input.tenant) {
      throw new Error(
        `Agent "${input.agent.slug}" declares ${requirements.length} connector(s) but no tenant session was supplied.`,
      );
    }
    const iterationCounters = new Map<string, number>();
    const nextIteration = (stepId: string, capabilityId: string): number => {
      const key = `${stepId}:${capabilityId}`;
      const next = (iterationCounters.get(key) ?? 0) + 1;
      iterationCounters.set(key, next);
      return next - 1;
    };

    const preflight = await preflightConnectors({
      runId: input.run.id,
      requirements,
      tenant: input.tenant,
      configFor: (connectorId) => input.connectorConfigs?.[connectorId] ?? {},
      secretsFor: (connectorId) =>
        input.connectorSecretsFor?.(connectorId) ?? noSecrets,
      log: logFn,
    });
    builtConnectors = preflight.built;

    const wrappedAccessor: Record<string, unknown> = {};
    for (const entry of preflight.built) {
      wrappedAccessor[entry.id] = wrapConnector(entry.id, entry.instance, {
        runId: input.run.id,
        currentStepId: () => currentStepId,
        ...(input.confirmCapability
          ? { confirmInvocation: input.confirmCapability }
          : {}),
        onAuditEntry: (entry: ConnectorAuditEntry) => {
          if (input.onConnectorAudit) input.onConnectorAudit(entry);
          logFn(
            entry.status === "success" ? "info" : "warn",
            `Connector ${entry.connector}.${entry.capability} ${entry.status}` +
              (entry.externalUrl ? ` (${entry.externalUrl})` : ""),
            { connectorAudit: entry as unknown as Record<string, unknown> },
          );
        },
        nextIteration,
      });
    }
    connectorAccessor = wrappedAccessor as ConnectorAccessor;
  }

  const graph = input.createGraph(logFn);

  const ctx: RunContext = {
    agent: toAgentDefinition(input.agent),
    providerId: input.providerId,
    model: input.model,
    graph,
    llm,
    realWrites: input.realWrites ?? false,
    settings: input.agent.settings,
    ...(connectorAccessor !== undefined ? { connectors: connectorAccessor } : {}),
    log: (level, message, metadata) => {
      working = appendLog(working, level, message, currentStepId, metadata);
      void input.onProgress(working);
    },
    step: async (label, detail, fn) => {
      const stepId = `step_${working.steps.length + 1}_${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const stepStartedAt = new Date().toISOString();
      const previousStepId = currentStepId;
      currentStepId = stepId;

      working = {
        ...working,
        steps: [
          ...working.steps,
          {
            id: stepId,
            runId: working.id,
            label,
            status: "running",
            detail,
            startedAt: stepStartedAt,
          },
        ],
      };
      await input.onProgress(working);

      try {
        const value = await fn();
        const stepFinishedAt = new Date().toISOString();
        working = {
          ...working,
          steps: working.steps.map((step) =>
            step.id === stepId
              ? { ...step, status: "completed", finishedAt: stepFinishedAt }
              : step,
          ),
        };
        await input.onProgress(working);
        return value;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stepFinishedAt = new Date().toISOString();
        working = {
          ...working,
          steps: working.steps.map((step) =>
            step.id === stepId
              ? { ...step, status: "failed", finishedAt: stepFinishedAt, detail: message }
              : step,
          ),
          logs: [
            ...working.logs,
            buildLog(working.id, "error", `Step "${label}" failed: ${message}`, stepFinishedAt, stepId),
          ],
        };
        await input.onProgress(working);
        throw error;
      } finally {
        currentStepId = previousStepId;
      }
    },
  };

  return {
    getWorking: () => working,
    setWorking: (update) => {
      working = update(working);
      return working;
    },
    emit: () => Promise.resolve(input.onProgress(working)).then(() => undefined),
    ctx,
    builtConnectors,
  };
}

interface ThinkingHooks {
  getCurrentStepId(): string | null;
  updateStepThinking(
    stepId: string,
    update: (current: RunStepThinking | undefined) => RunStepThinking | undefined,
  ): void;
  updateLiveSummary(text: string, streaming: boolean): void;
  accumulateTokens(usage: LlmTokenUsage): void;
}

export function mergeTokenUsage(
  current: LlmTokenUsage | undefined,
  next: LlmTokenUsage,
): LlmTokenUsage {
  const merged: LlmTokenUsage = { ...(current ?? {}) };
  if (typeof next.promptTokens === "number") {
    merged.promptTokens = (merged.promptTokens ?? 0) + next.promptTokens;
  }
  if (typeof next.completionTokens === "number") {
    merged.completionTokens = (merged.completionTokens ?? 0) + next.completionTokens;
  }
  if (typeof next.totalTokens === "number") {
    merged.totalTokens = (merged.totalTokens ?? 0) + next.totalTokens;
  } else if (
    typeof merged.promptTokens === "number" &&
    typeof merged.completionTokens === "number"
  ) {
    merged.totalTokens = merged.promptTokens + merged.completionTokens;
  }
  return merged;
}

function wrapLlmWithThinking(base: RunLlmApi, hooks: ThinkingHooks): RunLlmApi {
  const guardAvailable = () => {
    if (!base.available) {
      throw new Error(
        "ctx.llm is not available. Check ctx.llm.available before calling complete()/stream().",
      );
    }
  };

  return {
    available: base.available,
    defaultModel: base.defaultModel,
    async complete(options) {
      guardAvailable();
      let last: LlmStreamChunk | undefined;
      for await (const chunk of this.stream(options)) {
        last = chunk;
      }
      if (!last) {
        throw new Error("LLM provider returned no content.");
      }
      return {
        text: last.accumulated,
        model: last.model,
        ...(last.tokenUsage ? { tokenUsage: last.tokenUsage } : {}),
      };
    },
    async *stream(options) {
      guardAvailable();
      const stepId = hooks.getCurrentStepId();
      const reset = () => {
        if (stepId) {
          hooks.updateStepThinking(stepId, () => undefined);
        }
      };

      try {
        for await (const chunk of base.stream(options)) {
          if (stepId) {
            hooks.updateStepThinking(stepId, () => ({
              text: chunk.accumulated,
              model: chunk.model,
              streaming: !chunk.done,
            }));
          }
          hooks.updateLiveSummary(chunk.accumulated, !chunk.done);
          if (chunk.done && chunk.tokenUsage) {
            hooks.accumulateTokens(chunk.tokenUsage);
          }
          yield chunk;
        }
        if (stepId) {
          hooks.updateStepThinking(stepId, (current) =>
            current ? { ...current, streaming: false } : current,
          );
        }
      } catch (error) {
        reset();
        throw error;
      }
    },
  };
}

function cleanLiveLlmText(value: string): string {
  return value
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

async function failPhase(
  input: ExecuteRunInput,
  working: RunRecord,
  error: unknown,
): Promise<RunRecord> {
  const finishedAt = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const failed: RunRecord = {
    ...working,
    status: "failed",
    finishedAt,
    summary: `${input.agent.name} failed: ${message}`,
    error: message,
    logs: [
      ...working.logs,
      buildLog(working.id, "error", `Agent failed: ${message}`, finishedAt),
    ],
  };
  await input.onProgress(failed);
  return failed;
}

export async function executeRun(input: ExecuteRunInput): Promise<RunRecord> {
  const handle = await createPhaseHandle(
    input,
    {
      status: "running",
      startedAt: new Date().toISOString(),
      summary: `${input.agent.name} is running.`,
    },
    "Started agent.",
  );

  try {
    const module = await loadAgentModule(input.agent);
    if (module.mode !== "read" || typeof (module as ReadAgentModule).run !== "function") {
      throw new Error(
        `Agent "${input.agent.slug}" is not a read agent. Use executePlan/executeApply for write agents.`,
      );
    }
    const outcome: AgentRunResult = await (module as ReadAgentModule).run(handle.ctx);
    const finishedAt = new Date().toISOString();
    const completed = handle.setWorking((working) => ({
      ...working,
      status: "completed",
      finishedAt,
      summary: outcome.summary,
      liveSummary: undefined,
      result: outcome.result,
      logs: [
        ...working.logs,
        buildLog(working.id, "info", "Agent completed.", finishedAt),
      ],
    }));
    await handle.emit();
    return completed;
  } catch (error) {
    return failPhase(input, handle.getWorking(), error);
  } finally {
    if (handle.builtConnectors.length > 0) {
      await disposeBuiltConnectors(handle.builtConnectors, (level, message, metadata) => {
        handle.setWorking((working) => appendLog(working, level, message, null, metadata));
        void handle.emit();
      });
    }
  }
}

export async function executePlan(input: ExecuteRunInput): Promise<RunRecord> {
  const handle = await createPhaseHandle(
    input,
    {
      status: "running",
      startedAt: new Date().toISOString(),
      summary: `${input.agent.name} is planning.`,
    },
    "Started plan phase.",
  );

  try {
    const module = await loadAgentModule(input.agent);
    if (module.mode !== "write" || typeof (module as WriteAgentModule).plan !== "function") {
      throw new Error(
        `Agent "${input.agent.slug}" is not a write agent.`,
      );
    }
    const plan: WritePlan = await (module as WriteAgentModule).plan(handle.ctx);
    validatePlan(plan, input.agent.slug);

    const pausedAt = new Date().toISOString();
    if (plan.actions.length === 0) {
      const completed = handle.setWorking((working) => ({
        ...working,
        status: "completed",
        finishedAt: pausedAt,
        summary: plan.summary,
        liveSummary: undefined,
        plan,
        result: {
          mode: input.realWrites ? "real" : "simulated",
          total: 0,
          successCount: 0,
          failureCount: 0,
          skippedReason: "No write actions matched the current tenant inventory.",
        },
        logs: [
          ...working.logs,
          buildLog(
            working.id,
            "info",
            "Plan ready (0 actions). No confirmation required.",
            pausedAt,
          ),
        ],
      }));
      await handle.emit();
      return completed;
    }

    const awaiting = handle.setWorking((working) => ({
      ...working,
      status: "awaiting-confirmation",
      summary: plan.summary,
      liveSummary: undefined,
      plan,
      logs: [
        ...working.logs,
        buildLog(
          working.id,
          "info",
          `Plan ready (${plan.actions.length} actions). Awaiting typed confirmation.`,
          pausedAt,
        ),
      ],
    }));
    await handle.emit();
    return awaiting;
  } catch (error) {
    return failPhase(input, handle.getWorking(), error);
  } finally {
    if (handle.builtConnectors.length > 0) {
      await disposeBuiltConnectors(handle.builtConnectors, (level, message, metadata) => {
        handle.setWorking((working) => appendLog(working, level, message, null, metadata));
        void handle.emit();
      });
    }
  }
}

export async function executeApply(input: ExecuteApplyInput): Promise<RunRecord> {
  const handle = await createPhaseHandle(
    input,
    {
      status: "running",
      summary: `${input.agent.name} is applying.`,
    },
    "Started apply phase.",
  );

  try {
    const module = await loadAgentModule(input.agent);
    if (module.mode !== "write" || typeof (module as WriteAgentModule).apply !== "function") {
      throw new Error(
        `Agent "${input.agent.slug}" is not a write agent.`,
      );
    }
    const outcome: AgentRunResult = await (module as WriteAgentModule).apply(
      handle.ctx,
      input.plan,
    );
    const finishedAt = new Date().toISOString();
    const completed = handle.setWorking((working) => ({
      ...working,
      status: "completed",
      finishedAt,
      summary: outcome.summary,
      liveSummary: undefined,
      result: outcome.result,
      logs: [
        ...working.logs,
        buildLog(working.id, "info", "Apply phase completed.", finishedAt),
      ],
    }));
    await handle.emit();
    return completed;
  } catch (error) {
    return failPhase(input, handle.getWorking(), error);
  } finally {
    if (handle.builtConnectors.length > 0) {
      await disposeBuiltConnectors(handle.builtConnectors, (level, message, metadata) => {
        handle.setWorking((working) => appendLog(working, level, message, null, metadata));
        void handle.emit();
      });
    }
  }
}

function validatePlan(plan: WritePlan, agentSlug: string): void {
  if (!plan || typeof plan.summary !== "string" || plan.summary.length === 0) {
    throw new Error(`Agent "${agentSlug}" returned a plan without a summary.`);
  }
  if (typeof plan.confirmationPhrase !== "string" || plan.confirmationPhrase.length === 0) {
    throw new Error(`Agent "${agentSlug}" returned a plan without a confirmation phrase.`);
  }
  if (!Array.isArray(plan.actions)) {
    throw new Error(`Agent "${agentSlug}" returned a plan without an actions array.`);
  }
  for (const action of plan.actions) {
    if (
      typeof action.id !== "string" ||
      typeof action.kind !== "string" ||
      typeof action.label !== "string"
    ) {
      throw new Error(
        `Agent "${agentSlug}" returned an action missing id/kind/label.`,
      );
    }
  }
}

/**
 * Read-only inspection of an agent's on-disk manifest, exposed to the
 * renderer for the Agent detail "preview" surface. Returns `undefined`
 * when no manifest.yaml can be found.
 */
export function loadAgentManifestPreview(
  agent: AgentSummary | RegistryAgentSummary,
): AgentManifestPreview | undefined {
  let agentDir: string;
  try {
    agentDir = resolveAgentDirectory(agent);
  } catch {
    return undefined;
  }

  const yamlPath = join(agentDir, "manifest.yaml");
  if (!existsSync(yamlPath)) {
    return undefined;
  }
  const sourceText = readFileSync(yamlPath, "utf8");
  let manifest;
  try {
    manifest = parseAgentTemplate(sourceText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent template at ${yamlPath} is invalid: ${message}`);
  }
  return {
    kind: "agent-template",
    ...(agent.registryPath ? { registryPath: agent.registryPath } : {}),
    manifest,
    sourceText,
  };
}

export async function loadAgentModule(
  agent: AgentSummary | RegistryAgentSummary,
): Promise<AgentModule> {
  const agentDir = resolveAgentDirectory(agent);
  const yamlPath = join(agentDir, "manifest.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(
      `Agent "${agent.slug}" has no manifest.yaml at ${agentDir}.`,
    );
  }
  const manifest = parseAgentTemplate(readFileSync(yamlPath, "utf8"));
  return agentTemplateToModule(manifest);
}

/**
 * Optional override directory for OTA-updated agent manifests. When set,
 * `resolveAgentDirectory` checks `<dir>/<slug>/manifest.yaml` before the
 * bundled tree, so an over-the-air update applied from the public registry
 * takes precedence over the manifest shipped with the app. Set once at
 * desktop startup via `setAgentUpdatesDir`. Defaults to undefined (no
 * override) so runtime tests and the CLI continue to read straight from
 * the bundled tree.
 */
let agentUpdatesDir: string | undefined;

export function setAgentUpdatesDir(dir: string | undefined): void {
  agentUpdatesDir = dir;
}

export function getAgentUpdatesDir(): string | undefined {
  return agentUpdatesDir;
}

/**
 * Compare two semver-ish strings of the form `MAJOR.MINOR.PATCH`.
 * Returns 1 if a > b, -1 if a < b, 0 if equal. Missing components default
 * to 0 (so "1.0" compares equal to "1.0.0"). Non-numeric segments are
 * treated as 0 — this is a forgiving comparator suitable for the update
 * detection path, not a full semver parser.
 */
export function compareSemver(a: string, b: string): number {
  const left = a.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const right = b.split(".").map((s) => Number.parseInt(s, 10) || 0);
  const len = Math.max(left.length, right.length, 3);
  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

function resolveAgentDirectory(agent: AgentSummary | RegistryAgentSummary): string {
  // 0. OTA-updated manifest (if any) overrides the bundled copy. User-
  //    authored agents with an absolute registryPath still take precedence
  //    over this — they're locally edited and shouldn't be silently
  //    replaced by an update.
  if (agentUpdatesDir && !(agent.registryPath && isAbsolutePath(agent.registryPath))) {
    const overrideDir = join(agentUpdatesDir, agent.slug);
    if (existsSync(overrideDir) && statSync(overrideDir).isDirectory()) {
      const overrideManifest = join(overrideDir, "manifest.yaml");
      if (existsSync(overrideManifest)) {
        return overrideDir;
      }
    }
  }

  // 1. Absolute registryPath wins (user-authored agents stamp their
  //    absolute path on save). This lets the same slug coexist between
  //    the bundled tree and the user dir without collision.
  if (agent.registryPath && isAbsolutePath(agent.registryPath)) {
    if (existsSync(agent.registryPath) && statSync(agent.registryPath).isDirectory()) {
      return agent.registryPath;
    }
  }

  // 2. Built-in tree: <repoRoot>/agents/<slug>.
  const agentsRoot = findAgentsRoot();
  const slugDir = join(agentsRoot, agent.slug);
  if (existsSync(slugDir) && statSync(slugDir).isDirectory()) {
    return slugDir;
  }

  // 3. Legacy relative registryPath ("agents/<slug>").
  if (agent.registryPath) {
    const fragments = agent.registryPath.split(/[\\/]/);
    const tailSegments = fragments[0] === builtInRegistryRoot ? fragments.slice(1) : fragments;
    const candidate = join(agentsRoot, ...tailSegments);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) {
      return candidate;
    }
  }

  throw new Error(`Unable to locate agent directory for "${agent.slug}".`);
}

function isAbsolutePath(value: string): boolean {
  // Cross-platform absolute-path heuristic. Avoids importing path.isAbsolute
  // to keep the module loadable in the renderer test harness.
  return /^[/\\]/.test(value) || /^[A-Za-z]:[/\\]/.test(value);
}

function findAgentsRoot(): string {
  for (const startPath of getSearchStartPaths()) {
    let currentPath = resolve(startPath);

    while (true) {
      const candidate = join(currentPath, builtInRegistryRoot);
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }

      const parentPath = dirname(currentPath);
      if (parentPath === currentPath) {
        break;
      }
      currentPath = parentPath;
    }
  }

  throw new Error("Unable to locate the root agents folder.");
}

function getSearchStartPaths(): string[] {
  const electronProcess = process as NodeJS.Process & {
    resourcesPath?: string;
  };
  const resourcesPath =
    typeof electronProcess.resourcesPath === "string"
      ? electronProcess.resourcesPath
      : undefined;

  return [
    process.cwd(),
    dirname(fileURLToPath(import.meta.url)),
    ...(resourcesPath ? [resourcesPath] : []),
  ];
}

function loadRegistrySummaryFromYaml(
  agentPath: string,
  options: { absoluteRegistryPath?: boolean } = {},
): RegistryAgentSummary {
  const yamlPath = join(agentPath, "manifest.yaml");
  let manifest;
  try {
    manifest = parseAgentTemplate(readFileSync(yamlPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Agent manifest at ${yamlPath} is invalid: ${message}`);
  }

  // User-authored agents (NL2Agent) sit outside the bundled `agents/`
  // tree, so a "agents/<slug>" relative path would be ambiguous or
  // outright wrong. For those we stamp the absolute path; the dir
  // resolver checks for it before falling back to the bundled root.
  const registryPath = options.absoluteRegistryPath
    ? agentPath
    : relativeRegistryPath(agentPath);

  return {
    ...agentTemplateToRegistrySummary(manifest),
    registryPath,
  };
}

function normalizeIsoDate(value: Date | string, fieldName: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  return parsed.toISOString();
}

function buildLog(
  runId: string,
  level: RunLogLevel,
  message: string,
  timestamp: string,
  stepId?: string,
  metadata?: Record<string, unknown>,
): RunLogRecord {
  const log: RunLogRecord = {
    id: `${runId}_${timestamp}_${Math.random().toString(36).slice(2, 8)}`,
    runId,
    timestamp,
    level,
    message,
  };
  if (stepId) {
    log.stepId = stepId;
  }
  if (metadata) {
    log.metadata = metadata;
  }
  return log;
}

function appendLog(
  run: RunRecord,
  level: RunLogLevel,
  message: string,
  stepId: string | null,
  metadata?: Record<string, unknown>,
): RunRecord {
  const now = new Date().toISOString();
  return {
    ...run,
    logs: [
      ...run.logs,
      buildLog(run.id, level, message, now, stepId ?? undefined, metadata),
    ],
  };
}

function relativeRegistryPath(agentPath: string): string {
  const agentsIndex = agentPath.split(/[\\/]/).lastIndexOf("agents");
  if (agentsIndex < 0) {
    return agentPath;
  }

  return agentPath.split(/[\\/]/).slice(agentsIndex).join("/");
}

function toAgentDefinition(agent: AgentSummary): RunContext["agent"] {
  // graphOperations is intentionally not threaded onto ctx.agent yet — runtime
  // instrumentation that cross-checks declared vs. actual ctx.graph calls is a
  // follow-up slice. Expose it here when that lands so agents can self-inspect.
  return {
    id: agent.id,
    registryId: agent.registryId,
    registryPath: agent.registryPath,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    mode: agent.mode,
    category: agent.category,
    tier: agent.tier ?? "agent",
    requiresEntraTier: agent.requiresEntraTier ?? "free",
    scopes: agent.scopes,
    author: agent.author,
    version: agent.version,
    preferredModel: agent.preferredModel,
  };
}
