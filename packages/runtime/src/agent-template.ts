import { load as parseYaml } from "js-yaml";

import type {
  AgentAuthor,
  AgentCategory,
  AgentConnectorRequirement,
  AgentMode,
  AgentModule,
  AgentTier,
  RequiredEntraTier,
  AgentRunResult,
  GraphOperation,
  GraphStep,
  LlmStep,
  ManagedDeviceRecord,
  MapStep,
  ReadAgentModule,
  RunContext,
  AgentTemplate,
  ConnectorStep,
  TemplateStep,
  TransformStep,
  WriteAction,
  WriteAgentModule,
  WriteActionTemplate,
  WritePlan,
  WriteStep,
} from "@openadminos/agent-sdk";

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

  if (descriptor.tier !== undefined) {
    if (descriptor.tier !== "agent" && descriptor.tier !== "dashboard") {
      throw new ManifestValidationError(
        "descriptor.tier",
        `expected "agent" or "dashboard", got ${JSON.stringify(descriptor.tier)}`,
      );
    }
  }

  if (descriptor.requiresEntraTier !== undefined) {
    const t = descriptor.requiresEntraTier;
    if (t !== "free" && t !== "p1" && t !== "p2") {
      throw new ManifestValidationError(
        "descriptor.requiresEntraTier",
        `expected "free", "p1", or "p2", got ${JSON.stringify(t)}`,
      );
    }
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
    case "map":
      validateMapStepSettings(settings as Record<string, unknown>, `${path}.settings`);
      return skill as unknown as MapStep;
    case "write":
      validateWriteStepSettings(settings as Record<string, unknown>, `${path}.settings`);
      return skill as unknown as WriteStep;
    case "connector":
      validateConnectorStepSettings(settings as Record<string, unknown>, `${path}.settings`);
      return skill as unknown as ConnectorStep;
    default:
      throw new ManifestValidationError(
        `${path}.format`,
        `unknown format: ${JSON.stringify(skill.format)}`,
      );
  }
}

function validateMapStepSettings(
  settings: Record<string, unknown>,
  path: string,
): void {
  if (typeof settings.source !== "string" || settings.source.length === 0) {
    throw new ManifestValidationError(`${path}.source`, "must be a non-empty string");
  }
  if (typeof settings.as !== "string" || !/^[a-z][a-z0-9_]*$/.test(settings.as)) {
    throw new ManifestValidationError(`${path}.as`, "must be a lowercase identifier (e.g. 'row')");
  }
  if (!Array.isArray(settings.do) || settings.do.length === 0) {
    throw new ManifestValidationError(`${path}.do`, "must be a non-empty array of skills");
  }
  for (const [i, sub] of (settings.do as unknown[]).entries()) {
    if (!sub || typeof sub !== "object" || Array.isArray(sub)) {
      throw new ManifestValidationError(`${path}.do[${i}]`, "must be a skill object");
    }
    validateSkill(sub as Record<string, unknown>, `${path}.do[${i}]`);
  }
  if (settings.limit !== undefined) {
    if (typeof settings.limit !== "number" || settings.limit < 1 || !Number.isInteger(settings.limit)) {
      throw new ManifestValidationError(`${path}.limit`, "must be a positive integer");
    }
  }
}

