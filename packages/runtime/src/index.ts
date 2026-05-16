import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import type {
  AgentAuthor,
  AgentCategory,
  AgentManifestPreview,
  AgentMode,
  AgentModule,
  AgentRunResult,
  AgentSummary,
  GraphHttpMethod,
  GraphOperation,
  LlmStreamChunk,
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

type JsonObject = Record<string, unknown>;

const builtInRegistryRoot = "agents";

export function listBuiltInRegistryAgents(): RegistryAgentSummary[] {
  const agentsRoot = findAgentsRoot();

  return readdirSync(agentsRoot)
    .map((entryName) => join(agentsRoot, entryName))
    .filter((entryPath) => statSync(entryPath).isDirectory())
    .map((agentPath) => loadManifest(join(agentPath, "manifest.json"), agentPath))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function findRegistryAgentById(
  id: string,
): RegistryAgentSummary | undefined {
  return listBuiltInRegistryAgents().find(
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
   * during this run. The host computes this from
   * `tenant !== null && realWritesEnabled === true`. Defaults to
   * `false` so unconfigured callers cannot accidentally perform real
   * writes.
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
  });

  const ctx: RunContext = {
    agent: toAgentDefinition(input.agent),
    providerId: input.providerId,
    model: input.model,
    graph: input.graph ?? createSyntheticGraph(),
    llm,
    realWrites: input.realWrites ?? false,
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
      return { text: last.accumulated, model: last.model };
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
 * when neither a manifest.yaml nor a compiled code module can be found.
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
  if (existsSync(yamlPath)) {
    const sourceText = readFileSync(yamlPath, "utf8");
    let manifest;
    try {
      manifest = parseAgentTemplate(sourceText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Agent template at ${yamlPath} is invalid: ${message}`,
      );
    }
    return {
      kind: "agent-template",
      ...(agent.registryPath ? { registryPath: agent.registryPath } : {}),
      manifest,
      sourceText,
    };
  }

  // Code-based fallback: show metadata from manifest.json + a pointer to the
  // source location so curious users can inspect the code in GitHub.
  const jsonPath = join(agentDir, "manifest.json");
  if (existsSync(jsonPath)) {
    const sourceText = readFileSync(jsonPath, "utf8");
    const metadata = loadManifest(jsonPath, agentDir);
    return {
      kind: "code-based",
      ...(agent.registryPath ? { registryPath: agent.registryPath } : {}),
      metadata,
      sourceText,
      sourceLocation: agent.registryPath ?? agentDir,
    };
  }

  return undefined;
}

export async function loadAgentModule(
  agent: AgentSummary | RegistryAgentSummary,
): Promise<AgentModule> {
  const agentDir = resolveAgentDirectory(agent);

  // Agent Template path: declarative YAML manifest. Preferred over a legacy code-based
  // module when present, so an agent can ship just a manifest.yaml and a
  // manifest.json (metadata) without any TypeScript source.
  const yamlPath = join(agentDir, "manifest.yaml");
  if (existsSync(yamlPath)) {
    const yamlSource = readFileSync(yamlPath, "utf8");
    const manifest = parseAgentTemplate(yamlSource);
    return agentTemplateToModule(manifest);
  }

  // Code-based agent: a compiled TypeScript / JavaScript module that
  // default-exports an AgentModule. Used when an agent needs logic the
  // template DSL can't express; the escape hatch.
  const candidates = [
    join(agentDir, "dist", "agent.js"),
    join(agentDir, "dist", "agent.mjs"),
  ];

  const entryPath = candidates.find((candidate) => existsSync(candidate));
  if (!entryPath) {
    throw new Error(
      `Agent "${agent.slug}" has no manifest.yaml and no compiled entry. Expected one of: manifest.yaml, ${candidates.join(", ")}.`,
    );
  }

  const moduleUrl = pathToFileURL(entryPath).href;
  const loaded = (await import(moduleUrl)) as { default?: AgentModule };
  const candidate = loaded.default;
  if (!candidate || typeof candidate !== "object" || candidate === null) {
    throw new Error(
      `Agent "${agent.slug}" module at ${entryPath} did not default-export an agent.`,
    );
  }

  const mode = (candidate as { mode?: string }).mode;
  if (mode === "read" && typeof (candidate as ReadAgentModule).run === "function") {
    return candidate;
  }
  if (
    mode === "write" &&
    typeof (candidate as WriteAgentModule).plan === "function" &&
    typeof (candidate as WriteAgentModule).apply === "function"
  ) {
    return candidate;
  }

  throw new Error(
    `Agent "${agent.slug}" module at ${entryPath} did not export a valid read or write agent.`,
  );
}

function resolveAgentDirectory(agent: AgentSummary | RegistryAgentSummary): string {
  const agentsRoot = findAgentsRoot();
  const slugDir = join(agentsRoot, agent.slug);
  if (existsSync(slugDir) && statSync(slugDir).isDirectory()) {
    return slugDir;
  }

  // Fall back to a registry path that may be relative ("agents/<slug>") or already absolute.
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

function loadManifest(
  manifestPath: string,
  agentPath: string,
): RegistryAgentSummary {
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing built-in agent manifest: ${manifestPath}`);
  }

  const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
  if (!isJsonObject(parsed)) {
    throw new Error(`Built-in agent manifest must be an object: ${manifestPath}`);
  }

  validateManifest(parsed, manifestPath);

  return {
    id: parsed.id,
    registryId: parsed.id,
    registryPath: relativeRegistryPath(agentPath),
    slug: parsed.slug,
    name: parsed.name,
    description: parsed.description,
    mode: parsed.mode,
    category: parsed.category,
    scopes: parsed.scopes,
    author: parsed.author,
    version: parsed.version,
    preferredModel:
      typeof parsed.preferredModel === "string" ? parsed.preferredModel : undefined,
    installs: typeof parsed.installs === "number" ? parsed.installs : undefined,
    rating: typeof parsed.rating === "number" ? parsed.rating : undefined,
    graphOperations: parsed.graphOperations,
  };
}

function validateManifest(
  manifest: JsonObject,
  manifestPath: string,
): asserts manifest is {
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
  installs?: number;
  rating?: number;
  graphOperations?: GraphOperation[];
} {
  requireString(manifest, "id", manifestPath);
  requireString(manifest, "slug", manifestPath);
  requireString(manifest, "name", manifestPath);
  requireString(manifest, "description", manifestPath);
  requireString(manifest, "version", manifestPath);
  requireStringArray(manifest, "scopes", manifestPath);

  if (manifest.mode !== "read" && manifest.mode !== "write") {
    throw new Error(`Invalid mode in ${manifestPath}: ${String(manifest.mode)}`);
  }

  if (!isAgentCategory(manifest.category)) {
    throw new Error(
      `Invalid category in ${manifestPath}: ${String(manifest.category)}`,
    );
  }

  if (!isJsonObject(manifest.author)) {
    throw new Error(`Missing author object in ${manifestPath}`);
  }

  requireString(manifest.author, "name", manifestPath);

  if (manifest.graphOperations !== undefined) {
    validateGraphOperations(manifest.graphOperations, manifestPath);
  }
}

function validateGraphOperations(
  value: unknown,
  manifestPath: string,
): asserts value is GraphOperation[] {
  if (!Array.isArray(value)) {
    throw new Error(`graphOperations in ${manifestPath} must be an array.`);
  }
  for (const entry of value) {
    if (!isJsonObject(entry)) {
      throw new Error(`graphOperations in ${manifestPath} must contain objects.`);
    }
    if (!isGraphMethod(entry.method)) {
      throw new Error(
        `graphOperations in ${manifestPath} has invalid method: ${String(entry.method)}`,
      );
    }
    if (typeof entry.path !== "string" || entry.path.length === 0) {
      throw new Error(`graphOperations in ${manifestPath} has missing path.`);
    }
    if (entry.select !== undefined) {
      if (!Array.isArray(entry.select) || entry.select.some((item) => typeof item !== "string")) {
        throw new Error(
          `graphOperations in ${manifestPath} has invalid select array.`,
        );
      }
    }
    if (entry.notes !== undefined && typeof entry.notes !== "string") {
      throw new Error(`graphOperations in ${manifestPath} has invalid notes.`);
    }
  }
}

function isGraphMethod(value: unknown): value is GraphHttpMethod {
  return (
    value === "GET" ||
    value === "POST" ||
    value === "PATCH" ||
    value === "PUT" ||
    value === "DELETE"
  );
}

function isAgentCategory(value: unknown): value is AgentCategory {
  return (
    value === "devices" ||
    value === "apps" ||
    value === "policies" ||
    value === "compliance" ||
    value === "updates"
  );
}

function requireString(
  object: JsonObject,
  key: string,
  manifestPath: string,
): void {
  if (typeof object[key] !== "string" || object[key].length === 0) {
    throw new Error(`Missing ${key} string in ${manifestPath}`);
  }
}

function requireStringArray(
  object: JsonObject,
  key: string,
  manifestPath: string,
): void {
  const value = object[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Missing ${key} string array in ${manifestPath}`);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

