import { createHash } from "node:crypto";
import {
  ConnectorNotConfiguredError,
  ConnectorValidationError,
  type AgentDiscordDelivery,
  type AgentOutlookDelivery,
  type AgentSignalDelivery,
  type AgentSlackDelivery,
  type AgentSummary,
  type AgentTeamsDelivery,
  type AgentWhatsAppWebDelivery,
  type ConnectorAuditEntry,
  type ConnectorSummary,
  type RunRecord,
  type TenantRecord,
  type WhatsAppWebStatus,
} from "@openadminos/agent-sdk";
import { WHATSAPP_WEB_CONNECTOR_ID } from "@openadminos/connector-whatsapp-web";

interface PersistedState {
  tenants: TenantRecord[];
  activeTenantId?: string;
}



export type RunDeliveryConnectorId =
  | "teams"
  | typeof WHATSAPP_WEB_CONNECTOR_ID
  | typeof OUTLOOK_CONNECTOR_ID
  | typeof SLACK_CONNECTOR_ID
  | typeof DISCORD_CONNECTOR_ID
  | typeof SIGNAL_CONNECTOR_ID;



export interface RunDeliveryQueueItem {
  id: string;
  runId: string;
  connectorId: RunDeliveryConnectorId;
  attempts: number;
  createdAt: string;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  lastError?: string;
}



export interface RunDeliveryResult {
  retryable: boolean;
  error?: string;
}


export const OUTLOOK_CONNECTOR_ID = "outlook" as const;


export const SLACK_CONNECTOR_ID = "slack" as const;


export const DISCORD_CONNECTOR_ID = "discord" as const;


export const SIGNAL_CONNECTOR_ID = "signal" as const;


export const RUN_DELIVERY_MAX_ATTEMPTS = 3;


export const RUN_DELIVERY_RETRY_DELAYS_MS = [30_000, 120_000, 300_000] as const;



export function retryDelayForAttempt(attempts: number): number {
  const fallback =
    RUN_DELIVERY_RETRY_DELAYS_MS[RUN_DELIVERY_RETRY_DELAYS_MS.length - 1] ??
    300_000;
  return (
    RUN_DELIVERY_RETRY_DELAYS_MS[
      Math.min(Math.max(attempts - 1, 0), RUN_DELIVERY_RETRY_DELAYS_MS.length - 1)
    ] ?? fallback
  );
}



export function sanitizeTeamsDelivery(delivery: AgentTeamsDelivery): AgentTeamsDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentTeamsDelivery: delivery must be an object or null.");
  }
  const useDefaultTarget = delivery.useDefaultTarget !== false;
  const sanitized: AgentTeamsDelivery = {
    enabled: delivery.enabled === true,
    useDefaultTarget,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultTarget) {
    if (!delivery.teamId || !delivery.channelId) {
      throw new Error(
        "updateAgentTeamsDelivery: teamId and channelId are required when not using the default Teams channel.",
      );
    }
    sanitized.teamId = delivery.teamId;
    sanitized.channelId = delivery.channelId;
    if (delivery.teamName) sanitized.teamName = delivery.teamName;
    if (delivery.channelName) sanitized.channelName = delivery.channelName;
  }
  return sanitized;
}



export function sanitizeWhatsAppWebDelivery(
  delivery: AgentWhatsAppWebDelivery,
): AgentWhatsAppWebDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error(
      "updateAgentWhatsAppWebDelivery: delivery must be an object or null.",
    );
  }
  const useDefaultRecipient = delivery.useDefaultRecipient !== false;
  const sanitized: AgentWhatsAppWebDelivery = {
    enabled: delivery.enabled === true,
    useDefaultRecipient,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultRecipient) {
    const recipient = delivery.recipient?.trim();
    if (!recipient) {
      throw new Error(
        "updateAgentWhatsAppWebDelivery: recipient is required when not using the default WhatsApp recipient.",
      );
    }
    sanitized.recipient = recipient;
    const type = sanitizeWhatsAppRecipientType(delivery.recipientType, recipient);
    if (type) sanitized.recipientType = type;
    const label = delivery.recipientLabel?.trim();
    sanitized.recipientLabel =
      label && label !== recipient
        ? label
        : type === "self"
          ? "My WhatsApp"
          : type === "group"
            ? "WhatsApp group"
            : "WhatsApp recipient";
  }
  return sanitized;
}



