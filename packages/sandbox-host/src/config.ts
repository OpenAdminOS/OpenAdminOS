import { dirname, isAbsolute, join, resolve } from "node:path";

import { readPrivateFile } from "./files.js";
import { SandboxRefusal } from "./refusal.js";

/** Shortest schedule interval: 15 minutes. */
export const MIN_INTERVAL_SECONDS = 900;
/** Longest schedule interval: 31 days. */
export const MAX_INTERVAL_SECONDS = 31 * 86_400;
export const DEFAULT_RUN_DEADLINE_SECONDS = 1_800;

export type SandboxModelProvider = "ollama" | "lm-studio";

export interface SandboxCertificateConfig {
  certificatePath: string;
  privateKeyPath: string;
}

export type SandboxDeliveryConfig =
  | { connector: "slack"; channel: string; notifyOnSuccess: boolean; notifyOnFailure: boolean; failureNotice: boolean }
  | { connector: "discord"; threadId?: string; notifyOnSuccess: boolean; notifyOnFailure: boolean; failureNotice: boolean };

export interface SandboxAgentConfig {
  id: string;
  /** SHA-256 hex of the agent's manifest.yaml the admin reviewed. */
  templateSha256: string;
  intervalSeconds: number;
  /** Absent means no report leaves the sandbox for this agent. */
  delivery?: SandboxDeliveryConfig;
}

export interface SandboxConfig {
  /** The file the config was read from. */
  path: string;
  sandbox: { id: string; name: string };
  organizationId: string;
  tenantId: string;
  clientId: string;
  /** One certificate, or two while one replaces the other. */
  certificates: SandboxCertificateConfig[];
  model: { provider: SandboxModelProvider; endpoint: string; model: string; timeoutSeconds?: number };
  dataDir: string;
  /** Next to the config, read only when an agent has a delivery. */
  secretsPath: string;
  runDeadlineSeconds: number;
  agents: SandboxAgentConfig[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA256 = /^[0-9a-f]{64}$/;

class FieldError extends SandboxRefusal {
  constructor(field: string, problem: string) {
    super("config-invalid", `Sandbox config field "${field}" ${problem}`);
  }
}

/** Reads and validates the config. Every problem names the field. */
export function loadSandboxConfig(path: string): SandboxConfig {
  const absolute = resolve(path);
  const text = readPrivateFile(absolute, "sandbox config");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SandboxRefusal("config-invalid", `The sandbox config at ${absolute} is not valid JSON.`);
  }
  return parseSandboxConfig(parsed, absolute);
}

export function parseSandboxConfig(value: unknown, path: string): SandboxConfig {
  const root = object(value, "(root)");
  const base = dirname(path);
  knownKeys(root, "(root)", ["version", "sandbox", "organizationId", "tenantId", "clientId", "certificates", "model", "dataDir", "secretsFile", "runDeadlineSeconds", "agents"]);
  if (root.version !== 1) throw new FieldError("version", "must be 1.");
  const sandbox = object(root.sandbox, "sandbox");
  knownKeys(sandbox, "sandbox", ["id", "name"]);
  const id = string(sandbox.id, "sandbox.id");
  if (!SANDBOX_ID.test(id)) throw new FieldError("sandbox.id", "may use letters, digits, dot, dash and underscore, up to 64 characters.");
  const name = string(sandbox.name, "sandbox.name");
  if (name.length > 80) throw new FieldError("sandbox.name", "must be at most 80 characters.");

  const organizationId = string(root.organizationId, "organizationId");
  if (organizationId.length > 128) throw new FieldError("organizationId", "must be at most 128 characters.");
  const tenantId = string(root.tenantId, "tenantId");
  if (!GUID.test(tenantId)) throw new FieldError("tenantId", "must be the directory (tenant) ID, a GUID.");
  const clientId = string(root.clientId, "clientId");
  if (!GUID.test(clientId)) throw new FieldError("clientId", "must be the application (client) ID of the sandbox app registration, a GUID.");

  if (!Array.isArray(root.certificates) || root.certificates.length < 1 || root.certificates.length > 2) {
    throw new FieldError("certificates", "must list one certificate, or two while one replaces the other.");
  }
  const certificates = root.certificates.map((entry, index) => {
    const field = `certificates[${index}]`;
    const certificate = object(entry, field);
    knownKeys(certificate, field, ["certificatePath", "privateKeyPath"]);
    return {
      certificatePath: filePath(certificate.certificatePath, `${field}.certificatePath`, base),
      privateKeyPath: filePath(certificate.privateKeyPath, `${field}.privateKeyPath`, base),
    };
  });

  const model = object(root.model, "model");
  knownKeys(model, "model", ["provider", "endpoint", "model", "timeoutSeconds"]);
  if (model.provider !== "ollama" && model.provider !== "lm-studio") {
    throw new FieldError("model.provider", 'must be "ollama" or "lm-studio". A sandbox runs only a model on this machine.');
  }
  const endpoint = string(model.endpoint, "model.endpoint");
  if (/^(?:unix|http\+unix):/i.test(endpoint)) {
    throw new SandboxRefusal(
      "model-endpoint-socket",
      'Sandbox config field "model.endpoint" is a Unix socket, which the sandbox cannot check or reach yet. Serve the model on a loopback address such as http://127.0.0.1:11434.',
    );
  }
  let endpointUrl: URL;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new FieldError("model.endpoint", "must be an http or https URL, such as http://127.0.0.1:11434.");
  }
  if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
    throw new FieldError("model.endpoint", "must be an http or https URL, such as http://127.0.0.1:11434.");
  }
  if (endpointUrl.username || endpointUrl.password) throw new FieldError("model.endpoint", "must not contain a user name or password.");
  const modelName = string(model.model, "model.model");
  let timeoutSeconds: number | undefined;
  if (model.timeoutSeconds !== undefined) {
    timeoutSeconds = integer(model.timeoutSeconds, "model.timeoutSeconds", 30, 3_600);
  }

  const dataDir = filePath(root.dataDir, "dataDir", base);
  const secretsPath = root.secretsFile === undefined ? join(base, "secrets.json") : filePath(root.secretsFile, "secretsFile", base);
  const runDeadlineSeconds = root.runDeadlineSeconds === undefined
    ? DEFAULT_RUN_DEADLINE_SECONDS
    : integer(root.runDeadlineSeconds, "runDeadlineSeconds", 60, 6 * 3_600);

  if (!Array.isArray(root.agents) || root.agents.length === 0) {
    throw new FieldError("agents", "must list at least one agent to run.");
  }
  const seen = new Set<string>();
  const agents = root.agents.map((entry, index) => {
    const field = `agents[${index}]`;
    const agent = object(entry, field);
    knownKeys(agent, field, ["id", "templateSha256", "intervalSeconds", "delivery"]);
    const agentId = string(agent.id, `${field}.id`);
    if (!AGENT_ID.test(agentId)) throw new FieldError(`${field}.id`, "must be the id of a bundled agent, such as find-inactive-devices.");
    if (seen.has(agentId)) throw new FieldError(`${field}.id`, `lists ${agentId} a second time. Each agent runs on one schedule.`);
    seen.add(agentId);
    const templateSha256 = string(agent.templateSha256, `${field}.templateSha256`).toLowerCase();
    if (!SHA256.test(templateSha256)) {
      throw new FieldError(`${field}.templateSha256`, "must be the SHA-256 hex of the agent's manifest.yaml, 64 characters. Compute it with sha256sum agents/<id>/manifest.yaml.");
    }
    const intervalSeconds = integer(agent.intervalSeconds, `${field}.intervalSeconds`, MIN_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS);
    return {
      id: agentId,
      templateSha256,
      intervalSeconds,
      ...(agent.delivery !== undefined ? { delivery: parseDelivery(agent.delivery, `${field}.delivery`) } : {}),
    };
  });

  return {
    path,
    sandbox: { id, name },
    organizationId,
    tenantId: tenantId.toLowerCase(),
    clientId: clientId.toLowerCase(),
    certificates,
    model: { provider: model.provider, endpoint, model: modelName, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}) },
    dataDir,
    secretsPath,
    runDeadlineSeconds,
    agents,
  };
}