function validateConnectorStepSettings(
  settings: Record<string, unknown>,
  path: string,
): void {
  if (typeof settings.connector !== "string" || settings.connector.length === 0) {
    throw new ManifestValidationError(`${path}.connector`, "must be a non-empty string");
  }
  if (typeof settings.capability !== "string" || settings.capability.length === 0) {
    throw new ManifestValidationError(`${path}.capability`, "must be a non-empty string");
  }
  if (!settings.args || typeof settings.args !== "object" || Array.isArray(settings.args)) {
    throw new ManifestValidationError(`${path}.args`, "must be an object");
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

  // graph-write requires a Graph request template. Other kinds (e.g.
  // the legacy retire-managed-device) have their own contract and
  // their handler reads from metadata directly.
  if (settings.kind === "graph-write") {
    if (!tmpl.request || typeof tmpl.request !== "object") {
      throw new ManifestValidationError(
        `${path}.actionTemplate.request`,
        'graph-write requires `request: { method, path, body? }`',
      );
    }
    const req = tmpl.request as Record<string, unknown>;
    const method = req.method;
    if (
      method !== "POST" &&
      method !== "PATCH" &&
      method !== "PUT" &&
      method !== "DELETE"
    ) {
      throw new ManifestValidationError(
        `${path}.actionTemplate.request.method`,
        'must be one of "POST", "PATCH", "PUT", "DELETE"',
      );
    }
    if (typeof req.path !== "string" || !req.path.startsWith("/")) {
      throw new ManifestValidationError(
        `${path}.actionTemplate.request.path`,
        'must be a Graph path starting with "/"',
      );
    }
  }
}

// ─── Pipeline state shared by read + write paths ───────────────────────────

type PipelineState = Record<string, { output: unknown }>;

/**
 * Build the settings map the templating engine sees during a run. Starts
 * from each declared setting's `default` and layers `overrides` on top
 * — typically `ctx.settings`, the host's persisted install-time map.
 * Unknown keys in `overrides` are ignored so a stale persisted value
 * (e.g. a setting renamed in a newer manifest version) never leaks
 * through.
 */
function resolveSettings(
  manifest: AgentTemplate,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const def of manifest.definition.settings ?? []) {
    if (def.default !== undefined) {
      settings[def.id] = def.default;
    }
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, def.id)) {
      const value = overrides[def.id];
      if (value !== undefined) {
        settings[def.id] = value;
      }
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
  const settings = resolveSettings(manifest, ctx.settings);
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
  if (template.request) {
    // Render the request template against the per-item context so the
    // plan carries a concrete `{ method, path, body? }` for each
    // action. `renderDeep` walks the body recursively so nested
    // string leaves are templated; non-string leaves pass through.
    const renderedPath = String(
      renderTemplate(template.request.path, templateCtx) ?? "",
    );
    action.request = {
      method: template.request.method,
      path: renderedPath,
    };
    if (template.request.body !== undefined) {
      action.request.body = renderDeep(template.request.body, templateCtx);
    }
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
  "graph-write": async (action, ctx) => {
    const request = action.request;
    if (!request) {
      throw new Error(
        `graph-write: action "${action.id}" is missing its rendered request.`,
      );
    }
    // The targetId is whatever identifies the affected resource in the
    // run report. For graph-write we use the rendered path — it's the
    // most honest signal admins can audit against.
    const targetId = request.path;
    if (ctx.realWrites) {
      await ctx.graph.request({
        method: request.method,
        path: request.path,
        body: request.body,
      });
      return { outcome: "real", targetId };
    }
    return { outcome: "simulated", targetId };
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
    case "map":
      return runMapSkill(skill, ctx, templateCtx);
    case "connector":
      return runConnectorSkill(skill, ctx, templateCtx);
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

/**
 * Iterate the resolved `source` array. For each item, run the inner
 * pipeline in a fresh child pipeline state seeded from the outer
 * template context plus the item binding. Collect each iteration's
 * final-step output into this map step's own output array. When `limit`
 * is set, items beyond the cap are skipped silently — the per-row
 * outputs array length and any consumer's `size` filter both reflect
 * the actual processed count.
 */
async function runMapSkill(
  skill: MapStep,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown[]> {
  const source = renderTemplate(skill.settings.source, templateCtx());
  if (!Array.isArray(source)) {
    throw new Error(
      `map step "${skill.id}": settings.source did not resolve to an array (got ${typeof source}).`,
    );
  }
  const limit = skill.settings.limit;
  const items = typeof limit === "number" ? source.slice(0, limit) : source;
  const as = skill.settings.as;
  const results: unknown[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const childPipeline: PipelineState = {};
    const childTemplateCtx = (): TemplateContext => ({
      ...templateCtx(),
      [as]: item,
      ...childPipeline,
    });
    let lastOutput: unknown = undefined;
    for (const sub of skill.settings.do) {
      const out = await runSkill(sub, ctx, childTemplateCtx);
      childPipeline[sub.id] = { output: out };
      lastOutput = out;
    }
    results.push(lastOutput);
  }

  if (typeof limit === "number" && source.length > limit) {
    ctx.log(
      "info",
      `map step "${skill.id}" processed ${limit} of ${source.length} item(s); the rest were skipped by settings.limit.`,
    );
  }
  return results;
}

async function runConnectorSkill(
  skill: ConnectorStep,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  const settings = renderDeep(skill.settings, templateCtx()) as {
    connector: string;
    capability: string;
    version?: number;
    args: Record<string, unknown>;
  };

  const connector = ctx.connectors?.[settings.connector as keyof typeof ctx.connectors];
  if (!connector) {
    if (skill.when === `ctx.connectors.${settings.connector}.available`) {
      ctx.log(
        "info",
        `Skipping connector step "${skill.id}" — connector "${settings.connector}" not available.`,
      );
      return undefined;
    }
    throw new Error(
      `connector step "${skill.id}": required connector "${settings.connector}" was not built. Declare it under \`descriptor.connectors\` or mark this step optional via \`when: ctx.connectors.${settings.connector}.available\`.`,
    );
  }

  const methodName = kebabToCamel(settings.capability);
  const capabilities = connector.capabilities as unknown as Record<string, unknown>;
  const method = capabilities[methodName];
  if (typeof method !== "function") {
    throw new Error(
      `connector step "${skill.id}": connector "${settings.connector}" does not expose capability "${settings.capability}" (looked up as method "${methodName}").`,
    );
  }

  ctx.log(
    "info",
    `Invoking ${settings.connector}.${settings.capability}@${settings.version ?? 1}`,
    { connectorStepId: skill.id },
  );
  const fn = method as (args: Record<string, unknown>) => Promise<unknown>;
  return await fn(settings.args);
}

function kebabToCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_match, ch: string) => ch.toUpperCase());
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

  // Legacy fast path — keep returning strongly-typed ManagedDeviceRecord
  // values for existing v0.1 agents whose downstream transforms rely on
  // those fields. Detect by the path; any divergence (extra query
  // params, $select customisations) falls through to the generic path.
  if (
    settings.path === "/deviceManagement/managedDevices" &&
    !settings.query &&
    (!settings.select || settings.select.length === 0)
  ) {
    const devices = await ctx.graph.listManagedDevices();
    ctx.log("info", `Loaded ${devices.length} managed devices.`);
    return devices as ManagedDeviceRecord[];
  }

  const query: Record<string, string> = {};
  if (settings.select && settings.select.length > 0) {
    query.$select = settings.select.join(",");
  }
  if (settings.query) {
    for (const [key, value] of Object.entries(settings.query)) {
      query[key] = String(value);
    }
  }

  const response = (await ctx.graph.request({
    method: "GET",
    path: settings.path,
    query: Object.keys(query).length > 0 ? query : undefined,
    headers: settings.headers,
  })) as unknown;

  // Graph collection endpoints wrap items in `{ value: [...] }`. Unwrap
  // so downstream transforms operate on the array directly. Single-
  // entity responses (e.g. `GET /me`) return the entity object as-is.
  const unwrapped = unwrapGraphResponse(response);
  if (Array.isArray(unwrapped)) {
    ctx.log(
      "info",
      `Loaded ${unwrapped.length} items from ${settings.method} ${settings.path}.`,
    );
  } else {
    ctx.log("info", `Loaded ${settings.method} ${settings.path}.`);
  }
  return unwrapped;
}

function unwrapGraphResponse(payload: unknown): unknown {
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    "value" in (payload as Record<string, unknown>)
  ) {
    const value = (payload as Record<string, unknown>).value;
    if (Array.isArray(value)) return value;
  }
  return payload;
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
    case "count-by-field":
      return transformCountByField(skill.id, settings, ctx);
    case "group-by-field":
      return transformGroupByField(skill.id, settings, ctx);
    case "sort-by":
      return transformSortBy(skill.id, settings, ctx);
    case "correlate-stale-devices":
      return transformCorrelateStaleDevices(skill.id, settings, ctx);
    default:
      throw new Error(
        `transform "${skill.id}": unknown kind "${String(kind)}". Supported: group-by-age, filter-by-age, count-by-field, group-by-field, sort-by, correlate-stale-devices.`,
      );
  }
}

