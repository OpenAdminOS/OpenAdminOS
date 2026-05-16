import { load as parseYaml } from "js-yaml";

import type {
  AgentModule,
  AgentRunResult,
  GraphStep,
  LlmStep,
  ManagedDeviceRecord,
  ReadAgentModule,
  RunContext,
  AgentTemplate,
  TemplateStep,
  TransformStep,
  WriteAction,
  WriteAgentModule,
  WriteActionTemplate,
  WritePlan,
  WriteStep,
} from "@openagents/agent-sdk";

import { renderDeep, renderTemplate, type TemplateContext } from "./template-engine.js";

export class ManifestValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ManifestValidationError";
    this.path = path;
  }
}

/**
 * Parse an agent template from YAML (or JSON) text. Throws
 * ManifestValidationError on schema violations.
 */
export function parseAgentTemplate(source: string): AgentTemplate {
  const raw = parseYaml(source);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestValidationError("root", "manifest must be a YAML object");
  }
  const data = raw as Record<string, unknown>;

  const descriptor = requireObject(data, "descriptor");
  const skills = requireArray(data, "skills");
  const definition = requireObject(data, "definition");

  for (const field of ["id", "name", "description", "version", "category", "mode"] as const) {
    if (typeof descriptor[field] !== "string" || (descriptor[field] as string).length === 0) {
      throw new ManifestValidationError(`descriptor.${field}`, "must be a non-empty string");
    }
  }
  const mode = descriptor.mode;
  if (mode !== "read" && mode !== "write") {
    throw new ManifestValidationError(
      "descriptor.mode",
      `expected "read" or "write", got ${JSON.stringify(mode)}`,
    );
  }

  if (skills.length === 0) {
    throw new ManifestValidationError("skills", "must contain at least one skill");
  }

  const validated: TemplateStep[] = skills.map((skill, idx) => {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
      throw new ManifestValidationError(`skills[${idx}]`, "must be an object");
    }
    return validateSkill(skill as Record<string, unknown>, `skills[${idx}]`);
  });

  const writeSteps = validated.filter(
    (step): step is WriteStep => step.format === "write",
  );
  if (mode === "write" && writeSteps.length === 0) {
    throw new ManifestValidationError(
      "skills",
      'write-mode agents must declare at least one step with format: "write"',
    );
  }
  if (mode === "read" && writeSteps.length > 0) {
    throw new ManifestValidationError(
      "skills",
      'read-mode agents cannot declare a write step; set descriptor.mode to "write"',
    );
  }
  if (writeSteps.length > 1) {
    throw new ManifestValidationError(
      "skills",
      "v0.1 supports at most one write step per agent template",
    );
  }

  // Read agents must declare a result template; write agents don't (the
  // runtime emits a standardised result from the apply phase).
  if (mode === "read") {
    if (!definition.result || typeof definition.result !== "object") {
      throw new ManifestValidationError("definition.result", "must be an object for read agents");
    }
    const resultDef = definition.result as Record<string, unknown>;
    if (typeof resultDef.summary !== "string") {
      throw new ManifestValidationError("definition.result.summary", "must be a string");
    }
  }

  return {
    descriptor: descriptor as AgentTemplate["descriptor"],
    skills: validated,
    definition: definition as AgentTemplate["definition"],
  };
}

function requireObject(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = obj[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ManifestValidationError(key, "must be an object");
  }
  return value as Record<string, unknown>;
}

function requireArray(obj: Record<string, unknown>, key: string): unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new ManifestValidationError(key, "must be an array");
  }
  return value;
}

