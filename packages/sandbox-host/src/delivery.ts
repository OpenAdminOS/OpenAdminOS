import { createHash } from "node:crypto";

import type { AgentTemplate, RunRecord, TemplateStep } from "@openadminos/agent-sdk";
import { createDiscordWebhookClient } from "@openadminos/connector-discord";
import { createSlackClient } from "@openadminos/connector-slack";

import type { SandboxDeliveryConfig } from "./config.js";
import { describe } from "./files.js";
import type { SandboxSecrets } from "./secrets.js";

const MAX_FINDING_LINES = 25;
const MAX_MESSAGE_CHARS = 3_000;
const MAX_DEPTH = 3;
const RESULT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,48}$/;

/**
 * Removes what a chat service would turn into a mention, a link or a
 * preview. Applied to every text field of a report, even ones from the
 * config or a pinned manifest.
 */
export function neutralize(text: string): string {
  return text
    .replace(/[<>@`*_~|[\]]/g, "")
    .replace(/:\/\//g, ": ")
    .replace(/(?<=\w)\.(?=\w)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * The ids of the steps whose output comes from the model: every llm step,
 * every map step with one inside, and every step whose settings read the
 * output of one of those.
 */
export function modelDerivedStepIds(steps: readonly TemplateStep[]): Set<string> {
  // Every step at every depth, with the map it sits in, so steps inside a
  // map are followed like top-level ones.
  const all: Array<{ step: TemplateStep; parent?: TemplateStep }> = [];
  const walk = (list: readonly TemplateStep[], parent?: TemplateStep) => {
    for (const step of list) {
      all.push({ step, ...(parent ? { parent } : {}) });
      if (step.format === "map") walk(step.settings.do, step);
    }
  };
  walk(steps);
  const derived = new Set<string>();
  for (const { step } of all) if (step.format === "llm") derived.add(step.id);
  const reads = (step: TemplateStep) => [...stepReferences(JSON.stringify(step.settings ?? {}))];
  for (let changed = true; changed;) {
    changed = false;
    const mark = (name: string) => {
      if (!derived.has(name)) {
        derived.add(name);
        changed = true;
      }
    };
    for (const { step, parent } of all) {
      if (step.format === "map") {
        const inner = step.settings.do;
        // A map is model output when anything inside it is; its item is when its source is.
        if (inner.some((child) => derived.has(child.id))) mark(step.id);
        if (stepReferences(step.settings.source).size > 0 && [...stepReferences(step.settings.source)].some((name) => derived.has(name))) mark(step.settings.as);
      } else if (reads(step).some((name) => derived.has(name))) {
        mark(step.id);
      }
      if (parent && derived.has(step.id)) mark(parent.id);
    }
  }
  return derived;
}

/**
 * Every name an expression reads: `{{ step.output }}`, a bare `{{ step }}`,
 * `{{ step | size }}` and names in filter arguments, with string literals
 * and filter names removed. Over-counting only drops a field.
 */
function stepReferences(text: string): Set<string> {
  const roots = new Set<string>();
  const add = (part: string) => {
    for (const reference of part.matchAll(/(?<![\w.])([A-Za-z_][A-Za-z0-9_]*)/g)) roots.add(reference[1] as string);
  };
  for (const match of text.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
    const expression = (match[1] ?? "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    const [value = "", ...filters] = expression.split("|");
    add(value);
    for (const filter of filters) add(filter.replace(/^\s*[A-Za-z_][A-Za-z0-9_]*/, ""));
  }
  return roots;
}

/**
 * A result field the report may carry: a literal, or template expressions
 * that read only settings and steps whose output does not come from the
 * model.
 */
function isDeterministicField(definition: unknown, steps: ReadonlySet<string>, modelDerived: ReadonlySet<string>): boolean {
  if (typeof definition === "number") return true;
  if (typeof definition !== "string") return false;
  const roots = stepReferences(definition);
  if (roots.size === 0) return false;
  return [...roots].every((root) => root === "settings" || (steps.has(root) && !modelDerived.has(root)));
}

/**
 * The report a sandbox sends, rendered only from structured fields: the
 * agent, the status, and the counts the manifest's result declares by
 * name, from expressions that do not read model output. Only
 * non-negative integers and list lengths are sent: no text the model
 * wrote, no tenant names and no error text leaves the machine.
 */
export function renderSandboxReport(input: {
  run: RunRecord;
  agentName: string;
  sandboxName: string;
  /** The pinned manifest: its result definition is the allowlist of fields. */
  manifest: AgentTemplate;
  reason?: string;
}): string {
  const lines = [
    "OpenAdminOS sandbox report",
    `Agent: ${neutralize(input.agentName)}`,
    `Status: ${input.run.status === "completed" ? "Completed" : "Failed"}`,
    `Sandbox: ${neutralize(input.sandboxName)}`,
    `Run: ${input.run.id}`,
    `Finished: ${input.run.finishedAt ?? "unknown"}`,
  ];
  if (input.run.status !== "completed" && input.reason) lines.push(`Reason: ${input.reason}`);
  const findings: string[] = [];
  const steps = new Set<string>();
  const addSteps = (list: readonly TemplateStep[]) => {
    for (const step of list) {
      steps.add(step.id);
      if (step.format === "map") addSteps(step.settings.do);
    }
  };
  addSteps(input.manifest.skills);
  const modelDerived = modelDerivedStepIds(input.manifest.skills);
  collect(input.manifest.definition.result.data, input.run.result, "", 0, findings, (definition) => isDeterministicField(definition, steps, modelDerived));
  if (findings.length > 0) {
    lines.push("Findings:");
    lines.push(...findings.slice(0, MAX_FINDING_LINES));
    if (findings.length > MAX_FINDING_LINES) lines.push(`${findings.length - MAX_FINDING_LINES} more values are on the sandbox.`);
  }
  const text = lines.join("\n");
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 40)}\nThe rest is on the sandbox.` : text;
}

/** A notice that runs work again after a failure notice: metadata only. */
export function renderRecoveryNotice(input: { agentId: string; sandboxName: string; at: string }): string {
  return [
    "OpenAdminOS sandbox notice",
    `Agent: ${neutralize(input.agentId)}`,
    `Sandbox: ${neutralize(input.sandboxName)}`,
    "Status: runs complete again",
    `Time: ${input.at}`,
  ].join("\n");
}

/** A notice that a run was refused or failed: metadata only. */
export function renderFailureNotice(input: { agentId: string; sandboxName: string; reason: string; at: string }): string {
  return [
    "OpenAdminOS sandbox notice",
    `Agent: ${neutralize(input.agentId)}`,
    `Sandbox: ${neutralize(input.sandboxName)}`,
    `Reason: ${input.reason}`,
    `Time: ${input.at}`,
  ].join("\n");
}

function collect(
  definition: unknown,
  value: unknown,
  prefix: string,
  depth: number,
  out: string[],
  deterministic: (definition: unknown) => boolean,
): void {
  if (definition !== null && typeof definition === "object" && !Array.isArray(definition)) {
    if (depth >= MAX_DEPTH || value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of Object.keys(definition)) {
      if (!RESULT_KEY.test(key)) continue;
      collect((definition as Record<string, unknown>)[key], (value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, depth + 1, out, deterministic);
    }
    return;
  }
  if (!prefix || !deterministic(definition)) return;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out.push(`- ${prefix}: ${value}`);
  else if (Array.isArray(value)) out.push(`- ${prefix}: ${value.length} ${value.length === 1 ? "item" : "items"}`);
}

/** The longest message each destination takes. */
export const DELIVERY_MAX_CHARS = { slack: 3_000, discord: 2_000 } as const;

/** Shortens a message to what its destination takes, saying that the rest stays here. */
export function capForConnector(text: string, connector: keyof typeof DELIVERY_MAX_CHARS): string {
  const max = DELIVERY_MAX_CHARS[connector];
  if (text.length <= max) return text;
  const note = "\nThe rest is on the sandbox.";
  const cut = text.slice(0, max - note.length);
  const lastLine = cut.lastIndexOf("\n");
  return `${lastLine > 0 ? cut.slice(0, lastLine) : cut}${note}`;
}

export function payloadDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export interface DeliveryOutcome {
  outcome: "sent" | "failed";
  detail: string;
}

/**
 * Sends one message to the destination fixed in the config, once. A
 * failure is returned, never retried. Requests go only to the
 * destination's own origin, and redirects fail.
 */
/** A delivery that has not settled by then, body included, is stopped and recorded as failed. */
export const DELIVERY_TIMEOUT_MS = 30_000;

export async function sendDelivery(input: {
  delivery: SandboxDeliveryConfig;
  secrets: SandboxSecrets;
  text: string;
  fetch?: typeof fetch;
  /** The host's shutdown signal; a shutdown stops a delivery in progress. */
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<DeliveryOutcome> {
  const timeoutMs = input.timeoutMs ?? DELIVERY_TIMEOUT_MS;
  // The connector clients stop their own timer once headers arrive; this
  // one stays active until the response body is read, and a shutdown ends
  // it too. The request is never retried.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`The delivery did not finish within ${Math.round(timeoutMs / 1000)} seconds and was stopped.`)), timeoutMs);
  const onShutdown = () => controller.abort(new Error("The sandbox host stopped during the delivery."));
  if (input.signal?.aborted) onShutdown();
  else input.signal?.addEventListener("abort", onShutdown, { once: true });
  const stopped = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(controller.signal.reason);
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });
  stopped.catch(() => undefined);
  try {
    return await Promise.race([send(input, controller.signal), stopped]);
  } catch (error) {
    return { outcome: "failed", detail: redactSecrets(describe(error), input.secrets) };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onShutdown);
  }
}

async function send(input: { delivery: SandboxDeliveryConfig; secrets: SandboxSecrets; text: string; fetch?: typeof fetch }, signal: AbortSignal): Promise<DeliveryOutcome> {
  const base = input.fetch ?? fetch;
  {
    if (input.delivery.connector === "slack") {
      const token = input.secrets.slack?.botToken;
      if (!token) return { outcome: "failed", detail: "No Slack bot token in the secrets file." };
      const client = createSlackClient({ botToken: token, fetchImpl: pinnedFetch(base, "https://slack.com", signal) });
      await client.postMessage({ channel: input.delivery.channel, text: input.text });
      return { outcome: "sent", detail: `Sent to Slack channel ${input.delivery.channel}.` };
    }
    const webhookUrl = input.secrets.discord?.webhookUrl;
    if (!webhookUrl) return { outcome: "failed", detail: "No Discord webhook URL in the secrets file." };
    const client = createDiscordWebhookClient({ webhookUrl, fetchImpl: pinnedFetch(base, new URL(webhookUrl).origin, signal), suppressEmbeds: true });
    await client.sendMessage({ text: input.text, ...(input.delivery.threadId ? { threadId: input.delivery.threadId } : {}) });
    return { outcome: "sent", detail: "Sent to the Discord webhook." };
  }
}

function pinnedFetch(base: typeof fetch, origin: string, signal: AbortSignal): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).origin !== origin) {
      throw new Error(`The delivery request to ${new URL(href).origin} was refused: this destination sends only to ${origin}.`);
    }
    return base(input, { ...init, redirect: "error", signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
  }) as typeof fetch;
}

function redactSecrets(text: string, secrets: SandboxSecrets): string {
  let result = text;
  for (const secret of [secrets.slack?.botToken, secrets.discord?.webhookUrl]) {
    if (secret) result = result.split(secret).join("(secret)");
  }
  return result.replace(/https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\S+/g, "(webhook URL)").slice(0, 300);
}