function transformGroupByField(
  skillId: string,
  settings: Record<string, unknown>,
  ctx: RunContext,
): Record<string, unknown[]> {
  const source = settings.source;
  const field = settings.field;
  if (!Array.isArray(source)) {
    throw new Error(`transform "${skillId}": group-by-field expects "source" to resolve to an array.`);
  }
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`transform "${skillId}": group-by-field requires "field".`);
  }
  const missingBucket =
    typeof settings.missing === "string" && settings.missing.length > 0
      ? settings.missing
      : "(unknown)";

  const result: Record<string, unknown[]> = {};
  for (const item of source as Array<Record<string, unknown>>) {
    const raw = readFieldPath(item, field);
    const bucket =
      raw === undefined || raw === null || raw === ""
        ? missingBucket
        : String(raw);
    if (!result[bucket]) result[bucket] = [];
    result[bucket].push(item);
  }
  ctx.log(
    "info",
    `Grouped ${source.length} items into ${Object.keys(result).length} buckets by "${field}".`,
  );
  return result;
}

function transformSortBy(
  skillId: string,
  settings: Record<string, unknown>,
  ctx: RunContext,
): unknown[] {
  const source = settings.source;
  const field = settings.field;
  if (!Array.isArray(source)) {
    throw new Error(`transform "${skillId}": sort-by expects "source" to resolve to an array.`);
  }
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`transform "${skillId}": sort-by requires "field".`);
  }
  const direction = settings.direction === "asc" ? "asc" : "desc";
  const take =
    typeof settings.take === "number" && Number.isFinite(settings.take) && settings.take > 0
      ? Math.floor(settings.take)
      : undefined;

  const sorted = [...(source as Array<Record<string, unknown>>)].sort((a, b) => {
    const av = readFieldPath(a, field);
    const bv = readFieldPath(b, field);
    if (av === bv) return 0;
    if (av === undefined || av === null) return 1;
    if (bv === undefined || bv === null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return direction === "asc" ? av - bv : bv - av;
    }
    const as = String(av);
    const bs = String(bv);
    return direction === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
  });

  const out = take ? sorted.slice(0, take) : sorted;
  ctx.log(
    "info",
    `Sorted ${source.length} items by "${field}" ${direction}${take ? `, took top ${take}` : ""}.`,
  );
  return out;
}

