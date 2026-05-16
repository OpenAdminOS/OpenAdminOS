import { load as parseYaml } from "js-yaml";

import type {
  AgentModule,
  AgentRunResult,
  ManagedDeviceRecord,
  ReadAgentModule,
  RunContext,
  Tier1GraphSkill,
  Tier1LlmSkill,
  Tier1Manifest,
  Tier1Skill,
  Tier1TransformSkill,
} from "@openagents/agent-sdk";

import { renderDeep, renderTemplate, type TemplateContext } from "./tier1-template.js";

export class ManifestValidationError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ManifestValidationError";
    this.path = path;
  }
}

/**
 * Parse a Tier 1 manifest from YAML (or JSON) text. Throws
 * ManifestValidationError on schema violations.
 */
export function parseTier1Manifest(source: string): Tier1Manifest {
  const raw = parseYaml(source);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ManifestValidationError("root", "manifest must be a YAML object");
  }
  const data = raw as Record<string, unknown>;

  const descriptor = requireObject(data, "descriptor");
  const skills = requireArray(data, "skills");
  const definition = requireObject(data, "definition");

  // Quick descriptor shape checks. The runtime's existing JSON validator
  // already does deep checks for built-in registry agents -- here we just
  // make sure the fields the interpreter reads are present.
  for (const field of ["id", "name", "description", "version", "category", "mode"] as const) {
    if (typeof descriptor[field] !== "string" || (descriptor[field] as string).length === 0) {
      throw new ManifestValidationError(`descriptor.${field}`, "must be a non-empty string");
    }
  }
  if (descriptor.mode !== "read" && descriptor.mode !== "write") {
    throw new ManifestValidationError(
      "descriptor.mode",
      `expected "read" or "write", got ${JSON.stringify(descriptor.mode)}`,
    );
  }

  if (skills.length === 0) {
    throw new ManifestValidationError("skills", "must contain at least one skill");
  }

  const validated: Tier1Skill[] = skills.map((skill, idx) => {
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
      throw new ManifestValidationError(`skills[${idx}]`, "must be an object");
    }
    return validateSkill(skill as Record<string, unknown>, `skills[${idx}]`);
  });

  if (!definition.result || typeof definition.result !== "object") {
    throw new ManifestValidationError("definition.result", "must be an object");
  }
  const resultDef = definition.result as Record<string, unknown>;
  if (typeof resultDef.summary !== "string") {
    throw new ManifestValidationError("definition.result.summary", "must be a string");
  }

  return {
    descriptor: descriptor as Tier1Manifest["descriptor"],
    skills: validated,
    definition: definition as Tier1Manifest["definition"],
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

function validateSkill(skill: Record<string, unknown>, path: string): Tier1Skill {
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
      return skill as unknown as Tier1GraphSkill;
    case "transform":
      return skill as unknown as Tier1TransformSkill;
    case "llm":
      return skill as unknown as Tier1LlmSkill;
    default:
      throw new ManifestValidationError(
        `${path}.format`,
        `unknown format: ${JSON.stringify(skill.format)}`,
      );
  }
}

// ─── Interpreter ───────────────────────────────────────────────────────────

/**
 * Execute a Tier 1 manifest against a live RunContext. Each skill's output
 * lands at `pipeline[skill.id].output` and is visible to later skills + the
 * final result template.
 */
export async function runTier1Manifest(
  manifest: Tier1Manifest,
  ctx: RunContext,
): Promise<AgentRunResult> {
  const settings = resolveSettings(manifest);
  const pipeline: Record<string, { output: unknown }> = {};

  const templateCtx = (): TemplateContext => ({
    settings,
    ctx: {
      tenantId: ctx.agent.id, // placeholder until ctx exposes tenant info directly
      providerId: ctx.providerId,
      model: ctx.model,
    },
    ...pipeline,
  });

  for (const skill of manifest.skills) {
    await ctx.step(skill.label, skill.detail, async () => {
      const output = await runSkill(skill, ctx, templateCtx);
      pipeline[skill.id] = { output };
    });
  }

  const resultDef = manifest.definition.result;
  const finalCtx = templateCtx();
  const summary = String(renderTemplate(resultDef.summary, finalCtx) ?? "");
  const dataRaw = resultDef.data ? renderDeep(resultDef.data, finalCtx) : undefined;

  return {
    summary: summary.trim(),
    ...(dataRaw !== undefined ? { result: dataRaw } : {}),
  };
}