export function sanitizeOutlookDelivery(delivery: AgentOutlookDelivery): AgentOutlookDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentOutlookDelivery: delivery must be an object or null.");
  }
  const useDefaultRecipients = delivery.useDefaultRecipients !== false;
  const sanitized: AgentOutlookDelivery = {
    enabled: delivery.enabled === true,
    useDefaultRecipients,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultRecipients) {
    const recipients = sanitizeDeliveryList(delivery.recipients);
    if (recipients.length === 0) {
      throw new Error(
        "updateAgentOutlookDelivery: recipients are required when not using the default Outlook recipients.",
      );
    }
    sanitized.recipients = recipients;
    const label = delivery.recipientLabel?.trim();
    if (label) sanitized.recipientLabel = label;
  }
  return sanitized;
}



export function sanitizeSlackDelivery(delivery: AgentSlackDelivery): AgentSlackDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentSlackDelivery: delivery must be an object or null.");
  }
  const useDefaultChannel = delivery.useDefaultChannel !== false;
  const sanitized: AgentSlackDelivery = {
    enabled: delivery.enabled === true,
    useDefaultChannel,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultChannel) {
    const channel = delivery.channel?.trim();
    if (!channel) {
      throw new Error(
        "updateAgentSlackDelivery: channel is required when not using the default Slack channel.",
      );
    }
    sanitized.channel = channel;
    const label = delivery.channelLabel?.trim();
    if (label) sanitized.channelLabel = label;
  }
  return sanitized;
}



export function sanitizeDiscordDelivery(delivery: AgentDiscordDelivery): AgentDiscordDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentDiscordDelivery: delivery must be an object or null.");
  }
  const useDefaultWebhook = delivery.useDefaultWebhook !== false;
  const sanitized: AgentDiscordDelivery = {
    enabled: delivery.enabled === true,
    useDefaultWebhook,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultWebhook) {
    const threadId = delivery.threadId?.trim();
    if (threadId) sanitized.threadId = threadId;
    const label = delivery.targetLabel?.trim();
    if (label) sanitized.targetLabel = label;
  }
  return sanitized;
}



export function sanitizeSignalDelivery(delivery: AgentSignalDelivery): AgentSignalDelivery {
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    throw new Error("updateAgentSignalDelivery: delivery must be an object or null.");
  }
  const useDefaultRecipient = delivery.useDefaultRecipient !== false;
  const sanitized: AgentSignalDelivery = {
    enabled: delivery.enabled === true,
    useDefaultRecipient,
    includeManualRuns: delivery.includeManualRuns ?? true,
    includeScheduledRuns: delivery.includeScheduledRuns ?? true,
    notifyOnSuccess: delivery.notifyOnSuccess ?? true,
    notifyOnFailure: delivery.notifyOnFailure ?? false,
    notifyOnChangeOnly: delivery.notifyOnChangeOnly ?? false,
  };
  if (!useDefaultRecipient) {
    const recipient = delivery.recipient?.trim();
    if (!recipient) {
      throw new Error(
        "updateAgentSignalDelivery: recipient is required when not using the default Signal recipient.",
      );
    }
    sanitized.recipient = recipient;
    const label = delivery.recipientLabel?.trim();
    if (label) sanitized.recipientLabel = label;
  }
  return sanitized;
}



export function resolveWhatsAppDefaultRecipient(config: Record<string, unknown>): string {
  const type =
    typeof config.defaultRecipientType === "string"
      ? config.defaultRecipientType
      : undefined;
  if (type === "self") return "self";
  const recipient =
    typeof config.defaultRecipient === "string"
      ? config.defaultRecipient.trim()
      : "";
  return recipient || "self";
}



export function sanitizeWhatsAppRecipientType(
  type: unknown,
  recipient: string,
): AgentWhatsAppWebDelivery["recipientType"] {
  if (type === "self" || type === "group" || type === "manual") return type;
  if (recipient === "self") return "self";
  if (recipient.endsWith("@g.us")) return "group";
  return "manual";
}



export function removeEmptyDelivery(
  delivery: NonNullable<AgentSummary["delivery"]>,
): AgentSummary["delivery"] {
  return delivery.teams ||
    delivery.whatsappWeb ||
    delivery.outlook ||
    delivery.slack ||
    delivery.discord ||
    delivery.signal
    ? delivery
    : undefined;
}



export interface DeliveryRuleSettings {
  includeManualRuns?: boolean;
  includeScheduledRuns?: boolean;
  notifyOnSuccess?: boolean;
  notifyOnFailure?: boolean;
  notifyOnChangeOnly?: boolean;
}



export interface DeliveryRuleEvaluation {
  shouldSend: boolean;
  detail: string;
}