function validateSkill(skill: Record<string, unknown>, path: string): TemplateStep {
  for (const field of ["id", "format", "label"] as const) {
    if (typeof skill[field] !== "string" || (skill[field] as string).length === 0) {
      throw new ManifestValidationError(`${path}.${field}`, "must be a non-empty string");
    }
  }
  const settings = skill.settings;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ManifestValidationError(`${path}.settings`, "must be an object");
  }

  switch (skill.format) {
    case "graph":
      return skill as unknown as GraphStep;
    case "transform":
      return skill as unknown as TransformStep;
    case "llm":
      return skill as unknown as LlmStep;
    case "write":
      validateWriteStepSettings(settings as Record<string, unknown>, `${path}.settings`);
      return skill as unknown as WriteStep;
    default:
      throw new ManifestValidationError(
        `${path}.format`,
        `unknown format: ${JSON.stringify(skill.format)}`,
      );
  }
}

function validateWriteStepSettings(
  settings: Record<string, unknown>,
  path: string,
): void {
  if (typeof settings.kind !== "string" || settings.kind.length === 0) {
    throw new ManifestValidationError(`${path}.kind`, "must be a non-empty string");
  }
  if (!ACTION_HANDLERS[settings.kind]) {
    throw new ManifestValidationError(
      `${path}.kind`,
      `unknown action kind "${settings.kind}". Supported in v0.1: ${Object.keys(ACTION_HANDLERS).join(", ")}`,
    );
  }
  if (typeof settings.source !== "string" || settings.source.length === 0) {
    throw new ManifestValidationError(`${path}.source`, "must be a non-empty string");
  }
  if (typeof settings.confirmationPhrase !== "string" || settings.confirmationPhrase.length === 0) {
    throw new ManifestValidationError(`${path}.confirmationPhrase`, "must be a non-empty string");
  }
  if (!settings.actionTemplate || typeof settings.actionTemplate !== "object") {
    throw new ManifestValidationError(`${path}.actionTemplate`, "must be an object");
  }
  const tmpl = settings.actionTemplate as Record<string, unknown>;
  if (typeof tmpl.label !== "string" || tmpl.label.length === 0) {
    throw new ManifestValidationError(`${path}.actionTemplate.label`, "must be a non-empty string");
  }
}

// ─── Pipeline state shared by read + write paths ───────────────────────────

type PipelineState = Record<string, { output: unknown }>;

function resolveSettings(manifest: AgentTemplate): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const def of manifest.definition.settings ?? []) {
    if (def.default !== undefined) {
      settings[def.id] = def.default;
    }
  }
  return settings;
}

function makeTemplateCtx(
  manifest: AgentTemplate,
  settings: Record<string, unknown>,
  pipeline: PipelineState,
  ctx: RunContext,
): TemplateContext {
  return {
    settings,
    ctx: {
      providerId: ctx.providerId,
      model: ctx.model,
      agentId: ctx.agent.id,
    },
    descriptor: manifest.descriptor,
    ...pipeline,
  };
}

/**
 * Run pipeline steps until the optional `stopBefore` predicate matches.
 * Returns the pipeline state at the stop point. Each step is wrapped in
 * ctx.step so failures surface with step granularity.
 */
async function runPipelineUpTo(
  manifest: AgentTemplate,
  ctx: RunContext,
  stopBefore: (step: TemplateStep) => boolean = () => false,
): Promise<{ pipeline: PipelineState; settings: Record<string, unknown> }> {
  const settings = resolveSettings(manifest);
  const pipeline: PipelineState = {};

  for (const skill of manifest.skills) {
    if (stopBefore(skill)) break;
    const templateCtx = (): TemplateContext =>
      makeTemplateCtx(manifest, settings, pipeline, ctx);

    await ctx.step(skill.label, skill.detail, async () => {
      const output = await runSkill(skill, ctx, templateCtx);
      pipeline[skill.id] = { output };
    });
  }

  return { pipeline, settings };
}

// ─── Read-agent path ──────────────────────────────────────────────────────

/**
 * Execute a read-mode agent template against a live RunContext. Throws if
 * the manifest is write-mode (use runAgentTemplatePlan / Apply instead).
 */