function resolveSettings(manifest: Tier1Manifest): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  for (const def of manifest.definition.settings ?? []) {
    if (def.default !== undefined) {
      settings[def.id] = def.default;
    }
  }
  return settings;
}

async function runSkill(
  skill: Tier1Skill,
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
    default: {
      const exhaustive: never = skill;
      throw new Error(`Unsupported skill format: ${JSON.stringify(exhaustive)}`);
    }
  }
}

async function runGraphSkill(
  skill: Tier1GraphSkill,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  const settings = renderDeep(skill.settings, templateCtx());

  if (settings.method !== "GET") {
    throw new Error(
      `graph skill "${skill.id}": only GET is supported in v0.1 Tier 1 (got ${settings.method}).`,
    );
  }

  // v0.1 limitation: the Tier 1 graph format currently knows one canonical
  // path. Expanding this requires extending RunGraphApi or a generic
  // method on the adapter — neither is in this slice.
  if (settings.path === "/deviceManagement/managedDevices") {
    const devices = await ctx.graph.listManagedDevices();
    ctx.log("info", `Loaded ${devices.length} managed devices.`);
    return devices as ManagedDeviceRecord[];
  }

  throw new Error(
    `graph skill "${skill.id}": path "${settings.path}" is not yet supported by the Tier 1 interpreter. Use a Tier 2 (code) agent or extend RunGraphApi.`,
  );
}

async function runTransformSkill(
  skill: Tier1TransformSkill,
  ctx: RunContext,
  templateCtx: () => TemplateContext,
): Promise<unknown> {
  const settings = renderDeep(skill.settings, templateCtx()) as Record<string, unknown>;
  const kind = settings.kind;

  switch (kind) {
    case "group-by-age":
      return transformGroupByAge(skill.id, settings, ctx);
    default:
      throw new Error(
        `transform skill "${skill.id}": unknown kind "${String(kind)}". Supported in v0.1: group-by-age.`,
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
    throw new Error(
      `transform "${skillId}": group-by-age expects "source" to resolve to an array.`,
    );
  }
  if (typeof spec.timestampField !== "string" || spec.timestampField.length === 0) {
    throw new Error(`transform "${skillId}": group-by-age requires "timestampField".`);
  }
  if (!Array.isArray(spec.groups) || spec.groups.length === 0) {
    throw new Error(`transform "${skillId}": group-by-age requires at least one group.`);
  }

  const now = Date.now();
  const msPerDay = 86_400_000;

  // Sort thresholds descending so each item lands in the *highest* bucket it
  // qualifies for. E.g. a 200-day-inactive device should be in `retire`, not
  // `warn` -- even though both thresholds match.
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
  ctx.log("info", `Grouped devices by inactivity: ${counts}.`);
  return result;
}

async function runLlmSkill(
  skill: Tier1LlmSkill,
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

// ─── Adapter so the runtime can treat a Tier 1 manifest as an AgentModule ───

export function tier1ManifestToAgentModule(
  manifest: Tier1Manifest,
): ReadAgentModule {
  const descriptor = manifest.descriptor;
  return {
    id: descriptor.id,
    slug: descriptor.id,
    name: descriptor.name,
    description: descriptor.description,
    mode: "read",
    category: descriptor.category,
    scopes: collectScopes(manifest),
    author: descriptor.author,
    version: descriptor.version,
    ...(descriptor.preferredModel ? { preferredModel: descriptor.preferredModel } : {}),
    run: (ctx) => runTier1Manifest(manifest, ctx),
  } as ReadAgentModule;
}

function collectScopes(manifest: Tier1Manifest): string[] {
  const scopes = new Set<string>();
  for (const skill of manifest.skills) {
    if (skill.format === "graph") {
      for (const scope of skill.settings.scopes ?? []) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes];
}