/**
 * Read a possibly-nested field path off an object. Accepts dot-notation
 * paths like `signInActivity.lastSignInDateTime` so transforms can
 * operate on Graph's natural nested shapes without an extra mapping
 * step. Returns undefined when any segment is missing.
 */
function readFieldPath(item: unknown, fieldPath: string): unknown {
  if (item === null || typeof item !== "object") return undefined;
  if (!fieldPath.includes(".")) {
    return (item as Record<string, unknown>)[fieldPath];
  }
  let current: unknown = item;
  for (const segment of fieldPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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
    const raw = readFieldPath(item, spec.timestampField);
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
    const raw = readFieldPath(item, spec.timestampField);
    if (typeof raw !== "string") continue;
    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) continue;
    const days = Math.floor((now - ms) / msPerDay);
    if (days >= threshold) matched.push(item);
  }

  ctx.log("info", `Filter-by-age >= ${threshold}d kept ${matched.length} of ${(spec.source as unknown[]).length}.`);
  return matched;
}

// Devices in any of these Intune managementState values are already mid-retire
// or mid-delete. Including them in a new offboarding plan would double-action.
const IN_FLIGHT_MANAGEMENT_STATES = new Set([
  "retirePending",
  "retireIssued",
  "retireFailed",
  "wipePending",
  "wipeIssued",
  "deletePending",
]);

type CorrelationStrategy = "both" | "intune-only" | "entra-only";

interface CorrelateStaleDevicesSpec {
  intuneSource: unknown;
  entraSource: unknown;
  staleDays: number | string;
  strategy: CorrelationStrategy | string;
  excludePersonalDevices?: boolean | string;
}

interface IntuneDeviceLite {
  id?: string;
  deviceName?: string;
  userPrincipalName?: string;
  operatingSystem?: string;
  osVersion?: string;
  lastSyncDateTime?: string;
  azureADDeviceId?: string;
  managementState?: string;
  complianceState?: string;
  managedDeviceOwnerType?: string;
  deviceEnrollmentType?: string;
  [key: string]: unknown;
}