export async function runAgentTemplate(
  manifest: AgentTemplate,
  ctx: RunContext,
): Promise<AgentRunResult> {
  if (manifest.descriptor.mode !== "read") {
    throw new Error(
      `runAgentTemplate: manifest "${manifest.descriptor.id}" is a write agent; call runAgentTemplatePlan/Apply.`,
    );
  }

  const { pipeline, settings } = await runPipelineUpTo(manifest, ctx);
  const finalCtx = makeTemplateCtx(manifest, settings, pipeline, ctx);

  const resultDef = manifest.definition.result;
  if (!resultDef) {
    throw new Error(
      `runAgentTemplate: manifest "${manifest.descriptor.id}" is missing definition.result.`,
    );
  }

  const summary = String(renderTemplate(resultDef.summary, finalCtx) ?? "");
  const dataRaw = resultDef.data ? renderDeep(resultDef.data, finalCtx) : undefined;

  return {
    summary: summary.trim(),
    ...(dataRaw !== undefined ? { result: dataRaw } : {}),
  };
}

// ─── Write-agent path: plan + apply ───────────────────────────────────────

/**
 * Run the pipeline up to (and including) the single write step, render the
 * action template once per source item, and return a WritePlan. The runtime
 * stamps the plan on the RunRecord and pauses for typed confirmation.
 */
export async function runAgentTemplatePlan(
  manifest: AgentTemplate,
  ctx: RunContext,
): Promise<WritePlan> {
  if (manifest.descriptor.mode !== "write") {
    throw new Error(
      `runAgentTemplatePlan: manifest "${manifest.descriptor.id}" is not a write agent.`,
    );
  }

  const writeStepIdx = manifest.skills.findIndex((s) => s.format === "write");
  if (writeStepIdx < 0) {
    throw new Error(
      `runAgentTemplatePlan: manifest "${manifest.descriptor.id}" has no write step.`,
    );
  }
  const writeStep = manifest.skills[writeStepIdx] as WriteStep;

  // Run every step before the write step so its `source` expression has
  // something to resolve against.
  const { pipeline, settings } = await runPipelineUpTo(
    manifest,
    ctx,
    (step) => step === writeStep,
  );

  // Now build the plan inside its own ctx.step so the user sees a step
  // labelled with the write step's label (matching the find-inactive path).
  return ctx.step(writeStep.label, writeStep.detail, async () => {
    const settingsCtx = makeTemplateCtx(manifest, settings, pipeline, ctx);
    const sourceArray = renderTemplate(writeStep.settings.source, settingsCtx);
    if (!Array.isArray(sourceArray)) {
      throw new Error(
        `write step "${writeStep.id}": source must resolve to an array (got ${typeof sourceArray}).`,
      );
    }

    const actions: WriteAction[] = sourceArray.map((item, index) => {
      const perItemCtx: TemplateContext = {
        ...settingsCtx,
        item,
        items: sourceArray,
        index,
      };
      return renderActionFromTemplate(
        writeStep.settings.actionTemplate,
        writeStep.settings.kind,
        index,
        perItemCtx,
      );
    });

    // Confirmation phrase + plan summary template see the full action set.
    const planCtx: TemplateContext = {
      ...settingsCtx,
      items: sourceArray,
      actions,
    };
    const confirmationPhrase = String(
      renderTemplate(writeStep.settings.confirmationPhrase, planCtx) ?? "",
    );
    const summary = writeStep.settings.summary
      ? String(renderTemplate(writeStep.settings.summary, planCtx) ?? "")
      : `${manifest.descriptor.name} prepared ${actions.length} action${actions.length === 1 ? "" : "s"}.`;

    ctx.log(
      "info",
      `Plan ready: ${actions.length} action${actions.length === 1 ? "" : "s"} of kind "${writeStep.settings.kind}".`,
    );

    return {
      summary,
      confirmationPhrase,
      actions,
    };
  });
}