export function evaluateRunDeliveryRule(
  run: RunRecord,
  delivery: DeliveryRuleSettings,
  connectorName: string,
): DeliveryRuleEvaluation {
  const triggerLabel = run.trigger === "schedule" ? "scheduled" : "manual";
  if (run.status !== "completed" && run.status !== "failed") {
    return {
      shouldSend: false,
      detail: `${connectorName} delivery only runs after completed or failed runs.`,
    };
  }
  if (run.trigger === "schedule") {
    if (delivery.includeScheduledRuns === false) {
      return {
        shouldSend: false,
        detail: `${connectorName} delivery is disabled for scheduled runs.`,
      };
    }
    if (delivery.notifyOnChangeOnly === true && run.changeState === "unchanged") {
      return {
        shouldSend: false,
        detail: `${connectorName} delivery is configured only when scheduled findings change; this run was unchanged.`,
      };
    }
  } else if (delivery.includeManualRuns === false) {
    return {
      shouldSend: false,
      detail: `${connectorName} delivery is disabled for manual runs.`,
    };
  }
  if (run.status === "completed" && delivery.notifyOnSuccess === false) {
    return {
      shouldSend: false,
      detail:
        delivery.notifyOnFailure === true
          ? `${connectorName} delivery is configured for failed runs only; this run completed.`
          : `${connectorName} delivery is not configured for completed runs.`,
    };
  }
  if (run.status === "failed" && delivery.notifyOnFailure !== true) {
    return {
      shouldSend: false,
      detail:
        delivery.notifyOnSuccess !== false
          ? `${connectorName} delivery is configured for completed runs only; this run failed.`
          : `${connectorName} delivery is not configured for failed runs.`,
    };
  }
  return {
    shouldSend: true,
    detail: `${connectorName} delivery rule matched this ${triggerLabel} ${run.status} run.`,
  };
}



export function teamsDeliveryTargetLabel(
  delivery: AgentTeamsDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultTarget === false) {
    return formatTeamsTargetLabel(delivery.teamName, delivery.channelName);
  }
  return formatTeamsTargetLabel(
    readConfigLabel(config, "defaultTeamName"),
    readConfigLabel(config, "defaultChannelName"),
  );
}



export function formatTeamsTargetLabel(
  teamName: string | undefined,
  channelName: string | undefined,
): string {
  if (teamName && channelName) return `${teamName} -> #${channelName}`;
  if (channelName) return `#${channelName}`;
  if (teamName) return teamName;
  return "configured Teams channel";
}



export function whatsAppDeliveryTargetLabel(
  delivery: AgentWhatsAppWebDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultRecipient === false) {
    return delivery.recipientLabel?.trim() || "WhatsApp recipient";
  }
  const label = readConfigLabel(config, "defaultRecipientLabel");
  if (label) return label;
  const type = readConfigLabel(config, "defaultRecipientType");
  const recipient = readConfigLabel(config, "defaultRecipient");
  if (type === "self" || !recipient) return "My WhatsApp";
  if (type === "group" || recipient.endsWith("@g.us")) return "WhatsApp group";
  return "WhatsApp recipient";
}



export function outlookDeliveryTargetLabel(
  delivery: AgentOutlookDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultRecipients === false) {
    const label = delivery.recipientLabel?.trim();
    if (label) return label;
    return formatRecipientCount(sanitizeDeliveryList(delivery.recipients), "Outlook");
  }
  const defaultRecipients = sanitizeDeliveryList(
    splitDeliveryList(readConfigLabel(config, "defaultRecipients")),
  );
  return formatRecipientCount(defaultRecipients, "Outlook");
}



export function slackDeliveryTargetLabel(
  delivery: AgentSlackDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultChannel === false) {
    return (
      delivery.channelLabel?.trim() ||
      delivery.channel?.trim() ||
      "Slack channel"
    );
  }
  return (
    readConfigLabel(config, "defaultChannelLabel") ||
    readConfigLabel(config, "defaultChannel") ||
    "default Slack channel"
  );
}



export function discordDeliveryTargetLabel(
  delivery: AgentDiscordDelivery,
  config: Record<string, unknown>,
): string {
  const label = delivery.targetLabel?.trim() || readConfigLabel(config, "defaultTargetLabel");
  if (label) return label;
  const threadId =
    delivery.useDefaultWebhook === false
      ? delivery.threadId?.trim()
      : readConfigLabel(config, "defaultThreadId");
  return threadId ? "Discord webhook thread" : "Discord webhook";
}



