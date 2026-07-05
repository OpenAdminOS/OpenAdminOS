import {
  createTenantSession,
  findConnectorFactory,
  noSecrets,
  runInteractiveFlow,
} from "@openadminos/runtime";
import type {
  AgentDiscordDelivery,
  AgentOutlookDelivery,
  AgentSignalDelivery,
  AgentSlackDelivery,
  AgentSummary,
  AgentTeamsDelivery,
  AgentWhatsAppWebDelivery,
  AppState,
  RunLogLevel,
  RunRecord,
  RunStepStatus,
  SecretAccessor,
  TenantRecord,
  WhatsAppWebSendResult,
} from "@openadminos/agent-sdk";
import type { PublicClientApplication } from "@azure/msal-node";
import { WHATSAPP_WEB_CONNECTOR_ID } from "@openadminos/connector-whatsapp-web";

import {
  createLocalOnlyTenantSession,
  isTerminalRunStatus,
} from "./state-helpers.js";
import {
  OUTLOOK_CONNECTOR_ID,
  SLACK_CONNECTOR_ID,
  DISCORD_CONNECTOR_ID,
  SIGNAL_CONNECTOR_ID,
  RUN_DELIVERY_MAX_ATTEMPTS,
  createDeliveryAuditEntry,
  discordDeliveryTargetLabel,
  evaluateRunDeliveryRule,
  formatChatDeliveryMessage,
  formatDeliveryEmailSubject,
  formatOutlookDeliveryMessage,
  formatPlainDeliveryMessage,
  formatTeamsDeliveryMessage,
  formatWhatsAppDeliveryMessage,
  isRetryableDeliveryError,
  outlookDeliveryTargetLabel,
  readConfigLabel,
  removeEmptyDelivery,
  resolveRunTenant,
  resolveWhatsAppDefaultRecipient,
  retryDelayForAttempt,
  sanitizeDeliveryList,
  sanitizeDiscordDelivery,
  sanitizeOutlookDelivery,
  sanitizeSignalDelivery,
  sanitizeSlackDelivery,
  sanitizeTeamsDelivery,
  sanitizeWhatsAppWebDelivery,
  signalDeliveryTargetLabel,
  slackDeliveryTargetLabel,
  teamsDeliveryTargetLabel,
  whatsAppDeliveryTargetLabel,
  type RunDeliveryConnectorId,
  type RunDeliveryQueueItem,
  type RunDeliveryResult,
} from "./run-delivery-format.js";

export interface RunDeliveryPersistedState {
  installedAgents: AgentSummary[];
  runs: RunRecord[];
  tenants: TenantRecord[];
  activeTenantId?: string;
  connectors?: Record<string, { config: Record<string, unknown> }>;
  runDeliveryQueue?: RunDeliveryQueueItem[];
}

interface WhatsAppWebDeliveryClient {
  sendMessage(input: { to: string; text: string }): Promise<WhatsAppWebSendResult>;
}

export interface RunDeliveryHost {
  read(): Promise<RunDeliveryPersistedState>;
  write(state: RunDeliveryPersistedState): Promise<void>;
  serialize<T>(task: () => Promise<T>): Promise<T>;
  getAppState(): Promise<AppState>;
  getMsalClient(): PublicClientApplication;
  openBrowser(url: string): Promise<void>;
  connectorSecretsFor(connectorId: string): SecretAccessor;
  whatsAppWebClient(): WhatsAppWebDeliveryClient;
  appendRunLog(
    runId: string,
    level: RunLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  appendRunStep(
    runId: string,
    input: {
      label: string;
      status: RunStepStatus;
      detail?: string;
    },
  ): Promise<string>;
  finishRunStep(
    runId: string,
    stepId: string,
    status: Extract<RunStepStatus, "completed" | "failed" | "skipped">,
    detail?: string,
  ): Promise<void>;
}

export class RunDeliveryService {
  private deliveryQueueProcessing: Promise<void> | undefined;

  constructor(private readonly host: RunDeliveryHost) {}