function renderActionFromTemplate(
  template: WriteActionTemplate,
  kind: string,
  index: number,
  templateCtx: TemplateContext,
): WriteAction {
  const label = String(renderTemplate(template.label, templateCtx) ?? "");
  const action: WriteAction = {
    id: `${kind}:${index}`,
    kind,
    label,
    severity: template.severity ?? "destructive",
  };
  if (template.description) {
    const description = String(renderTemplate(template.description, templateCtx) ?? "");
    if (description.length > 0) action.description = description;
  }
  if (template.metadata) {
    const rendered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(template.metadata)) {
      rendered[key] = renderTemplate(value, templateCtx);
    }
    action.metadata = rendered;
  }
  return action;
}

/**
 * Iterate the approved plan's actions. Each action is dispatched to its
 * registered kind handler. Per-action failures are non-fatal: they land in
 * `result.failed[]` and the run still completes. The handler chooses
 * whether to call real Graph (when ctx.realWrites) or emit a simulated
 * step.
 */
export async function runAgentTemplateApply(
  manifest: AgentTemplate,
  ctx: RunContext,
  plan: WritePlan,
): Promise<AgentRunResult> {
  if (manifest.descriptor.mode !== "write") {
    throw new Error(
      `runAgentTemplateApply: manifest "${manifest.descriptor.id}" is not a write agent.`,
    );
  }

  const realWrites = ctx.realWrites;
  const retiredDeviceIds: string[] = [];
  const simulatedDeviceIds: string[] = [];
  const failed: Array<{ id: string; name: string; error: string }> = [];

  if (!realWrites) {
    ctx.log(
      "warn",
      "Real Graph writes are disabled (no tenant connected or the toggle in Settings is OFF). The apply phase will emit a simulated trace instead of calling Microsoft Graph.",
    );
  }

  for (const action of plan.actions) {
    const handler = ACTION_HANDLERS[action.kind];
    if (!handler) {
      failed.push({
        id: action.id,
        name: action.label,
        error: `No handler registered for action kind "${action.kind}".`,
      });
      ctx.log("error", `Skipping ${action.label}: unknown action kind ${action.kind}.`);
      continue;
    }

    try {
      await ctx.step(action.label, action.description, async () => {
        const result = await handler(action, ctx);
        if (result.outcome === "real") {
          if (result.targetId) retiredDeviceIds.push(result.targetId);
          ctx.log("info", `Executed ${action.label} via Graph.`);
        } else {
          if (result.targetId) simulatedDeviceIds.push(result.targetId);
          ctx.log("info", `[simulated] ${action.label}; real writes disabled.`);
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ id: action.id, name: action.label, error: message });
      ctx.log("error", `Failed action "${action.label}": ${message}`);
    }
  }

  const successCount = realWrites ? retiredDeviceIds.length : simulatedDeviceIds.length;
  const total = plan.actions.length;
  const verb = realWrites ? "Executed" : "Simulated";
  const failureSuffix = failed.length > 0 ? ` ${failed.length} failed.` : "";
  const summary = `${verb} ${successCount} of ${total} action${total === 1 ? "" : "s"}.${failureSuffix}`;

  return {
    summary,
    result: {
      mode: realWrites ? "real" : "simulated",
      retiredDeviceIds,
      simulatedDeviceIds,
      failed,
      successCount,
      failureCount: failed.length,
      total,
    },
  };
}

// ─── Action-kind handler registry ─────────────────────────────────────────

interface ActionHandlerResult {
  outcome: "real" | "simulated";
  targetId?: string;
}

type ActionHandler = (action: WriteAction, ctx: RunContext) => Promise<ActionHandlerResult>;

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  "retire-managed-device": async (action, ctx) => {
    const deviceId =
      typeof action.metadata?.deviceId === "string" ? action.metadata.deviceId : undefined;
    if (!deviceId) {
      throw new Error(
        `retire-managed-device: action "${action.id}" is missing metadata.deviceId`,
      );
    }
    if (ctx.realWrites) {
      await ctx.graph.retireManagedDevice(deviceId);
      return { outcome: "real", targetId: deviceId };
    }
    return { outcome: "simulated", targetId: deviceId };
  },
};