export function signalDeliveryTargetLabel(
  delivery: AgentSignalDelivery,
  config: Record<string, unknown>,
): string {
  if (delivery.useDefaultRecipient === false) {
    return delivery.recipientLabel?.trim() || "Signal recipient";
  }
  return readConfigLabel(config, "defaultRecipientLabel") || "Signal recipient";
}



export function formatRecipientCount(values: readonly string[], connectorName: string): string {
  if (values.length === 1) return `1 ${connectorName} recipient`;
  if (values.length > 1) return `${values.length} ${connectorName} recipients`;
  return `default ${connectorName} recipients`;
}



export function splitDeliveryList(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(/[,\n;]/g);
}



export function sanitizeDeliveryList(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}



export function readConfigLabel(
  config: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}



export function createDeliveryAuditEntry(input: {
  runId: string;
  stepId: string;
  connector: string;
  capability: string;
  idempotencyKey: string;
  egressTarget: string;
  args: unknown;
  status: ConnectorAuditEntry["status"];
  startedAt: number;
  result?: unknown;
  error?: unknown;
}): ConnectorAuditEntry {
  const refs = extractConnectorRefs(input.result);
  const errorMessage =
    input.error instanceof Error
      ? input.error.message
      : input.error !== undefined
        ? String(input.error)
        : undefined;
  return {
    runId: input.runId,
    stepId: input.stepId,
    connector: input.connector,
    capability: input.capability,
    kind: "notify",
    idempotencyKey: input.idempotencyKey,
    egressTarget: input.egressTarget,
    argsDigest: digestDeliveryArgs(input.args),
    status: input.status,
    durationMs: Math.max(0, Date.now() - input.startedAt),
    ...(refs.externalId ? { externalId: refs.externalId } : {}),
    ...(refs.externalUrl ? { externalUrl: refs.externalUrl } : {}),
    ...(input.status === "failure" ? { errorClass: "Error" } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}



export function digestDeliveryArgs(args: unknown): string {
  try {
    return createHash("sha256")
      .update(JSON.stringify(args) ?? "null")
      .digest("hex")
      .slice(0, 16);
  } catch {
    return "unhashable";
  }
}



export function extractConnectorRefs(result: unknown): {
  externalId?: string;
  externalUrl?: string;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) return {};
  const obj = result as Record<string, unknown>;
  const externalId =
    typeof obj.messageId === "string"
      ? obj.messageId
      : typeof obj.id === "string"
        ? obj.id
        : undefined;
  const externalUrl =
    typeof obj.webUrl === "string"
      ? obj.webUrl
      : typeof obj.url === "string"
        ? obj.url
        : undefined;
  return {
    ...(externalId ? { externalId } : {}),
    ...(externalUrl ? { externalUrl } : {}),
  };
}



export function formatTeamsDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    `## ${agent.name}`,
    "",
    `**Status:** ${status}`,
    `**Tenant:** ${tenant.displayName}`,
    `**Trigger:** ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `**Queued:** ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`**Finding state:** ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(
      `**Model:** ${run.providerId}${run.model ? ` · ${run.model}` : ""}`,
    );
  }
  if (run.error) {
    lines.push("", "### Error", "", run.error);
  }
  if (run.summary) {
    lines.push("", "### Summary", "", run.summary);
  }
  if (run.steps.length > 0) {
    lines.push("", "### Pipeline", "");
    for (const step of run.steps) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
  }
  return lines.join("\n");
}



export function formatWhatsAppDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord | undefined,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    "*OpenAdminOS run report*",
    "",
    `Agent: ${agent.name}`,
    `Status: ${status}`,
    `Tenant: ${tenant?.displayName ?? run.tenantId ?? "Unknown tenant"}`,
    `Trigger: ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `Queued: ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`Finding state: ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(`Model: ${run.providerId}${run.model ? ` · ${run.model}` : ""}`);
  }
  if (run.error) {
    lines.push("", "*Error*", truncateForDelivery(run.error, 1200));
  }
  if (run.summary) {
    lines.push("", "*Summary*", truncateForDelivery(run.summary, 2400));
  }
  if (run.steps.length > 0) {
    lines.push("", "*Pipeline*");
    for (const step of run.steps.slice(0, 12)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 12) {
      lines.push(`- ${run.steps.length - 12} more steps`);
    }
  }
  return lines.join("\n");
}