  async updateAgentTeamsDelivery(
    slug: string,
    delivery: AgentTeamsDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeTeamsDelivery(delivery);

    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentTeamsDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, teams: undefined })
          : removeEmptyDelivery({ ...currentDelivery, teams: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.host.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.host.getAppState();
  }

  async updateAgentWhatsAppWebDelivery(
    slug: string,
    delivery: AgentWhatsAppWebDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeWhatsAppWebDelivery(delivery);

    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentWhatsAppWebDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, whatsappWeb: undefined })
          : removeEmptyDelivery({ ...currentDelivery, whatsappWeb: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.host.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.host.getAppState();
  }

  async updateAgentOutlookDelivery(
    slug: string,
    delivery: AgentOutlookDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeOutlookDelivery(delivery);

    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentOutlookDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, outlook: undefined })
          : removeEmptyDelivery({ ...currentDelivery, outlook: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.host.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.host.getAppState();
  }

  async updateAgentSlackDelivery(
    slug: string,
    delivery: AgentSlackDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeSlackDelivery(delivery);

    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentSlackDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, slack: undefined })
          : removeEmptyDelivery({ ...currentDelivery, slack: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.host.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.host.getAppState();
  }

  async updateAgentDiscordDelivery(
    slug: string,
    delivery: AgentDiscordDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeDiscordDelivery(delivery);

    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentDiscordDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, discord: undefined })
          : removeEmptyDelivery({ ...currentDelivery, discord: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.host.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.host.getAppState();
  }

  async updateAgentSignalDelivery(
    slug: string,
    delivery: AgentSignalDelivery | null,
  ): Promise<AppState> {
    const sanitized =
      delivery === null ? null : sanitizeSignalDelivery(delivery);

    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const idx = persisted.installedAgents.findIndex(
        (agent) => agent.slug === slug || agent.id === slug,
      );
      if (idx < 0) {
        throw new Error(`updateAgentSignalDelivery: agent "${slug}" is not installed.`);
      }
      const existing = persisted.installedAgents[idx];
      const nextAgents = [...persisted.installedAgents];
      const currentDelivery = existing.delivery ?? {};
      const nextDelivery =
        sanitized === null
          ? removeEmptyDelivery({ ...currentDelivery, signal: undefined })
          : removeEmptyDelivery({ ...currentDelivery, signal: sanitized });
      nextAgents[idx] = {
        ...existing,
        ...(nextDelivery ? { delivery: nextDelivery } : { delivery: undefined }),
      };
      await this.host.write({ ...persisted, installedAgents: nextAgents });
    });