interface EntraDeviceLite {
  id?: string;
  deviceId?: string;
  displayName?: string;
  accountEnabled?: boolean;
  approximateLastSignInDateTime?: string;
  operatingSystem?: string;
  trustType?: string;
  isManaged?: boolean;
  [key: string]: unknown;
}

/**
 * Join Intune managedDevices with Entra device records by
 * `azureADDeviceId === deviceId` and emit offboarding candidates.
 *
 * Output rows always preserve the Intune side as the primary identity (the
 * write step retires via the Intune deviceId) and merge in the Entra
 * timestamp + Entra object id when a match exists. Devices already in flight
 * (retirePending et al.) are dropped before the strategy filter.
 */
function transformCorrelateStaleDevices(
  skillId: string,
  settings: Record<string, unknown>,
  ctx: RunContext,
): unknown[] {
  const spec = settings as unknown as CorrelateStaleDevicesSpec;
  if (!Array.isArray(spec.intuneSource)) {
    throw new Error(
      `transform "${skillId}": correlate-stale-devices expects "intuneSource" to resolve to an array.`,
    );
  }
  if (!Array.isArray(spec.entraSource)) {
    throw new Error(
      `transform "${skillId}": correlate-stale-devices expects "entraSource" to resolve to an array.`,
    );
  }
  const threshold = Number(spec.staleDays);
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error(
      `transform "${skillId}": correlate-stale-devices requires "staleDays" as a non-negative number.`,
    );
  }
  const strategy = String(spec.strategy ?? "both") as CorrelationStrategy;
  if (
    strategy !== "both" &&
    strategy !== "intune-only" &&
    strategy !== "entra-only"
  ) {
    throw new Error(
      `transform "${skillId}": correlate-stale-devices "strategy" must be one of "both", "intune-only", "entra-only" (got "${strategy}").`,
    );
  }

  const now = Date.now();
  const msPerDay = 86_400_000;
  const thresholdMs = threshold * msPerDay;
  const excludePersonalDevices = toBoolean(spec.excludePersonalDevices);

  const entraByDeviceId = new Map<string, EntraDeviceLite>();
  for (const entry of spec.entraSource as EntraDeviceLite[]) {
    if (entry && typeof entry.deviceId === "string" && entry.deviceId.length > 0) {
      entraByDeviceId.set(entry.deviceId.toLowerCase(), entry);
    }
  }

  const ageMs = (iso: unknown): number | null => {
    if (typeof iso !== "string") return null;
    const ms = new Date(iso).getTime();
    if (Number.isNaN(ms)) return null;
    return now - ms;
  };

  const candidates: Array<Record<string, unknown>> = [];
  let inFlightSkipped = 0;
  let personalSkipped = 0;

  for (const intune of spec.intuneSource as IntuneDeviceLite[]) {
    if (!intune || typeof intune !== "object") continue;
    if (
      typeof intune.managementState === "string" &&
      IN_FLIGHT_MANAGEMENT_STATES.has(intune.managementState)
    ) {
      inFlightSkipped++;
      continue;
    }
    if (
      excludePersonalDevices &&
      typeof intune.managedDeviceOwnerType === "string" &&
      intune.managedDeviceOwnerType.toLowerCase() === "personal"
    ) {
      personalSkipped++;
      continue;
    }

    const aad = typeof intune.azureADDeviceId === "string" ? intune.azureADDeviceId.toLowerCase() : "";
    const entra = aad ? entraByDeviceId.get(aad) : undefined;

    const intuneAge = ageMs(intune.lastSyncDateTime);
    const entraAge = ageMs(entra?.approximateLastSignInDateTime);
    const intuneStale = intuneAge !== null && intuneAge >= thresholdMs;
    const entraStale = entraAge !== null && entraAge >= thresholdMs;

    let matches = false;
    switch (strategy) {
      case "intune-only":
        matches = intuneStale;
        break;
      case "entra-only":
        matches = entraStale;
        break;
      case "both":
      default:
        matches = intuneStale && entraStale;
        break;
    }
    if (!matches) continue;

    candidates.push({
      ...intune,
      entraObjectId: entra?.id ?? null,
      approximateLastSignInDateTime: entra?.approximateLastSignInDateTime ?? null,
      entraAccountEnabled: entra?.accountEnabled ?? null,
      entraTrustType: entra?.trustType ?? null,
      entraIsManaged: entra?.isManaged ?? null,
      intuneInactiveDays:
        intuneAge === null ? null : Math.max(0, Math.floor(intuneAge / msPerDay)),
      entraInactiveDays:
        entraAge === null ? null : Math.max(0, Math.floor(entraAge / msPerDay)),
      matchedStrategy: strategy,
    });
  }

  ctx.log(
    "info",
    `Correlate stale devices (strategy=${strategy}, staleDays=${threshold}): kept ${candidates.length} of ${
      (spec.intuneSource as unknown[]).length
    }; skipped ${inFlightSkipped} already in flight${
      excludePersonalDevices ? ` and ${personalSkipped} personal device(s)` : ""
    }.`,
  );

  return candidates;
}

