import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AgentManifestPreview,
  AgentModule,
  AgentRunResult,
  AgentSummary,
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
  WriteAgentModule,
  WritePlan,
} from "@openagents/agent-sdk";

import { createSyntheticGraph } from "./graph-fixtures.js";
import { createOllamaLlm, noopLlm } from "./llm-ollama.js";
import {
  parseAgentTemplate,
  agentTemplateToModule,
  agentTemplateToRegistrySummary,
} from "./agent-template.js";

export { createOllamaLlm, noopLlm } from "./llm-ollama.js";
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
  GRAPH_CLI_CLIENT_ID,
  removeAccount,
  runInteractiveFlow,
  type TokenCacheStorage,
} from "./msal.js";
export { createGraphAdapter, type GraphAdapterOptions } from "./graph-adapter.js";
export { createSyntheticGraph } from "./graph-fixtures.js";

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
    scopes: agent.scopes,
    author: agent.author,
    version: agent.version,
    preferredModel: agent.preferredModel,
    registryId: agent.registryId,
    registryPath: agent.registryPath,
    graphOperations: agent.graphOperations,
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

export interface ExecuteRunInput {
  run: RunRecord;
  agent: AgentSummary;
  providerId: ProviderId;
  model?: string;
  llm?: RunLlmApi;
  graph?: RunGraphApi;
  /**
   * Whether the agent is allowed to call destructive Graph methods
   * during this run. The host sets `true` whenever the run is bound to
   * a real tenant (i.e. `dataSource === "graph"`); the per-write typed
   * diff confirmation is the user-facing gate. Defaults to `false` so
   * unconfigured callers cannot accidentally perform real writes.
   */
  realWrites?: boolean;
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
    accumulateTokens: (usage) => {
      working = { ...working, tokens: mergeTokenUsage(working.tokens, usage) };
      void input.onProgress(working);
    },
  });

  const ctx: RunContext = {
    agent: toAgentDefinition(input.agent),
    providerId: input.providerId,
    model: input.model,
    graph: input.graph ?? createSyntheticGraph(),
    llm,
    realWrites: input.realWrites ?? false,
    settings: input.agent.settings,
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
  };
}

interface ThinkingHooks {
  getCurrentStepId(): string | null;
  updateStepThinking(
    stepId: string,
    update: (current: RunStepThinking | undefined) => RunStepThinking | undefined,
  ): void;
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
    const awaiting = handle.setWorking((working) => ({
      ...working,
      status: "awaiting-confirmation",
      summary: plan.summary,
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
  }
}

function validatePlan(plan: WritePlan, agentSlug: string): void {
  if (!plan || typeof plan.summary !== "string" || plan.summary.length === 0) {
    throw new Error(`Agent "${agentSlug}" returned a plan without a summary.`);
  }
  if (typeof plan.confirmationPhrase !== "string" || plan.confirmationPhrase.length === 0) {
    throw new Error(`Agent "${agentSlug}" returned a plan without a confirmation phrase.`);
  }
  if (!Array.isArray(plan.actions) || plan.actions.length === 0) {
    throw new Error(`Agent "${agentSlug}" returned a plan with no actions.`);
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

function resolveAgentDirectory(agent: AgentSummary | RegistryAgentSummary): string {
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
    scopes: agent.scopes,
    author: agent.author,
    version: agent.version,
    preferredModel: agent.preferredModel,
  };
}