export function formatOutlookDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    `## ${agent.name}`,
    "",
    `**Status:** ${status}`,
    `**Tenant:** ${tenant.displayName}`,
    `**Trigger:** ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `**Queued:** ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`**Finding state:** ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(
      `**Model:** ${run.providerId}${run.model ? ` · ${run.model}` : ""}`,
    );
  }
  if (run.error) {
    lines.push("", "### Error", "", truncateForDelivery(run.error, 2000));
  }
  if (run.summary) {
    lines.push("", "### Summary", "", truncateForDelivery(run.summary, 8000));
  }
  if (run.steps.length > 0) {
    lines.push("", "### Pipeline", "");
    for (const step of run.steps.slice(0, 20)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 20) {
      lines.push(`- ${run.steps.length - 20} more steps`);
    }
  }
  return lines.join("\n");
}



export function formatChatDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord | undefined,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    "*OpenAdminOS run report*",
    "",
    `*Agent:* ${agent.name}`,
    `*Status:* ${status}`,
    `*Tenant:* ${tenant?.displayName ?? run.tenantId ?? "Unknown tenant"}`,
    `*Trigger:* ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `*Queued:* ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`*Finding state:* ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(`*Model:* ${run.providerId}${run.model ? ` · ${run.model}` : ""}`);
  }
  if (run.error) {
    lines.push("", "*Error*", truncateForDelivery(run.error, 1200));
  }
  if (run.summary) {
    lines.push("", "*Summary*", truncateForDelivery(run.summary, 2400));
  }
  if (run.steps.length > 0) {
    lines.push("", "*Pipeline*");
    for (const step of run.steps.slice(0, 12)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 12) {
      lines.push(`- ${run.steps.length - 12} more steps`);
    }
  }
  return lines.join("\n");
}



export function formatPlainDeliveryMessage(
  run: RunRecord,
  agent: AgentSummary,
  tenant: TenantRecord | undefined,
): string {
  const status = run.status === "completed" ? "Completed" : "Failed";
  const lines = [
    "OpenAdminOS run report",
    "",
    `Agent: ${agent.name}`,
    `Status: ${status}`,
    `Tenant: ${tenant?.displayName ?? run.tenantId ?? "Unknown tenant"}`,
    `Trigger: ${run.trigger === "schedule" ? "Scheduled" : "Manual"}`,
    `Queued: ${run.queuedAt}`,
  ];
  if (run.changeState) {
    lines.push(`Finding state: ${run.changeState}`);
  }
  if (run.providerId) {
    lines.push(`Model: ${run.providerId}${run.model ? ` · ${run.model}` : ""}`);
  }
  if (run.error) {
    lines.push("", "Error", truncateForDelivery(run.error, 1200));
  }
  if (run.summary) {
    lines.push("", "Summary", truncateForDelivery(run.summary, 2400));
  }
  if (run.steps.length > 0) {
    lines.push("", "Pipeline");
    for (const step of run.steps.slice(0, 12)) {
      lines.push(`- ${step.status}: ${step.label}`);
    }
    if (run.steps.length > 12) {
      lines.push(`- ${run.steps.length - 12} more steps`);
    }
  }
  return lines.join("\n");
}



export function formatDeliveryEmailSubject(run: RunRecord, agent: AgentSummary): string {
  const status = run.status === "completed" ? "completed" : "failed";
  return `OpenAdminOS: ${agent.name} ${status}`;
}



export function resolveRunTenant(
  persisted: PersistedState,
  run: RunRecord,
): TenantRecord | undefined {
  const tenantId = run.tenantId ?? persisted.activeTenantId;
  return tenantId
    ? persisted.tenants.find((candidate) => candidate.id === tenantId)
    : undefined;
}



export function isRetryableDeliveryError(error: unknown): boolean {
  if (
    error instanceof ConnectorNotConfiguredError ||
    error instanceof ConnectorValidationError
  ) {
    return false;
  }
  if (error && typeof error === "object" && "recovery" in error) {
    const recovery = (error as { recovery?: unknown }).recovery;
    if (recovery === "retry") return true;
    if (recovery === "fatal" || recovery === "reconfigure" || recovery === "reauth") {
      return false;
    }
  }
  return true;
}



export function truncateForDelivery(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}



export function whatsappWebStatusToConnectorStatus(
  status: WhatsAppWebStatus,
): ConnectorSummary["status"] {
  if (status.state === "connected") return "connected";
  if (status.state === "error") return "error";
  return "needs-setup";
}



export function fingerprintRunOutput(run: RunRecord): string {
  const source =
    run.result === undefined
      ? run.summary ?? ""
      : stableStringify(run.result);
  return source
    .replace(/\s+/g, " ")
    .replace(/["'`*_#>-]/g, "")
    .trim()
    .toLowerCase();
}



export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