function parseDelivery(value: unknown, field: string): SandboxDeliveryConfig {
  const delivery = object(value, field);
  const connector = delivery.connector;
  if (connector === "teams" || connector === "outlook") {
    throw new FieldError(
      `${field}.connector`,
      `is ${connector}, which a sandbox cannot send to: it needs a delegated sign-in${connector === "outlook" ? " or Mail.Send, a permission that can change the tenant" : ""}. Use slack or discord.`,
    );
  }
  if (connector !== "slack" && connector !== "discord") {
    throw new FieldError(`${field}.connector`, 'must be "slack" or "discord".');
  }
  const flags = {
    notifyOnSuccess: optionalBoolean(delivery.notifyOnSuccess, `${field}.notifyOnSuccess`, true),
    notifyOnFailure: optionalBoolean(delivery.notifyOnFailure, `${field}.notifyOnFailure`, true),
    failureNotice: optionalBoolean(delivery.failureNotice, `${field}.failureNotice`, false),
  };
  if (connector === "slack") {
    knownKeys(delivery, field, ["connector", "channel", "notifyOnSuccess", "notifyOnFailure", "failureNotice"]);
    const channel = string(delivery.channel, `${field}.channel`);
    if (!/^[A-Z0-9]{8,20}$/.test(channel)) throw new FieldError(`${field}.channel`, "must be a Slack channel ID, such as C0123456789.");
    return { connector, channel, ...flags };
  }
  knownKeys(delivery, field, ["connector", "threadId", "notifyOnSuccess", "notifyOnFailure", "failureNotice"]);
  let threadId: string | undefined;
  if (delivery.threadId !== undefined) {
    threadId = string(delivery.threadId, `${field}.threadId`);
    if (!/^\d{5,25}$/.test(threadId)) throw new FieldError(`${field}.threadId`, "must be a Discord thread ID, digits only.");
  }
  return { connector, ...(threadId ? { threadId } : {}), ...flags };
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new FieldError(field, "must be an object.");
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, field: string, keys: string[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new FieldError(field === "(root)" ? key : `${field}.${key}`, "is not a known setting. Remove it or check the spelling.");
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new FieldError(field, "must be a non-empty string.");
  return value.trim();
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new FieldError(field, "must be a whole number.");
  if (value < min) throw new FieldError(field, `must be at least ${min}${field.endsWith("intervalSeconds") ? " (15 minutes)" : ""}.`);
  if (value > max) throw new FieldError(field, `must be at most ${max}.`);
  return value;
}

function optionalBoolean(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new FieldError(field, "must be true or false.");
  return value;
}

function filePath(value: unknown, field: string, base: string): string {
  const text = string(value, field);
  return isAbsolute(text) ? text : resolve(base, text);
}