// ─── Skill runners ────────────────────────────────────────────────────────

async function runSkill(
  skill: TemplateStep,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  switch (skill.format) {
    case "graph":
      return runGraphSkill(skill, ctx, templateCtx);
    case "transform":
      return runTransformSkill(skill, ctx, templateCtx);
    case "llm":
      return runLlmSkill(skill, ctx, templateCtx);
    case "write":
      // Write steps are executed by runAgentTemplatePlan, not here.
      throw new Error(
        `runSkill: encountered a write step ("${skill.id}") during the pipeline loop; this is a bug.`,
      );
    default: {
      const exhaustive: never = skill;
      throw new Error(`Unsupported skill format: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function runGraphSkill(
  skill: GraphStep,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  const settings = renderDeep(skill.settings, templateCtx());

  if (settings.method !== "GET") {
    throw new Error(
      `graph step "${skill.id}": only GET is supported by the agent template interpreter (got ${settings.method}).`,
    );
  }

  if (settings.path === "/deviceManagement/managedDevices") {
    const devices = await ctx.graph.listManagedDevices();
    ctx.log("info", `Loaded ${devices.length} managed devices.`);
    return devices as ManagedDeviceRecord[];
  }

  throw new Error(
    `graph step "${skill.id}": path "${settings.path}" is not yet supported by the agent template interpreter. Use a code-based agent or extend RunGraphApi.`,
  );
}

async function runTransformSkill(
  skill: TransformStep,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  const settings = renderDeep(skill.settings, templateCtx()) as Record<string, unknown>;
  const kind = settings.kind;

  switch (kind) {
    case "group-by-age":
      return transformGroupByAge(skill.id, settings, ctx);
    case "filter-by-age":
      return transformFilterByAge(skill.id, settings, ctx);
    default:
      throw new Error(
        `transform "${skill.id}": unknown kind "${String(kind)}". Supported: group-by-age, filter-by-age.`,
      );
  }
}

interface GroupByAgeSpec {
  source: unknown;
  timestampField: string;
  groups: Array<{ name: string; inactiveDaysAtLeast: number }>;
}

function transformGroupByAge(
  skillId: string,
  settings: Record<string, unknown>,
  ctx: RunContext,
): Record<string, unknown[]> {
  const spec = settings as unknown as GroupByAgeSpec;
  if (!Array.isArray(spec.source)) {
    throw new Error(`transform "${skillId}": group-by-age expects "source" to resolve to an array.`);
  }
  if (typeof spec.timestampField !== "string" || spec.timestampField.length === 0) {
    throw new Error(`transform "${skillId}": group-by-age requires "timestampField".`);
  }
  if (!Array.isArray(spec.groups) || spec.groups.length === 0) {
    throw new Error(`transform "${skillId}": group-by-age requires at least one group.`);
  }

  const now = Date.now();
  const msPerDay = 86_400_000;
  const ordered = [...spec.groups].sort(
    (a, b) => b.inactiveDaysAtLeast - a.inactiveDaysAtLeast,
  );

  const result: Record<string, unknown[]> = {};
  for (const group of spec.groups) {
    result[group.name] = [];
  }

  for (const item of spec.source as Array<Record<string, unknown>>) {
    const raw = item[spec.timestampField];
    if (typeof raw !== "string") continue;
    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) continue;
    const days = Math.floor((now - ms) / msPerDay);

    for (const group of ordered) {
      if (days >= group.inactiveDaysAtLeast) {
        result[group.name]!.push(item);
        break;
      }
    }
  }

  const counts = Object.entries(result)
    .map(([name, items]) => `${name}=${items.length}`)
    .join(", ");
  ctx.log("info", `Grouped by inactivity: ${counts}.`);
  return result;
}

interface FilterByAgeSpec {
  source: unknown;
  timestampField: string;
  inactiveDaysAtLeast: number;
}

function transformFilterByAge(
  skillId: string,
  settings: Record<string, unknown>,
  ctx: RunContext,
): unknown[] {
  const spec = settings as unknown as FilterByAgeSpec;
  if (!Array.isArray(spec.source)) {
    throw new Error(`transform "${skillId}": filter-by-age expects "source" to resolve to an array.`);
  }
  if (typeof spec.timestampField !== "string" || spec.timestampField.length === 0) {
    throw new Error(`transform "${skillId}": filter-by-age requires "timestampField".`);
  }
  const threshold = Number(spec.inactiveDaysAtLeast);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(
      `transform "${skillId}": filter-by-age requires "inactiveDaysAtLeast" as a non-negative number.`,
    );
  }

  const now = Date.now();
  const msPerDay = 86_400_000;
  const matched: unknown[] = [];

  for (const item of spec.source as Array<Record<string, unknown>>) {
    const raw = item[spec.timestampField];
    if (typeof raw !== "string") continue;
    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) continue;
    const days = Math.floor((now - ms) / msPerDay);
    if (days >= threshold) matched.push(item);
  }

  ctx.log("info", `Filter-by-age >= ${threshold}d kept ${matched.length} of ${(spec.source as unknown[]).length}.`);
  return matched;
}

async function runLlmSkill(
  skill: LlmStep,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  if (skill.when === "ctx.llm.available" && !ctx.llm.available) {
    ctx.log("info", `Skipped "${skill.label}": ctx.llm is unavailable.`);
    return undefined;
  }

  const settings = renderDeep(skill.settings, templateCtx());

  const completion = await ctx.llm.complete({
    prompt: settings.prompt,
    ...(settings.system ? { system: settings.system } : {}),
    ...(typeof settings.temperature === "number" ? { temperature: settings.temperature } : {}),
    ...(typeof settings.maxTokens === "number" ? { maxTokens: settings.maxTokens } : {}),
  });

  ctx.log("info", `LLM step "${skill.label}" used model ${completion.model}.`);
  return {
    text: completion.text.trim(),
    model: completion.model,
  };
}

// ─── Adapter so the runtime can treat a manifest as an AgentModule ───────

export function agentTemplateToModule(manifest: AgentTemplate): AgentModule {
  if (manifest.descriptor.mode === "write") {
    return buildWriteAgentModule(manifest);
  }
  return buildReadAgentModule(manifest);
}

function commonMetadata(manifest: AgentTemplate) {
  const descriptor = manifest.descriptor;
  return {
    id: descriptor.id,
    slug: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    category: descriptor.category,
    scopes: collectScopes(manifest),
    author: descriptor.author,
    version: descriptor.version,
    ...(descriptor.preferredModel ? { preferredModel: descriptor.preferredModel } : {}),
  };
}

function buildReadAgentModule(manifest: AgentTemplate): ReadAgentModule {
  return {
    ...commonMetadata(manifest),
    mode: "read",
    run: (ctx) => runAgentTemplate(manifest, ctx),
  } as ReadAgentModule;
}

function buildWriteAgentModule(manifest: AgentTemplate): WriteAgentModule {
  return {
    ...commonMetadata(manifest),
    mode: "write",
    plan: (ctx) => runAgentTemplatePlan(manifest, ctx),
    apply: (ctx, plan) => runAgentTemplateApply(manifest, ctx, plan),
  } as WriteAgentModule;
}

function collectScopes(manifest: AgentTemplate): string[] {
  const scopes = new Set<string>();
  for (const skill of manifest.skills) {
    if (skill.format === "graph") {
      for (const scope of skill.settings.scopes ?? []) {
        scopes.add(scope);
      }
    } else if (skill.format === "write") {
      for (const scope of skill.settings.scopes ?? []) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes];
}