    return this.host.getAppState();
  }

  async processPendingRunDeliveries(): Promise<void> {
    if (this.deliveryQueueProcessing) return this.deliveryQueueProcessing;
    this.deliveryQueueProcessing = this.processRunDeliveryQueue().finally(() => {
      this.deliveryQueueProcessing = undefined;
    });
    return this.deliveryQueueProcessing;
  }

  async enqueueRunDeliveries(run: RunRecord): Promise<void> {
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    if (!agent) return;
    const connectorIds: RunDeliveryConnectorId[] = [];
    if (agent.delivery?.teams?.enabled) connectorIds.push("teams");
    if (agent.delivery?.whatsappWeb?.enabled) {
      connectorIds.push(WHATSAPP_WEB_CONNECTOR_ID);
    }
    if (agent.delivery?.outlook?.enabled) connectorIds.push(OUTLOOK_CONNECTOR_ID);
    if (agent.delivery?.slack?.enabled) connectorIds.push(SLACK_CONNECTOR_ID);
    if (agent.delivery?.discord?.enabled) connectorIds.push(DISCORD_CONNECTOR_ID);
    if (agent.delivery?.signal?.enabled) connectorIds.push(SIGNAL_CONNECTOR_ID);
    if (connectorIds.length === 0) return;

    const now = new Date().toISOString();
    await this.host.serialize(async () => {
      const current = await this.host.read();
      const existing = current.runDeliveryQueue ?? [];
      const existingIds = new Set(existing.map((item) => item.id));
      const additions = connectorIds
        .map((connectorId): RunDeliveryQueueItem => ({
          id: `${run.id}:${connectorId}`,
          runId: run.id,
          connectorId,
          attempts: 0,
          createdAt: now,
          nextAttemptAt: now,
        }))
        .filter((item) => !existingIds.has(item.id));
      if (additions.length === 0) return;
      await this.host.write({
        ...current,
        runDeliveryQueue: [...existing, ...additions],
      });
    });
  }

  private async processRunDeliveryQueue(): Promise<void> {
    for (;;) {
      const item = await this.claimDueRunDelivery();
      if (!item) return;
      const result = await this.processRunDeliveryItem(item);
      if (result.retryable && item.attempts < RUN_DELIVERY_MAX_ATTEMPTS) {
        await this.rescheduleRunDelivery(item, result.error);
      } else {
        await this.removeRunDelivery(item.id);
      }
    }
  }

  private async claimDueRunDelivery(): Promise<RunDeliveryQueueItem | undefined> {
    const now = new Date();
    let claimed: RunDeliveryQueueItem | undefined;
    await this.host.serialize(async () => {
      const current = await this.host.read();
      const queue = current.runDeliveryQueue ?? [];
      const index = queue.findIndex((item) => {
        if (item.attempts >= RUN_DELIVERY_MAX_ATTEMPTS) return false;
        const dueAt = new Date(item.nextAttemptAt).getTime();
        return !Number.isFinite(dueAt) || dueAt <= now.getTime();
      });
      if (index < 0) return;
      const item = queue[index];
      if (!item) return;
      const attempts = item.attempts + 1;
      const claimedItem: RunDeliveryQueueItem = {
        ...item,
        attempts,
        lastAttemptAt: now.toISOString(),
        nextAttemptAt: new Date(
          now.getTime() + retryDelayForAttempt(attempts),
        ).toISOString(),
      };
      const nextQueue = [...queue];
      nextQueue[index] = claimedItem;
      claimed = claimedItem;
      await this.host.write({ ...current, runDeliveryQueue: nextQueue });
    });
    return claimed;
  }

  private async processRunDeliveryItem(
    item: RunDeliveryQueueItem,
  ): Promise<RunDeliveryResult> {
    const persisted = await this.host.read();
    const run = persisted.runs.find((candidate) => candidate.id === item.runId);
    if (!run || !isTerminalRunStatus(run.status)) {
      return { retryable: false };
    }
    try {
      switch (item.connectorId) {
        case "teams":
          return await this.deliverRunToTeams(run);
        case WHATSAPP_WEB_CONNECTOR_ID:
          return await this.deliverRunToWhatsAppWeb(run);
        case OUTLOOK_CONNECTOR_ID:
          return await this.deliverRunToOutlook(run);
        case SLACK_CONNECTOR_ID:
          return await this.deliverRunToSlack(run);
        case DISCORD_CONNECTOR_ID:
          return await this.deliverRunToDiscord(run);
        case SIGNAL_CONNECTOR_ID:
          return await this.deliverRunToSignal(run);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.host.appendRunLog(
        item.runId,
        "warn",
        `Run delivery failed: ${message}`,
      );
      return { retryable: true, error: message };
    }
  }

  private async rescheduleRunDelivery(
    item: RunDeliveryQueueItem,
    error?: string,
  ): Promise<void> {
    await this.host.serialize(async () => {
      const current = await this.host.read();
      const nextQueue = (current.runDeliveryQueue ?? []).map((queued) =>
        queued.id === item.id
          ? {
              ...queued,
              attempts: item.attempts,
              nextAttemptAt: item.nextAttemptAt,
              ...(item.lastAttemptAt ? { lastAttemptAt: item.lastAttemptAt } : {}),
              ...(error ? { lastError: error } : {}),
            }
          : queued,
      );
      await this.host.write({ ...current, runDeliveryQueue: nextQueue });
    });
  }

  private async removeRunDelivery(id: string): Promise<void> {
    await this.host.serialize(async () => {
      const current = await this.host.read();
      const nextQueue = (current.runDeliveryQueue ?? []).filter(
        (item) => item.id !== id,
      );
      const nextState: RunDeliveryPersistedState = { ...current };
      if (nextQueue.length > 0) {
        nextState.runDeliveryQueue = nextQueue;
      } else {
        delete nextState.runDeliveryQueue;
      }
      await this.host.write(nextState);
    });
  }

  private async deliverRunToTeams(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.teams;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Microsoft Teams");
    if (!evaluation.shouldSend) {
      await this.host.appendRunStep(run.id, {
        label: "Microsoft Teams notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.host.appendRunLog(
        run.id,
        "info",
        `Teams delivery skipped: ${evaluation.detail}`,
        { connectorId: "teams" },
      );
      return { retryable: false };
    }

    const tenantId = run.tenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((candidate) => candidate.id === tenantId)
      : undefined;
    const baseConfig = persisted.connectors?.teams?.config ?? {};
    const targetLabel = teamsDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.host.appendRunStep(run.id, {
      label: "Send run report to Microsoft Teams",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!tenant) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No tenant session was available for Microsoft Teams delivery.",
      );
      await this.host.appendRunLog(run.id, "warn", "Teams delivery failed: no tenant session available.", {
        connectorId: "teams",
      });
      return {
        retryable: false,
        error: "No tenant session was available for Microsoft Teams delivery.",
      };
    }

    const factory = findConnectorFactory("teams");
    if (!factory) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Microsoft Teams connector is not registered.",
      );
      await this.host.appendRunLog(run.id, "warn", "Teams delivery failed: Teams connector is not registered.", {
        connectorId: "teams",
      });
      return {
        retryable: false,
        error: "Microsoft Teams connector is not registered.",
      };
    }

    const config =
      delivery?.useDefaultTarget === false
        ? {
            ...baseConfig,
            ...(delivery.teamId ? { defaultTeamId: delivery.teamId } : {}),
            ...(delivery.channelId ? { defaultChannelId: delivery.channelId } : {}),
            ...(delivery.teamName ? { defaultTeamName: delivery.teamName } : {}),
            ...(delivery.channelName ? { defaultChannelName: delivery.channelName } : {}),
          }
        : baseConfig;

    const client = this.host.getMsalClient();
    const openBrowser = this.host.openBrowser;
    const tenantSession = createTenantSession({
      client,
      tenantId: tenant.id,
      username: tenant.username,
      homeAccountId: tenant.homeAccountId,
      acquireInteractive: async (scopes) =>
        runInteractiveFlow({ client, scopes, openBrowser }),
    });

    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: tenantSession,
        config,
        secrets: noSecrets,
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:teams-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        postChannelMessage?: (args: {
          teamId?: string;
          channelId?: string;
          markdown: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.postChannelMessage !== "function") {
        throw new Error("Teams connector does not expose postChannelMessage.");
      }
      const markdown = formatTeamsDeliveryMessage(run, agent, tenant);
      const auditStartedAt = Date.now();
      const result = await capabilities.postChannelMessage({
        ...(delivery?.useDefaultTarget === false && delivery.teamId
          ? { teamId: delivery.teamId }
          : {}),
        ...(delivery?.useDefaultTarget === false && delivery.channelId
          ? { channelId: delivery.channelId }
          : {}),
        markdown,
      });
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: "teams",
        capability: "post-channel-message@1",
        idempotencyKey: `${run.id}:${stepId}:post-channel-message:0`,
        egressTarget: targetLabel,
        args: { target: targetLabel, markdown },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.host.appendRunLog(run.id, "info", "Run report delivered to Microsoft Teams.", {
        connectorId: "teams",
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: "teams",
        capability: "post-channel-message@1",
        idempotencyKey: `${run.id}:${stepId}:post-channel-message:0`,
        egressTarget: targetLabel,
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Microsoft Teams delivery failed: ${message}`,
      );
      await this.host.appendRunLog(
        run.id,
        "warn",
        `Teams delivery failed: ${message}`,
        {
          connectorId: "teams",
          connectorAudit: audit as unknown as Record<string, unknown>,
        },
      );
      return { retryable: true, error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToWhatsAppWeb(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.whatsappWeb;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "WhatsApp");
    if (!evaluation.shouldSend) {
      await this.host.appendRunStep(run.id, {
        label: "WhatsApp notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.host.appendRunLog(
        run.id,
        "info",
        `WhatsApp delivery skipped: ${evaluation.detail}`,
        { connectorId: WHATSAPP_WEB_CONNECTOR_ID },
      );
      return { retryable: false };
    }

    const config = persisted.connectors?.[WHATSAPP_WEB_CONNECTOR_ID]?.config ?? {};
    const recipient =
      delivery.useDefaultRecipient === false
        ? delivery.recipient
        : resolveWhatsAppDefaultRecipient(config);
    const targetLabel = whatsAppDeliveryTargetLabel(delivery, config);
    const stepId = await this.host.appendRunStep(run.id, {
      label: "Send run report to WhatsApp",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!recipient) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No WhatsApp notification target is configured.",
      );
      await this.host.appendRunLog(
        run.id,
        "warn",
        "WhatsApp delivery failed: no target configured.",
        { connectorId: WHATSAPP_WEB_CONNECTOR_ID },
      );
      return {
        retryable: false,
        error: "No WhatsApp notification target is configured.",
      };
    }

    const tenantId = run.tenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((candidate) => candidate.id === tenantId)
      : undefined;

    try {
      const text = formatWhatsAppDeliveryMessage(run, agent, tenant);
      const auditStartedAt = Date.now();
      const result = await this.host.whatsAppWebClient().sendMessage({
        to: recipient,
        text,
      });
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: WHATSAPP_WEB_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `${WHATSAPP_WEB_CONNECTOR_ID}:to=redacted`,
        args: { to: "redacted", text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.host.appendRunLog(
        run.id,
        "info",
        "Run report delivered to WhatsApp Web.",
        {
          connectorId: WHATSAPP_WEB_CONNECTOR_ID,
          messageId: result.messageId,
          connectorAudit: audit as unknown as Record<string, unknown>,
        },
      );
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: WHATSAPP_WEB_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `${WHATSAPP_WEB_CONNECTOR_ID}:to=redacted`,
        args: { to: "redacted" },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        `WhatsApp delivery failed: ${message}`,
      );
      await this.host.appendRunLog(
        run.id,
        "warn",
        `WhatsApp delivery failed: ${message}`,
        {
          connectorId: WHATSAPP_WEB_CONNECTOR_ID,
          connectorAudit: audit as unknown as Record<string, unknown>,
        },
      );
      return { retryable: true, error: message };
    }
  }

  private async deliverRunToOutlook(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.outlook;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Outlook");
    if (!evaluation.shouldSend) {
      await this.host.appendRunStep(run.id, {
        label: "Outlook notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.host.appendRunLog(run.id, "info", `Outlook delivery skipped: ${evaluation.detail}`, {
        connectorId: OUTLOOK_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const tenantId = run.tenantId ?? persisted.activeTenantId;
    const tenant = tenantId
      ? persisted.tenants.find((candidate) => candidate.id === tenantId)
      : undefined;
    const baseConfig = persisted.connectors?.[OUTLOOK_CONNECTOR_ID]?.config ?? {};
    const recipients =
      delivery.useDefaultRecipients === false
        ? sanitizeDeliveryList(delivery.recipients)
        : undefined;
    const targetLabel = outlookDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.host.appendRunStep(run.id, {
      label: "Send run report by Outlook email",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!tenant) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No tenant session was available for Outlook delivery.",
      );
      await this.host.appendRunLog(run.id, "warn", "Outlook delivery failed: no tenant session available.", {
        connectorId: OUTLOOK_CONNECTOR_ID,
      });
      return {
        retryable: false,
        error: "No tenant session was available for Outlook delivery.",
      };
    }
    if (delivery.useDefaultRecipients === false && (!recipients || recipients.length === 0)) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No Outlook notification recipients are configured.",
      );
      await this.host.appendRunLog(
        run.id,
        "warn",
        "Outlook delivery failed: no recipients configured.",
        { connectorId: OUTLOOK_CONNECTOR_ID },
      );
      return {
        retryable: false,
        error: "No Outlook notification recipients are configured.",
      };
    }

    const factory = findConnectorFactory(OUTLOOK_CONNECTOR_ID);
    if (!factory) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Outlook connector is not registered.",
      );
      await this.host.appendRunLog(run.id, "warn", "Outlook delivery failed: connector is not registered.", {
        connectorId: OUTLOOK_CONNECTOR_ID,
      });
      return { retryable: false, error: "Outlook connector is not registered." };
    }

    const client = this.host.getMsalClient();
    const openBrowser = this.host.openBrowser;
    const tenantSession = createTenantSession({
      client,
      tenantId: tenant.id,
      username: tenant.username,
      homeAccountId: tenant.homeAccountId,
      acquireInteractive: async (scopes) =>
        runInteractiveFlow({ client, scopes, openBrowser }),
    });

    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: tenantSession,
        config: baseConfig,
        secrets: this.host.connectorSecretsFor(OUTLOOK_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:outlook-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMail?: (args: {
          to?: string[];
          subject: string;
          markdown: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMail !== "function") {
        throw new Error("Outlook connector does not expose sendMail.");
      }
      const markdown = formatOutlookDeliveryMessage(run, agent, tenant);
      const subject = formatDeliveryEmailSubject(run, agent);
      const idempotencyKey = `${run.id}:${stepId}:send-mail:0`;
      const args: {
        to?: string[];
        subject: string;
        markdown: string;
        idempotencyKey: string;
      } = { subject, markdown, idempotencyKey };
      if (recipients && recipients.length > 0) args.to = recipients;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMail(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: OUTLOOK_CONNECTOR_ID,
        capability: "send-mail@1",
        idempotencyKey,
        egressTarget: "outlook:recipients=redacted",
        args: { target: targetLabel, subject, markdown },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.host.appendRunLog(run.id, "info", "Run report delivered by Outlook.", {
        connectorId: OUTLOOK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: OUTLOOK_CONNECTOR_ID,
        capability: "send-mail@1",
        idempotencyKey: `${run.id}:${stepId}:send-mail:0`,
        egressTarget: "outlook:recipients=redacted",
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Outlook delivery failed: ${message}`,
      );
      await this.host.appendRunLog(run.id, "warn", `Outlook delivery failed: ${message}`, {
        connectorId: OUTLOOK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToSlack(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.slack;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Slack");
    if (!evaluation.shouldSend) {
      await this.host.appendRunStep(run.id, {
        label: "Slack notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.host.appendRunLog(run.id, "info", `Slack delivery skipped: ${evaluation.detail}`, {
        connectorId: SLACK_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const baseConfig = persisted.connectors?.[SLACK_CONNECTOR_ID]?.config ?? {};
    const channel =
      delivery.useDefaultChannel === false ? delivery.channel?.trim() : undefined;
    const defaultChannel = readConfigLabel(baseConfig, "defaultChannel");
    const targetLabel = slackDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.host.appendRunStep(run.id, {
      label: "Send run report to Slack",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (delivery.useDefaultChannel === false && !channel) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No Slack notification channel is configured.",
      );
      await this.host.appendRunLog(run.id, "warn", "Slack delivery failed: no channel configured.", {
        connectorId: SLACK_CONNECTOR_ID,
      });
      return { retryable: false, error: "No Slack notification channel is configured." };
    }
    if (delivery.useDefaultChannel !== false && !defaultChannel) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No default Slack notification channel is configured.",
      );
      await this.host.appendRunLog(
        run.id,
        "warn",
        "Slack delivery failed: no default channel configured.",
        { connectorId: SLACK_CONNECTOR_ID },
      );
      return {
        retryable: false,
        error: "No default Slack notification channel is configured.",
      };
    }

    const factory = findConnectorFactory(SLACK_CONNECTOR_ID);
    if (!factory) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Slack connector is not registered.",
      );
      await this.host.appendRunLog(run.id, "warn", "Slack delivery failed: connector is not registered.", {
        connectorId: SLACK_CONNECTOR_ID,
      });
      return { retryable: false, error: "Slack connector is not registered." };
    }

    const tenant = resolveRunTenant(persisted, run);
    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: createLocalOnlyTenantSession(),
        config: baseConfig,
        secrets: this.host.connectorSecretsFor(SLACK_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:slack-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMessage?: (args: {
          channel?: string;
          text: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMessage !== "function") {
        throw new Error("Slack connector does not expose sendMessage.");
      }
      const text = formatChatDeliveryMessage(run, agent, tenant);
      const idempotencyKey = `${run.id}:${stepId}:send-message:0`;
      const args: { channel?: string; text: string; idempotencyKey: string } = {
        text,
        idempotencyKey,
      };
      if (channel) args.channel = channel;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMessage(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SLACK_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey,
        egressTarget: `slack:${targetLabel}`,
        args: { target: targetLabel, text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.host.appendRunLog(run.id, "info", "Run report delivered to Slack.", {
        connectorId: SLACK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SLACK_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `slack:${targetLabel}`,
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Slack delivery failed: ${message}`,
      );
      await this.host.appendRunLog(run.id, "warn", `Slack delivery failed: ${message}`, {
        connectorId: SLACK_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToDiscord(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.discord;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Discord");
    if (!evaluation.shouldSend) {
      await this.host.appendRunStep(run.id, {
        label: "Discord notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.host.appendRunLog(run.id, "info", `Discord delivery skipped: ${evaluation.detail}`, {
        connectorId: DISCORD_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const baseConfig = persisted.connectors?.[DISCORD_CONNECTOR_ID]?.config ?? {};
    const threadId =
      delivery.useDefaultWebhook === false ? delivery.threadId?.trim() : undefined;
    const targetLabel = discordDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.host.appendRunStep(run.id, {
      label: "Send run report to Discord",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    const factory = findConnectorFactory(DISCORD_CONNECTOR_ID);
    if (!factory) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Discord connector is not registered.",
      );
      await this.host.appendRunLog(
        run.id,
        "warn",
        "Discord delivery failed: connector is not registered.",
        { connectorId: DISCORD_CONNECTOR_ID },
      );
      return { retryable: false, error: "Discord connector is not registered." };
    }

    const tenant = resolveRunTenant(persisted, run);
    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: createLocalOnlyTenantSession(),
        config: baseConfig,
        secrets: this.host.connectorSecretsFor(DISCORD_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:discord-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMessage?: (args: {
          text: string;
          threadId?: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMessage !== "function") {
        throw new Error("Discord connector does not expose sendMessage.");
      }
      const text = formatChatDeliveryMessage(run, agent, tenant);
      const idempotencyKey = `${run.id}:${stepId}:send-message:0`;
      const args: { text: string; threadId?: string; idempotencyKey: string } = {
        text,
        idempotencyKey,
      };
      if (threadId) args.threadId = threadId;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMessage(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: DISCORD_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey,
        egressTarget: `discord:${targetLabel}`,
        args: { target: targetLabel, text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.host.appendRunLog(run.id, "info", "Run report delivered to Discord.", {
        connectorId: DISCORD_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: DISCORD_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: `discord:${targetLabel}`,
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Discord delivery failed: ${message}`,
      );
      await this.host.appendRunLog(run.id, "warn", `Discord delivery failed: ${message}`, {
        connectorId: DISCORD_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }

  private async deliverRunToSignal(run: RunRecord): Promise<RunDeliveryResult> {
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find(
      (candidate) => candidate.slug === run.agentSlug || candidate.id === run.agentSlug,
    );
    const delivery = agent?.delivery?.signal;
    if (!agent || !delivery?.enabled) return { retryable: false };

    const evaluation = evaluateRunDeliveryRule(run, delivery, "Signal");
    if (!evaluation.shouldSend) {
      await this.host.appendRunStep(run.id, {
        label: "Signal notification not sent",
        status: "skipped",
        detail: evaluation.detail,
      });
      await this.host.appendRunLog(run.id, "info", `Signal delivery skipped: ${evaluation.detail}`, {
        connectorId: SIGNAL_CONNECTOR_ID,
      });
      return { retryable: false };
    }

    const baseConfig = persisted.connectors?.[SIGNAL_CONNECTOR_ID]?.config ?? {};
    const recipient =
      delivery.useDefaultRecipient === false
        ? delivery.recipient?.trim()
        : readConfigLabel(baseConfig, "defaultRecipient");
    const targetLabel = signalDeliveryTargetLabel(delivery, baseConfig);
    const stepId = await this.host.appendRunStep(run.id, {
      label: "Send run report to Signal",
      status: "running",
      detail: `${evaluation.detail} Target: ${targetLabel}.`,
    });

    if (!recipient) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "No Signal notification recipient is configured.",
      );
      await this.host.appendRunLog(
        run.id,
        "warn",
        "Signal delivery failed: no recipient configured.",
        { connectorId: SIGNAL_CONNECTOR_ID },
      );
      return { retryable: false, error: "No Signal notification recipient is configured." };
    }

    const factory = findConnectorFactory(SIGNAL_CONNECTOR_ID);
    if (!factory) {
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        "Signal connector is not registered.",
      );
      await this.host.appendRunLog(run.id, "warn", "Signal delivery failed: connector is not registered.", {
        connectorId: SIGNAL_CONNECTOR_ID,
      });
      return { retryable: false, error: "Signal connector is not registered." };
    }

    const tenant = resolveRunTenant(persisted, run);
    let instance: Awaited<ReturnType<typeof factory.build>> | undefined;
    try {
      instance = await factory.build({
        tenant: createLocalOnlyTenantSession(),
        config: baseConfig,
        secrets: this.host.connectorSecretsFor(SIGNAL_CONNECTOR_ID),
        log: () => undefined,
        idempotencyKeyFor: (stepId, iteration) =>
          `${run.id}:signal-delivery:${stepId}:${iteration}`,
      });
      const capabilities = instance.capabilities as {
        sendMessage?: (args: {
          to?: string;
          text: string;
          idempotencyKey: string;
        }) => Promise<unknown>;
      };
      if (typeof capabilities.sendMessage !== "function") {
        throw new Error("Signal connector does not expose sendMessage.");
      }
      const text = formatPlainDeliveryMessage(run, agent, tenant);
      const idempotencyKey = `${run.id}:${stepId}:send-message:0`;
      const args: { to?: string; text: string; idempotencyKey: string } = {
        text,
        idempotencyKey,
      };
      if (delivery.useDefaultRecipient === false) args.to = recipient;
      const auditStartedAt = Date.now();
      const result = await capabilities.sendMessage(args);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SIGNAL_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey,
        egressTarget: "signal:to=redacted",
        args: { target: targetLabel, text },
        status: "success",
        startedAt: auditStartedAt,
        result,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "completed",
        `Run report sent to ${targetLabel}.`,
      );
      await this.host.appendRunLog(run.id, "info", "Run report delivered to Signal.", {
        connectorId: SIGNAL_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const audit = createDeliveryAuditEntry({
        runId: run.id,
        stepId,
        connector: SIGNAL_CONNECTOR_ID,
        capability: "send-message@1",
        idempotencyKey: `${run.id}:${stepId}:send-message:0`,
        egressTarget: "signal:to=redacted",
        args: { target: targetLabel },
        status: "failure",
        startedAt: Date.now(),
        error,
      });
      await this.host.finishRunStep(
        run.id,
        stepId,
        "failed",
        `Signal delivery failed: ${message}`,
      );
      await this.host.appendRunLog(run.id, "warn", `Signal delivery failed: ${message}`, {
        connectorId: SIGNAL_CONNECTOR_ID,
        connectorAudit: audit as unknown as Record<string, unknown>,
      });
      return { retryable: isRetryableDeliveryError(error), error: message };
    } finally {
      await instance?.dispose().catch(() => undefined);
    }
  }
}
