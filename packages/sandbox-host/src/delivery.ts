import { createHash } from "node:crypto";

import type { RunRecord } from "@openadminos/agent-sdk";
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
    .replace(/\b([A-Za-z0-9-]+)\.([A-Za-z]{2,})\b/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/**
 * The report a sandbox sends, rendered only from structured fields: the
 * agent, the status, and the counts the manifest's result declares by
 * name. No text the model wrote, no tenant names and no error text
 * leaves the machine.
 */
export function renderSandboxReport(input: {
  run: RunRecord;
  agentName: string;
  sandboxName: string;
  /** `definition.result.data` of the pinned manifest: the allowlist of result keys. */
  resultDefinition: unknown;
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
  collect(input.resultDefinition, input.run.result, "", 0, findings);
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

function collect(definition: unknown, value: unknown, prefix: string, depth: number, out: string[]): void {
  if (definition !== null && typeof definition === "object" && !Array.isArray(definition)) {
    if (depth >= MAX_DEPTH || value === null || typeof value !== "object" || Array.isArray(value)) return;
    for (const key of Object.keys(definition)) {
      if (!RESULT_KEY.test(key) || /^llm/i.test(key)) continue;
      collect((definition as Record<string, unknown>)[key], (value as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key, depth + 1, out);
    }
    return;
  }
  if (!prefix) return;
  if (typeof value === "number" && Number.isFinite(value)) out.push(`- ${prefix}: ${value}`);
  else if (typeof value === "string" && /^-?\d{1,15}(?:\.\d{1,6})?$/.test(value.trim())) out.push(`- ${prefix}: ${value.trim()}`);
  else if (typeof value === "boolean") out.push(`- ${prefix}: ${value ? "yes" : "no"}`);
  else if (Array.isArray(value)) out.push(`- ${prefix}: ${value.length} ${value.length === 1 ? "item" : "items"}`);
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
export async function sendDelivery(input: {
  delivery: SandboxDeliveryConfig;
  secrets: SandboxSecrets;
  text: string;
  fetch?: typeof fetch;
}): Promise<DeliveryOutcome> {
  const base = input.fetch ?? fetch;
  try {
    if (input.delivery.connector === "slack") {
      const token = input.secrets.slack?.botToken;
      if (!token) return { outcome: "failed", detail: "No Slack bot token in the secrets file." };
      const client = createSlackClient({ botToken: token, fetchImpl: pinnedFetch(base, "https://slack.com") });
      await client.postMessage({ channel: input.delivery.channel, text: input.text });
      return { outcome: "sent", detail: `Sent to Slack channel ${input.delivery.channel}.` };
    }
    const webhookUrl = input.secrets.discord?.webhookUrl;
    if (!webhookUrl) return { outcome: "failed", detail: "No Discord webhook URL in the secrets file." };
    const client = createDiscordWebhookClient({ webhookUrl, fetchImpl: pinnedFetch(base, new URL(webhookUrl).origin), suppressEmbeds: true });
    await client.sendMessage({ text: input.text, ...(input.delivery.threadId ? { threadId: input.delivery.threadId } : {}) });
    return { outcome: "sent", detail: "Sent to the Discord webhook." };
  } catch (error) {
    return { outcome: "failed", detail: redactSecrets(describe(error), input.secrets) };
  }
}

function pinnedFetch(base: typeof fetch, origin: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).origin !== origin) {
      throw new Error(`The delivery request to ${new URL(href).origin} was refused: this destination sends only to ${origin}.`);
    }
    return base(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}

function redactSecrets(text: string, secrets: SandboxSecrets): string {
  let result = text;
  for (const secret of [secrets.slack?.botToken, secrets.discord?.webhookUrl]) {
    if (secret) result = result.split(secret).join("(secret)");
  }
  return result.replace(/https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\S+/g, "(webhook URL)").slice(0, 300);
}