function toBoolean(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes";
  }
  return false;
}

interface CountByFieldSpec {
  source: unknown;
  field: string;
  /**
   * Optional explicit list of bucket names. When provided, the output
   * keys are exactly these (zero-filled for missing values) so the
   * resulting object has a stable shape across runs — useful when the
   * downstream template renders specific keys (`{{ x.output.compliant }}`).
   * When omitted, the keys are whatever values actually appear in the
   * source array.
   */
  buckets?: string[];
}

function transformCountByField(
  skillId: string,
  settings: Record<string, unknown>,
  ctx: RunContext,
): Record<string, number> {
  const spec = settings as unknown as CountByFieldSpec;
  if (!Array.isArray(spec.source)) {
    throw new Error(`transform "${skillId}": count-by-field expects "source" to resolve to an array.`);
  }
  if (typeof spec.field !== "string" || spec.field.length === 0) {
    throw new Error(`transform "${skillId}": count-by-field requires "field".`);
  }

  const result: Record<string, number> = {};
  if (Array.isArray(spec.buckets)) {
    for (const bucket of spec.buckets) {
      if (typeof bucket === "string") result[bucket] = 0;
    }
  }

  for (const item of spec.source as Array<Record<string, unknown>>) {
    const raw = readFieldPath(item, spec.field);
    if (raw === undefined || raw === null) continue;
    const key = typeof raw === "string" ? raw : String(raw);
    result[key] = (result[key] ?? 0) + 1;
  }

  const total = (spec.source as unknown[]).length;
  const breakdown = Object.entries(result)
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
  ctx.log(
    "info",
    `Counted ${total} items by "${spec.field}": ${breakdown || "(no matches)"}.`,
  );
  return result;
}

async function runLlmSkill(
  skill: LlmStep,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  if (!ctx.llm.available) {
    // Agents are LLM-augmented automations by contract. If we reach an
    // `llm` step without a usable provider, fail loudly rather than
    // silently skipping — the headline summary depends on this step's
    // output. The host preflights `startRun` to ensure a connected
    // provider before queueing, so this should only trip in tests or
    // when the provider drops mid-run.
    throw new Error(
      `LLM step "${skill.label}" requires a connected LLM provider. Start Ollama (or pick another provider in Settings) and re-run.`,
    );
  }

  const settings = renderDeep(skill.settings, templateCtx());

  const completion = await ctx.llm.complete({
    prompt: settings.prompt,
    ...(settings.system ? { system: settings.system } : {}),
    ...(typeof settings.temperature === "number" ? { temperature: settings.temperature } : {}),
    ...(typeof settings.maxTokens === "number" ? { maxTokens: settings.maxTokens } : {}),
  });

  const cleaned = cleanLlmText(completion.text);
  ctx.log(
    "info",
    `LLM step "${skill.label}" used model ${completion.model} · ${cleaned.length} chars returned.`,
  );
  if (cleaned.length === 0) {
    const promptSnippet = typeof settings.prompt === "string"
      ? settings.prompt.slice(0, 160)
      : "";
    ctx.log(
      "warn",
      `LLM step "${skill.label}" returned no usable text. Raw length: ${completion.text.length}. ` +
        `Common causes: model not pulled, model exhausted maxTokens on reasoning tags, or model returned only <think>…</think>. ` +
        `Prompt began with: ${promptSnippet}${promptSnippet.length === 160 ? "…" : ""}`,
    );
  }
  return {
    text: cleaned,
    model: completion.model,
  };
}

/**
 * Strip `<think>…</think>` reasoning blocks emitted by reasoning models
 * (deepseek-r1, qwen-qwq, etc.) from the visible answer. The full
 * unfiltered stream is still surfaced in the Reasoning tab via the
 * runtime's per-step thinking hook — this only affects what the agent's
 * downstream templates see as `summarize.output.text`.
 */
function cleanLlmText(raw: string): string {
  if (typeof raw !== "string") return "";
  // Remove fully-closed thinking blocks.
  let stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  // Some models emit `<think>…` and never close it within maxTokens.
  // Treat anything after a dangling `<think>` as throwaway reasoning.
  const danglingThink = stripped.search(/<think>/i);
  if (danglingThink >= 0) {
    stripped = stripped.slice(0, danglingThink);
  }
  return stripped.trim();
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
    tier: descriptor.tier ?? "agent",
    requiresEntraTier: descriptor.requiresEntraTier ?? "free",
    scopes: collectScopes(manifest),
    author: descriptor.author,
    version: descriptor.version,
    minAppVersion: descriptor.minAppVersion,
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

function walkSkills(skills: TemplateStep[], visit: (skill: TemplateStep) => void): void {
  for (const skill of skills) {
    visit(skill);
    if (skill.format === "map") {
      walkSkills(skill.settings.do, visit);
    }
  }
}

function collectScopes(manifest: AgentTemplate): string[] {
  const scopes = new Set<string>();
  walkSkills(manifest.skills, (skill) => {
    if (skill.format === "graph") {
      for (const scope of skill.settings.scopes ?? []) {
        scopes.add(scope);
      }
    } else if (skill.format === "write") {
      for (const scope of skill.settings.scopes ?? []) {
        scopes.add(scope);
      }
    }
  });
  return [...scopes];
}

function collectGraphOperations(manifest: AgentTemplate): GraphOperation[] {
  const operations: GraphOperation[] = [];
  walkSkills(manifest.skills, (skill) => {
    if (skill.format !== "graph") return;
    const op: GraphOperation = {
      method: skill.settings.method,
      path: skill.settings.path,
    };
    if (skill.settings.select && skill.settings.select.length > 0) {
      op.select = [...skill.settings.select];
    }
    if (skill.detail) {
      op.notes = skill.detail;
    }
    operations.push(op);
  });
  return operations;
}

/**
 * Project a parsed manifest into the listing shape consumed by the
 * Hub / Agent Detail surfaces. This is the YAML-native replacement for
 * the old `manifest.json` projection — every field here is derivable
 * from the `descriptor` block plus the declared `skills`.
 */
export function agentTemplateToRegistrySummary(
  manifest: AgentTemplate,
): {
  id: string;
  registryId: string;
  slug: string;
  name: string;
  description: string;
  mode: AgentMode;
  category: AgentCategory;
  tier: AgentTier;
  requiresEntraTier: RequiredEntraTier;
  scopes: string[];
  author: AgentAuthor;
  version: string;
  minAppVersion?: string;
  preferredModel?: string;
  graphOperations: GraphOperation[];
  connectors?: AgentConnectorRequirement[];
} {
  const descriptor = manifest.descriptor;
  return {
    id: descriptor.id,
    registryId: descriptor.id,
    slug: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    mode: descriptor.mode,
    category: descriptor.category,
    tier: descriptor.tier ?? "agent",
    requiresEntraTier: descriptor.requiresEntraTier ?? "free",
    scopes: collectScopes(manifest),
    author: descriptor.author,
    version: descriptor.version,
    minAppVersion: descriptor.minAppVersion,
    ...(descriptor.preferredModel ? { preferredModel: descriptor.preferredModel } : {}),
    graphOperations: collectGraphOperations(manifest),
    ...(descriptor.connectors && descriptor.connectors.length > 0
      ? { connectors: descriptor.connectors }
      : {}),
  };
}
