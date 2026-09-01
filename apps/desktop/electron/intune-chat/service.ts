import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  resolveProviderDefaultModel,
  type AgentSummary,
  type ChatInvestigationMode,
  type ChatInvestigationSettings,
  type DriftTimelineInput,
  type DriftTimelineResult,
  type GraphCacheRefreshResult,
  type GraphCacheRefreshResourceResult,
  type GraphCacheRefreshScheduleSettings,
  type GraphCacheResourceKind,
  type GraphCacheStatus,
  type HostedProviderBatchConsent,
  type IntuneChatConversation,
  type IntuneChatInvestigationToolName,
  type IntuneChatMessage,
  type IntuneChatProgressStep,
  type IntuneChatStreamEvent,
  type IntuneChatStreamStage,
  type LocalDataSummary,
  type MultiTenantAgentBatch,
  type MultiTenantChatJob,
  type MultiTenantChatRunResult,
  type MultiTenantChatStreamEvent,
  type MultiTenantDeviceRow,
  type MultiTenantTenantComparison,
  type PreflightMultiTenantChatInput,
  type ProviderId,
  type ProviderSummary,
  type QueueMultiTenantAgentBatchInput,
  type QueueMultiTenantAgentBatchResult,
  type RefreshGraphCacheOptions,
  type ResetSelfTrainingInput,
  type RunGraphApi,
  type RunLlmApi,
  type RunLogLevel,
  type RunMultiTenantChatInput,
  type RunRecord,
  type SavedMultiTenantQuery,
  type SelfTrainingSettings,
  type SelfTrainingSuggestion,
  type SelfTrainingSuggestionStatus,
  type SendIntuneChatMessageInput,
  type SendIntuneChatMessageResult,
  type SetGraphCacheRefreshScheduleInput,
  type StartRunOptions,
  type TenantGroup,
  type TenantRecord,
  type TenantScopePreflight,
  type TenantSession,
  type WorkspacePromptContextInput,
  type WorkspacePromptContextSummary,
} from "@openadminos/agent-sdk";

import { assertAgentCompatible, withAgentCompatibility } from "../agent-draft-helpers.js";
import {
  assertConversationTenant,
  buildChatProgressSteps,
  buildIntuneChatSources,
  buildIntuneChatSystemPrompt,
  buildMultiTenantDossierMarkdown,
  buildMultiTenantSummary,
  buildSelfTrainingYaml,
  buildTenantComparison,
  emptyMultiTenantSummary,
  estimateChatProgressPercent,
  COUNTABLE_GRAPH_RESOURCES,
  GRAPH_REFRESH_CONCURRENCY,
  fetchGraphCachePages,
  hashTenantId,
  intuneChatProviderBudget,
  isGraphCacheStatusStale,
  isWindowsCompliancePrompt,
  newestRefreshedAt,
  normalizeChatConversationTitle,
  normalizeMultiTenantDeviceRow,
  normalizeTenantGroupName,
  readPlannedChatRows,
  readinessRecovery,
  readinessWarnings,
  resolveTenantGroups,
  resolveTenantScopeIds,
  runWithConcurrency,
  sanitizeGraphResources,
  stableSuggestionId,
  summarizeMultiTenantResult,
  tenantNamesById,
  tenantReadinessStatus,
  trimForPrompt,
  updateJobTenantProgress,
} from "../state-helpers.js";
import { IntelligenceSqliteStore } from "./sqlite-store.js";
import { runAgenticChat } from "./agentic-loop.js";
import {
  GRAPH_CACHE_RESOURCES,
  buildAnswerPack,
  chatTitleForPrompt,
  definitionForResource,
  matchAgentsToQuestion,
  pathForResource,
  planChatContext,
  requiredScopesForResources,
  selfTrainingCandidateFromPrompt,
} from "./planner.js";
import { executeIntuneChatTool, type IntuneChatToolContext } from "./tools.js";

type WorkspacePromptContextPayload = {
  summary: WorkspacePromptContextSummary;
  promptBlock: string;
};

type GraphCacheRefreshProgressEvent =
  | {
      type: "resource-start";
      resource: GraphCacheResourceKind;
      label: string;
      completed: number;
      total: number;
    }
  | {
      type: "resource-complete";
      result: GraphCacheRefreshResourceResult;
      completed: number;
      total: number;
    };

export interface ChatPersistedState {
  activeProviderId: ProviderId;
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
  installedAgents: AgentSummary[];
  tenants: TenantRecord[];
  activeTenantId?: string;
}

export interface ChatServiceHost {
  read(): Promise<ChatPersistedState>;
  requireIntelligenceStore(): IntelligenceSqliteStore;
  resolveTenant(persisted: ChatPersistedState, tenantId?: string): TenantRecord;
  listProviders(): Promise<ProviderSummary[]>;
  buildLlm(providerId: ProviderId, model: string | undefined): Promise<RunLlmApi>;
  buildGraph(
    pinnedTenantId?: string,
    agentScopes?: string[],
  ): Promise<{
    createGraph: (
      log: (
        level: RunLogLevel,
        message: string,
        metadata?: Record<string, unknown>,
      ) => void,
    ) => RunGraphApi;
    tenantId: string;
    tenantSession: TenantSession;
  }>;
  startRun(agentSlug: string, options?: StartRunOptions): Promise<RunRecord>;
  getDriftTimeline(input: DriftTimelineInput): Promise<DriftTimelineResult>;
  /**
   * Passages from the local documentation index for this question, with
   * their source paths. Returns [] when no index is installed, so the
   * answer degrades to tenant-data-only rather than failing.
   */
  retrieveDocumentation?(query: string): Promise<
    Array<{ file: string; title?: string; text: string; score: number }>
  >;
  readonly appVersion: string;
  readonly userDataPath: string | undefined;
  readonly intelligenceStore: IntelligenceSqliteStore | undefined;
  readonly graphFactory:
    | ((input: {
        tenantId: string;
        scopes: string[];
        log: (
          level: RunLogLevel,
          message: string,
          metadata?: Record<string, unknown>,
        ) => void;
      }) => RunGraphApi)
    | undefined;
}

export class IntuneChatService {
  constructor(private readonly host: ChatServiceHost) {}

  private async maybeCreateSelfTrainingSuggestionFromChat(input: {
    tenantId: string;
    question: string;
    agentSuggestions: NonNullable<IntuneChatMessage["agentSuggestions"]>;
  }): Promise<void> {
    const store = this.host.requireIntelligenceStore();
    const settings = store.getSelfTrainingSettings();
    if (!settings.enabled) return;
    const candidate = selfTrainingCandidateFromPrompt(input);
    if (!candidate) return;
    const now = new Date().toISOString();
    const id = stableSuggestionId(input.tenantId, candidate.agentSlug, candidate.text);
    store.recordLearningEvent({
      id: `event_${randomUUID()}`,
      tenantId: input.tenantId,
      agentSlug: candidate.agentSlug,
      eventType: "chat.preference-detected",
      source: "chat",
      payload: { question: input.question, candidate },
      createdAt: now,
    });
    store.createSelfTrainingSuggestion({
      id,
      tenantId: input.tenantId,
      agentSlug: candidate.agentSlug,
      status: "pending",
      text: candidate.text,
      reason: candidate.reason,
      source: "chat",
      createdAt: now,
    });
  }

  private async writeSelfTrainingFile(
    tenantId: string,
    agentSlug: string,
  ): Promise<void> {
    if (!this.host.userDataPath) return;
    const store = this.host.requireIntelligenceStore();
    const accepted = store.listAcceptedSelfTrainingSuggestions({ tenantId, agentSlug });
    const tenantKey = hashTenantId(tenantId);
    const dir = join(
      this.host.userDataPath,
      "agent-learning",
      "tenants",
      tenantKey,
      "agents",
      agentSlug,
    );
    await mkdir(dir, { recursive: true });
    const updatedAt = new Date().toISOString();
    const yaml = buildSelfTrainingYaml({
      agentSlug,
      tenantKey,
      updatedAt,
      suggestions: accepted,
    });
    await writeFile(join(dir, "self-training.yaml"), yaml, "utf8");
  }

  selfTrainingPromptOverlay(tenantId: string, agentSlug: string): string | undefined {
    if (!this.host.intelligenceStore) return undefined;
    const settings = this.host.intelligenceStore.getSelfTrainingSettings();
    if (!settings.enabled) return undefined;
    const accepted = this.host.intelligenceStore.listAcceptedSelfTrainingSuggestions({
      tenantId,
      agentSlug,
    });
    if (accepted.length === 0) return undefined;
    return [
      "Approved local self-training instructions for this tenant and agent:",
      ...accepted.map((entry, index) => `${index + 1}. ${entry.text}`),
      "These instructions may guide reasoning and wording only. They do not change scopes, write mode, connector egress, or confirmation policy.",
    ].join("\n");
  }

  recordLearningEventSafely(input: {
    tenantId?: string;
    agentSlug?: string;
    eventType: string;
    source: string;
    payload: unknown;
  }): void {
    if (!this.host.intelligenceStore || !input.tenantId) return;
    try {
      this.host.intelligenceStore.recordLearningEvent({
        id: `event_${randomUUID()}`,
        tenantId: input.tenantId,
        agentSlug: input.agentSlug,
        eventType: input.eventType,
        source: input.source,
        payload: input.payload,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      console.warn("[self-training] failed to record learning event", error);
    }
  }

  private recordHostedProviderConsentSafely(input: {
    tenantIds: string[];
    providerId: ProviderId;
    providerName?: string;
    model?: string;
    acknowledgedAt: string;
    remember?: boolean;
    scope: "single-tenant-chat" | "multi-tenant-chat";
    workspaceContext?: WorkspacePromptContextSummary;
  }): void {
    const primaryTenantId = input.tenantIds[0];
    if (!this.host.intelligenceStore || !primaryTenantId) return;
    try {
      this.host.intelligenceStore.recordHostedProviderConsentAuditEvent({
        id: `event_${randomUUID()}`,
        tenantId: primaryTenantId,
        source: input.scope,
        payload: {
          tenantIds: input.tenantIds,
          providerId: input.providerId,
          ...(input.providerName ? { providerName: input.providerName } : {}),
          ...(input.model ? { model: input.model } : {}),
          acknowledgedAt: input.acknowledgedAt,
          remember: input.remember === true,
          ...(input.workspaceContext
            ? { workspaceContext: input.workspaceContext }
            : {}),
        },
        createdAt: input.acknowledgedAt,
      });
    } catch (error) {
      console.warn("[audit] failed to record hosted-provider consent", error);
    }
  }

  async listIntuneChatConversations(): Promise<IntuneChatConversation[]> {
    return this.host.requireIntelligenceStore().listConversations();
  }

  async searchIntuneChatConversations(query: string): Promise<IntuneChatConversation[]> {
    return this.host.requireIntelligenceStore().searchConversations(query);
  }

  async renameIntuneChatConversation(
    conversationId: string,
    title: string,
  ): Promise<IntuneChatConversation> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    const normalizedTitle = normalizeChatConversationTitle(title);
    return this.host.requireIntelligenceStore().renameConversation(
      conversationId,
      normalizedTitle,
      new Date().toISOString(),
    );
  }

  async setIntuneChatConversationPinned(
    conversationId: string,
    pinned: boolean,
  ): Promise<IntuneChatConversation> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    return this.host.requireIntelligenceStore().setConversationPinned(
      conversationId,
      pinned,
      new Date().toISOString(),
    );
  }

  async deleteIntuneChatConversation(conversationId: string): Promise<void> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    this.host.requireIntelligenceStore().deleteConversation(conversationId);
  }

  async getIntuneChatMessages(conversationId: string): Promise<IntuneChatMessage[]> {
    if (!conversationId.trim()) {
      throw new Error("Conversation id is required.");
    }
    return this.host.requireIntelligenceStore().listMessages(conversationId);
  }

  async listTenantGroups(): Promise<TenantGroup[]> {
    return this.host.requireIntelligenceStore().listTenantGroups();
  }

  async saveTenantGroup(input: {
    id?: string;
    name: string;
    tenantIds: string[];
  }): Promise<TenantGroup> {
    const persisted = await this.host.read();
    const knownTenantIds = new Set(persisted.tenants.map((tenant) => tenant.id));
    const tenantIds = [...new Set(input.tenantIds)].filter((tenantId) => {
      if (!knownTenantIds.has(tenantId)) {
        throw new Error(`Tenant group includes an unknown tenant: ${tenantId}`);
      }
      return true;
    });
    const name = normalizeTenantGroupName(input.name);
    return this.host.requireIntelligenceStore().saveTenantGroup({
      id: input.id?.trim() || `tgrp_${randomUUID()}`,
      name,
      tenantIds,
      now: new Date().toISOString(),
    });
  }

  async deleteTenantGroup(id: string): Promise<void> {
    if (!id.trim()) throw new Error("Tenant group id is required.");
    this.host.requireIntelligenceStore().deleteTenantGroup(id);
  }

  async listSavedMultiTenantQueries(): Promise<SavedMultiTenantQuery[]> {
    return this.host.requireIntelligenceStore().listSavedMultiTenantQueries();
  }

  async preflightMultiTenantIntuneChat(
    input: PreflightMultiTenantChatInput,
  ): Promise<TenantScopePreflight> {
    return this.buildMultiTenantPreflight(input);
  }

  async runMultiTenantIntuneChat(
    input: RunMultiTenantChatInput,
    onEvent?: (event: MultiTenantChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<MultiTenantChatRunResult> {
    const content = input.prompt.trim();
    if (!content) throw new Error("Multi-tenant chat prompt is required.");
    const store = this.host.requireIntelligenceStore();
    const persisted = await this.host.read();
    const preflight = await this.buildMultiTenantPreflight(input);
    const providers = await this.host.listProviders();
    const activeTenant = this.host.resolveTenant(persisted);
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    this.requireHostedBatchConsent(input.hostedProviderConsent, preflight, provider, providerId);
    if (provider?.isLocal === false && input.hostedProviderConsent) {
      this.recordHostedProviderConsentSafely({
        tenantIds: preflight.resolvedTenantIds,
        providerId,
        providerName: preflight.providerName,
        ...(preflight.model ? { model: preflight.model } : {}),
        acknowledgedAt: input.hostedProviderConsent.acknowledgedAt,
        remember: input.hostedProviderConsent.remember,
        scope: "multi-tenant-chat",
      });
    }

    const now = new Date().toISOString();
    const jobId = `mtjob_${randomUUID()}`;
    let job: MultiTenantChatJob = {
      id: jobId,
      prompt: content,
      ...(input.savedQueryId ? { savedQueryId: input.savedQueryId } : {}),
      tenantScope: preflight.tenantScope,
      resolvedTenantIds: preflight.resolvedTenantIds,
      providerId,
      providerName: preflight.providerName,
      providerIsLocal: preflight.providerIsLocal,
      ...(preflight.model ? { model: preflight.model } : {}),
      status: "running",
      createdAt: now,
      updatedAt: now,
      preflight,
      progress: preflight.tenants.map((tenant) => ({
        tenantId: tenant.tenantId,
        tenantName: tenant.tenantName,
        status:
          tenant.status === "expired" ||
          tenant.status === "missing-scopes" ||
          tenant.status === "throttled" ||
          tenant.status === "failed"
            ? "skipped"
            : "queued",
        detail: tenant.recovery,
        updatedAt: now,
      })),
      summary: emptyMultiTenantSummary(),
      comparisons: [],
      deviceRows: [],
      assistantText: "",
      exportDossierMarkdown: "",
    };
    const persistJob = (eventType: "started" | "progress" = "progress") => {
      store.upsertMultiTenantJob(job);
      onEvent?.({ type: eventType, job });
    };
    const assertNotCancelled = () => {
      if (options.signal?.aborted !== true) return;
      job = {
        ...job,
        status: "cancelled",
        error: "Stopped by user.",
        updatedAt: new Date().toISOString(),
      };
      store.upsertMultiTenantJob(job);
      onEvent?.({ type: "cancelled", job });
      throw new Error("Multi-tenant chat run stopped.");
    };
    persistJob("started");

    const runnable = preflight.tenants.filter(
      (tenant) =>
        tenant.selected &&
        tenant.status !== "expired" &&
        tenant.status !== "missing-scopes" &&
        tenant.status !== "throttled" &&
        tenant.status !== "failed" &&
        tenant.status !== "skipped",
    );
    const refreshTenant = async (tenant: (typeof runnable)[number]) => {
      const startedAt = new Date().toISOString();
      job = updateJobTenantProgress(job, tenant.tenantId, {
        status: input.refreshIfStale === false ? "reading-cache" : "refreshing-cache",
        detail:
          input.refreshIfStale === false
            ? "Reading existing local cache."
            : "Refreshing prompt-relevant cache.",
        updatedAt: startedAt,
      });
      persistJob();
      try {
        assertNotCancelled();
        if (input.refreshIfStale !== false && tenant.staleResources.length > 0) {
          const refreshResult = await this.refreshGraphCacheInternal({
            tenantId: tenant.tenantId,
            resources: tenant.staleResources,
          });
          const failedResources = refreshResult.resources.filter((resource) => !resource.ok);
          if (
            failedResources.some((resource) => resource.resource === "managedDevices") ||
            failedResources.length === refreshResult.resources.length
          ) {
            throw new Error(
              failedResources
                .map(
                  (resource) =>
                    `${resource.label}: ${resource.error ?? "Graph cache refresh failed."}`,
                )
                .join("; "),
            );
          }
        }
        job = updateJobTenantProgress(job, tenant.tenantId, {
          status: "building-result",
          detail: "Computing tenant result from local cache.",
          updatedAt: new Date().toISOString(),
        });
        persistJob();
      } catch (error) {
        if (options.signal?.aborted === true) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        job = updateJobTenantProgress(job, tenant.tenantId, {
          status: "failed",
          detail: message,
          updatedAt: new Date().toISOString(),
        });
        persistJob();
      }
    };
    assertNotCancelled();
    await runWithConcurrency(runnable, 2, refreshTenant);
    assertNotCancelled();

    const comparisons: MultiTenantTenantComparison[] = [];
    const deviceRows: MultiTenantDeviceRow[] = [];
    for (const tenant of preflight.tenants) {
      if (!tenant.selected) continue;
      const failedProgress = job.progress.find(
        (entry) => entry.tenantId === tenant.tenantId && entry.status === "failed",
      );
      if (failedProgress) {
        comparisons.push({
          tenantId: tenant.tenantId,
          tenantName: tenant.tenantName,
          status: "failed",
          windowsDevices: 0,
          compliant: 0,
          nonCompliant: 0,
          unknown: 0,
          lastRefresh: tenant.cacheFreshness,
          warnings: [...tenant.warnings, failedProgress.detail ?? "Tenant refresh failed."],
        });
        continue;
      }
      if (!runnable.some((entry) => entry.tenantId === tenant.tenantId)) {
        comparisons.push({
          tenantId: tenant.tenantId,
          tenantName: tenant.tenantName,
          status: tenant.status,
          windowsDevices: 0,
          compliant: 0,
          nonCompliant: 0,
          unknown: 0,
          lastRefresh: tenant.cacheFreshness,
          warnings: tenant.warnings,
        });
        continue;
      }
      const tenantRows = store.readManagedDeviceRowsForTenant({
        tenantId: tenant.tenantId,
        limit: 10_000,
      });
      const normalizedRows = tenantRows
        .map((entry) =>
          normalizeMultiTenantDeviceRow({
            row: entry.row,
            tenantId: tenant.tenantId,
            tenantName: tenant.tenantName,
            sourceRefreshedAt: entry.refreshedAt,
          }),
        )
        .filter((row): row is MultiTenantDeviceRow => Boolean(row));
      const windowsRows = normalizedRows.filter((row) =>
        row.operatingSystem.toLowerCase().includes("windows"),
      );
      deviceRows.push(...windowsRows);
      comparisons.push(buildTenantComparison({
        tenant,
        rows: windowsRows,
      }));
      job = updateJobTenantProgress(job, tenant.tenantId, {
        status: "ready",
        detail: `${windowsRows.length.toLocaleString()} Windows device rows prepared.`,
        updatedAt: new Date().toISOString(),
      });
      persistJob();
    }

    const summary = buildMultiTenantSummary(comparisons);
    const assistantText = await this.buildMultiTenantAssistantText({
      prompt: content,
      providerId,
      provider,
      model: preflight.model,
      summary,
      comparisons,
    });
    const exportDossierMarkdown = buildMultiTenantDossierMarkdown({
      prompt: content,
      providerName: preflight.providerName,
      model: preflight.model,
      generatedAt: new Date().toISOString(),
      summary,
      comparisons,
      rows: deviceRows,
    });
    const finalStatus =
      comparisons.some((comparison) =>
        ["failed", "expired", "missing-scopes", "throttled", "skipped"].includes(
          comparison.status,
        ),
      )
        ? "partial"
        : "completed";
    job = {
      ...job,
      status: finalStatus,
      summary,
      comparisons,
      deviceRows,
      assistantText,
      exportDossierMarkdown,
      updatedAt: new Date().toISOString(),
    };

    const conversation = store.createConversation({
      id: `chat_${randomUUID()}`,
      title: chatTitleForPrompt(content),
      tenantId: activeTenant.id,
      now,
      scopeKind: "multi-tenant",
      tenantScope: preflight.tenantScope,
      multiTenantJobId: job.id,
    });
    job = { ...job, conversationId: conversation.id, updatedAt: new Date().toISOString() };
    persistJob();
    const userMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "user",
      content,
      status: "completed",
      createdAt: now,
    };
    const assistantMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "assistant",
      content: assistantText,
      status: finalStatus === "completed" || finalStatus === "partial" ? "completed" : "failed",
      createdAt: new Date().toISOString(),
      providerId,
      ...(preflight.model ? { model: preflight.model } : {}),
      sources: [
        {
          resource: "managedDevices",
          label: "Intune managed devices",
          rows: deviceRows.length,
          source: "cache",
          path: "/deviceManagement/managedDevices",
        },
      ],
    };
    store.insertMessage(userMessage);
    store.insertMessage(assistantMessage);
    store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);

    const result = {
      job,
      conversation: store.getConversation(conversation.id) ?? conversation,
      userMessage,
      assistantMessage,
    };
    onEvent?.({ type: "completed", result });
    return result;
  }

  async streamMultiTenantIntuneChat(
    input: RunMultiTenantChatInput,
    onEvent: (event: MultiTenantChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<MultiTenantChatRunResult> {
    try {
      return await this.runMultiTenantIntuneChat(input, onEvent, options);
    } catch (caught) {
      if (options.signal?.aborted !== true) {
        onEvent({
          type: "failed",
          error: caught instanceof Error ? caught.message : String(caught),
        });
      }
      throw caught;
    }
  }

  private buildWorkspacePromptContext(
    input: WorkspacePromptContextInput,
    tenantId: string,
    persisted: ChatPersistedState,
  ): WorkspacePromptContextPayload {
    const workspaceId = input.workspaceId.trim();
    if (!workspaceId) throw new Error("Workspace context requires a workspace id.");
    const store = this.host.requireIntelligenceStore();
    const workspace = store.getWorkspace(workspaceId, tenantNamesById(persisted.tenants));
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
    if (workspace.tenantId !== tenantId) {
      throw new Error("Workspace context tenant does not match the active chat tenant.");
    }

    const selectedEvidenceIds = new Set(input.evidenceIds ?? []);
    const selectedNoteIds = new Set(input.noteIds ?? []);
    const evidence =
      selectedEvidenceIds.size > 0
        ? workspace.evidence.filter((entry) => selectedEvidenceIds.has(entry.id))
        : [];
    const notes =
      selectedNoteIds.size > 0
        ? workspace.notes.filter((entry) => selectedNoteIds.has(entry.id))
        : [];
    const includesInstructions =
      input.includeInstructions === true && Boolean(workspace.instructions?.trim());

    if (!includesInstructions && evidence.length === 0 && notes.length === 0) {
      throw new Error("Select workspace evidence, notes, or instructions before attaching context.");
    }

    const missingEvidence = [...selectedEvidenceIds].filter(
      (id) => !workspace.evidence.some((entry) => entry.id === id),
    );
    const missingNotes = [...selectedNoteIds].filter(
      (id) => !workspace.notes.some((entry) => entry.id === id),
    );
    if (missingEvidence.length > 0 || missingNotes.length > 0) {
      throw new Error("Workspace context includes evidence or notes that no longer exist.");
    }

    const lines = [
      "Workspace context attached by the admin.",
      `Workspace: ${workspace.title}`,
      `Tenant: ${workspace.tenantName ?? workspace.tenantId}`,
    ];
    if (includesInstructions && workspace.instructions) {
      lines.push("", "Workspace instructions:", workspace.instructions.trim());
    }
    if (notes.length > 0) {
      lines.push("", "Workspace notes:");
      notes.slice(0, 12).forEach((note, index) => {
        lines.push(`${index + 1}. ${trimForPrompt(note.content, 1400)}`);
      });
    }
    if (evidence.length > 0) {
      lines.push("", "Workspace evidence:");
      evidence.slice(0, 8).forEach((entry, index) => {
        lines.push(
          `${index + 1}. ${entry.title} (${entry.sourceType}, ${entry.createdAt})`,
          trimForPrompt(JSON.stringify(entry.content, null, 2), 2800),
        );
      });
    }

    return {
      summary: {
        workspaceId: workspace.id,
        workspaceTitle: workspace.title,
        tenantId: workspace.tenantId,
        evidenceCount: evidence.length,
        noteCount: notes.length,
        includesInstructions,
      },
      promptBlock: lines.join("\n"),
    };
  }

  async listMultiTenantChatJobs(): Promise<MultiTenantChatJob[]> {
    return this.host.requireIntelligenceStore().listMultiTenantJobs();
  }

  async getMultiTenantChatJob(id: string): Promise<MultiTenantChatJob | undefined> {
    if (!id.trim()) throw new Error("Multi-tenant job id is required.");
    return this.host.requireIntelligenceStore().getMultiTenantJob(id);
  }

  async queueMultiTenantAgentBatch(
    input: QueueMultiTenantAgentBatchInput,
  ): Promise<QueueMultiTenantAgentBatchResult> {
    const agentSlug = input.agentSlug.trim();
    if (!agentSlug) throw new Error("Agent slug is required.");
    const store = this.host.requireIntelligenceStore();
    const persisted = await this.host.read();
    const agent = persisted.installedAgents.find((entry) => entry.slug === agentSlug);
    if (!agent) {
      throw new Error(`Agent is not installed: ${agentSlug}`);
    }
    assertAgentCompatible(withAgentCompatibility(agent, this.host.appVersion), "run");

    const prompt =
      input.prompt?.trim() || `Run ${agent.name} against the selected tenant scope.`;
    const preflight = await this.buildMultiTenantPreflight({
      prompt,
      tenantScope: input.tenantScope,
      ...(input.savedQueryId ? { savedQueryId: input.savedQueryId } : {}),
    });
    const runnable = preflight.tenants.filter(
      (tenant) =>
        tenant.selected &&
        tenant.status !== "expired" &&
        tenant.status !== "missing-scopes" &&
        tenant.status !== "throttled" &&
        tenant.status !== "failed" &&
        tenant.status !== "skipped",
    );
    if (runnable.length === 0) {
      throw new Error("No selected tenants are ready for this agent batch.");
    }

    const now = new Date().toISOString();
    let batch: MultiTenantAgentBatch = {
      id: `mtbatch_${randomUUID()}`,
      agentSlug: agent.slug,
      agentName: agent.name,
      agentMode: agent.mode,
      tenantScope: preflight.tenantScope,
      resolvedTenantIds: runnable.map((tenant) => tenant.tenantId),
      status: "queued",
      runIds: [],
      createdAt: now,
      updatedAt: now,
      preflight,
    };
    store.upsertMultiTenantAgentBatch(batch);

    const runs: RunRecord[] = [];
    const failures: string[] = [];
    for (const tenant of runnable) {
      try {
        const run = await this.host.startRun(agent.slug, {
          tenantId: tenant.tenantId,
          trigger: "manual",
        });
        runs.push(run);
        batch = {
          ...batch,
          status: agent.mode === "write" ? "awaiting-confirmation" : "running",
          runIds: runs.map((entry) => entry.id),
          updatedAt: new Date().toISOString(),
        };
        store.upsertMultiTenantAgentBatch(batch);
      } catch (caught) {
        failures.push(
          `${tenant.tenantName}: ${caught instanceof Error ? caught.message : String(caught)}`,
        );
      }
    }

    const finalStatus =
      failures.length === 0
        ? agent.mode === "write"
          ? "awaiting-confirmation"
          : "running"
        : runs.length > 0
          ? "partial"
          : "failed";
    batch = {
      ...batch,
      status: finalStatus,
      runIds: runs.map((entry) => entry.id),
      ...(failures.length > 0 ? { error: failures.join("; ") } : {}),
      updatedAt: new Date().toISOString(),
    };
    store.upsertMultiTenantAgentBatch(batch);
    return { batch, runs };
  }

  async listMultiTenantAgentBatches(): Promise<MultiTenantAgentBatch[]> {
    return this.host.requireIntelligenceStore().listMultiTenantAgentBatches();
  }

  async getMultiTenantAgentBatch(
    id: string,
  ): Promise<MultiTenantAgentBatch | undefined> {
    if (!id.trim()) throw new Error("Multi-tenant agent batch id is required.");
    return this.host.requireIntelligenceStore().getMultiTenantAgentBatch(id);
  }

  private async buildMultiTenantPreflight(
    input: PreflightMultiTenantChatInput,
  ): Promise<TenantScopePreflight> {
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error("Multi-tenant chat prompt is required.");
    const store = this.host.requireIntelligenceStore();
    const persisted = await this.host.read();
    const activeTenant = this.host.resolveTenant(persisted);
    if (persisted.tenants.length === 0) {
      throw new Error("Connect at least one tenant before using multi-tenant Chat.");
    }
    const groups = store.listTenantGroups();
    const resolvedGroups = resolveTenantGroups(input.tenantScope, groups);
    const resolvedTenantIds = resolveTenantScopeIds({
      scope: input.tenantScope,
      groups: resolvedGroups,
      tenants: persisted.tenants,
      activeTenantId: activeTenant.id,
    });
    const selectedTenantSet = new Set(resolvedTenantIds);
    const savedQuery = input.savedQueryId
      ? store
          .listSavedMultiTenantQueries()
          .find((query) => query.id === input.savedQueryId)
      : undefined;
    const planned = planChatContext(prompt);
    const resourceSet = new Set<GraphCacheResourceKind>([
      ...planned.resources,
      ...(savedQuery?.resourceHints ?? []),
    ]);
    if (isWindowsCompliancePrompt(prompt)) {
      resourceSet.add("managedDevices");
    }
    const resources = sanitizeGraphResources([...resourceSet]);
    const requiredScopes = requiredScopesForResources(resources);
    const providers = await this.host.listProviders();
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    const model = resolveProviderDefaultModel(
      provider,
      persisted.activeModelByProviderId,
    ).model;
    const now = new Date().toISOString();
    const tenants = persisted.tenants
      .filter((tenant) => selectedTenantSet.has(tenant.id))
      .map((tenant) => {
        const statusRows = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
        const relevantStatus = statusRows.filter((status) =>
          resources.includes(status.resource),
        );
        const staleResources = relevantStatus
          .filter((status) => isGraphCacheStatusStale(status))
          .map((status) => status.resource);
        const cacheFreshness = newestRefreshedAt(relevantStatus);
        const errors = relevantStatus
          .map((status) => status.lastError)
          .filter((error): error is string => Boolean(error));
        const missingScopes = errors.some((error) => /scope|consent|permission/i.test(error))
          ? requiredScopes
          : [];
        const status = tenantReadinessStatus({
          missingScopes,
          staleResources,
          errors,
          hasRows: relevantStatus.some((entry) => entry.rows > 0),
        });
        return {
          tenantId: tenant.id,
          tenantName: tenant.displayName,
          username: tenant.username,
          status,
          selected: true,
          cacheFreshness,
          staleResources,
          missingScopes,
          warnings: readinessWarnings({ status, staleResources, errors }),
          recovery: readinessRecovery(status),
        };
      });
    return {
      id: `preflight_${randomUUID()}`,
      prompt,
      tenantScope: input.tenantScope,
      resolvedTenantIds,
      resolvedGroups,
      resources,
      providerId,
      providerName: provider?.name ?? providerId,
      providerIsLocal: provider?.isLocal !== false,
      ...(model ? { model } : {}),
      generatedAt: now,
      tenants,
      canRun:
        tenants.length > 0 &&
        tenants.some((tenant) =>
          tenant.status === "ready" || tenant.status === "stale",
        ),
    };
  }

  private requireHostedBatchConsent(
    consent: HostedProviderBatchConsent | undefined,
    preflight: TenantScopePreflight,
    provider: ProviderSummary | undefined,
    providerId: ProviderId,
  ): void {
    if (provider?.isLocal !== false) return;
    if (!consent) {
      throw new Error(
        "Hosted provider confirmation is required before multi-tenant chat can send tenant context to the selected provider.",
      );
    }
    if (consent.providerId !== providerId) {
      throw new Error("Hosted provider confirmation does not match the selected provider.");
    }
    const expected = new Set(preflight.resolvedTenantIds);
    const acknowledged = new Set(consent.tenantIds);
    for (const tenantId of expected) {
      if (!acknowledged.has(tenantId)) {
        throw new Error("Hosted provider confirmation does not cover every selected tenant.");
      }
    }
    const acknowledgedAt = Date.parse(consent.acknowledgedAt);
    const now = Date.now();
    if (
      !Number.isFinite(acknowledgedAt) ||
      now - acknowledgedAt > 5 * 60 * 1000 ||
      acknowledgedAt - now > 60 * 1000
    ) {
      throw new Error("Hosted provider confirmation expired. Confirm the batch again.");
    }
  }

  private async buildMultiTenantAssistantText(input: {
    prompt: string;
    providerId: ProviderId;
    provider: ProviderSummary | undefined;
    model?: string;
    summary: MultiTenantChatJob["summary"];
    comparisons: MultiTenantChatJob["comparisons"];
  }): Promise<string> {
    const deterministic = summarizeMultiTenantResult(input.summary, input.comparisons);
    const llm = await this.host.buildLlm(input.providerId, input.model);
    if (!llm.available) return deterministic;
    try {
      const completion = await llm.complete({
        system: buildIntuneChatSystemPrompt(input.provider?.isLocal === true),
        prompt: [
          "Summarize this read-only multi-tenant Chat result for an admin.",
          "The JSON table is the source of truth. Mention partial, failed, skipped, or stale tenants.",
          `Question: ${input.prompt}`,
          JSON.stringify(
            {
              summary: input.summary,
              tenants: input.comparisons,
            },
            null,
            2,
          ),
        ].join("\n\n"),
        ...(input.model ? { model: input.model } : {}),
        temperature: 0.2,
        maxTokens: 700,
      });
      return completion.text.trim() || deterministic;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${deterministic}\n\nThe selected LLM provider failed while summarizing this multi-tenant result. ${message}`;
    }
  }

  async getGraphCacheStatus(tenantId?: string): Promise<GraphCacheStatus> {
    const persisted = await this.host.read();
    const resolvedTenant = this.host.resolveTenant(persisted, tenantId);
    const store = this.host.requireIntelligenceStore();
    return {
      tenantId: resolvedTenant.id,
      resources: store.getGraphCacheStatus(
        resolvedTenant.id,
        [...GRAPH_CACHE_RESOURCES],
      ),
      schedule: store.getGraphCacheRefreshSchedule(resolvedTenant.id),
    };
  }

  async getGraphCacheRefreshSchedule(
    tenantId?: string,
  ): Promise<GraphCacheRefreshScheduleSettings> {
    const persisted = await this.host.read();
    const resolvedTenant = this.host.resolveTenant(persisted, tenantId);
    return this.host.requireIntelligenceStore().getGraphCacheRefreshSchedule(
      resolvedTenant.id,
    );
  }

  async setGraphCacheRefreshSchedule(
    input: SetGraphCacheRefreshScheduleInput,
  ): Promise<GraphCacheRefreshScheduleSettings> {
    const persisted = await this.host.read();
    const resolvedTenant = this.host.resolveTenant(persisted, input.tenantId);
    const intervalMinutes =
      typeof input.intervalMinutes === "number" && Number.isFinite(input.intervalMinutes)
        ? input.intervalMinutes
        : 360;
    return this.host.requireIntelligenceStore().setGraphCacheRefreshSchedule({
      tenantId: resolvedTenant.id,
      enabled: input.enabled,
      intervalMinutes,
      now: new Date().toISOString(),
    });
  }

  async getLocalDataSummary(tenantId?: string): Promise<LocalDataSummary> {
    const persisted = await this.host.read();
    const resolvedTenant =
      tenantId || persisted.activeTenantId
        ? this.host.resolveTenant(persisted, tenantId)
        : undefined;
    return this.host.requireIntelligenceStore().getLocalDataSummary({
      tenantId: resolvedTenant?.id,
      definitions: resolvedTenant ? [...GRAPH_CACHE_RESOURCES] : undefined,
    });
  }

  async clearIntuneChatHistory(): Promise<LocalDataSummary> {
    this.host.requireIntelligenceStore().clearChatHistory();
    return this.getLocalDataSummary();
  }

  async clearGraphCache(tenantId?: string): Promise<LocalDataSummary> {
    const persisted = await this.host.read();
    const resolvedTenant = this.host.resolveTenant(persisted, tenantId);
    this.host.requireIntelligenceStore().clearGraphCache(resolvedTenant.id);
    return this.getLocalDataSummary(resolvedTenant.id);
  }

  async refreshGraphCache(
    options: RefreshGraphCacheOptions = {},
  ): Promise<GraphCacheRefreshResult> {
    return this.refreshGraphCacheInternal(options);
  }

  private async refreshGraphCacheInternal(
    options: RefreshGraphCacheOptions = {},
    onProgress?: (event: GraphCacheRefreshProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<GraphCacheRefreshResult> {
    const store = this.host.requireIntelligenceStore();
    const persisted = await this.host.read();
    const tenant = this.host.resolveTenant(persisted, options.tenantId);
    const resources = sanitizeGraphResources(options.resources);
    const scopes = requiredScopesForResources(resources);
    const startedAt = new Date().toISOString();
    const log = (level: RunLogLevel, message: string, metadata?: Record<string, unknown>) => {
      console.info("[intune-chat][graph]", level, message, metadata ?? "");
    };
    const graph = this.host.graphFactory
      ? this.host.graphFactory({ tenantId: tenant.id, scopes, log })
      : (await this.host.buildGraph(tenant.id, scopes)).createGraph(log);
    // Slots are filled by index so the reported order matches the
    // requested order regardless of which refresh finishes first.
    const slots = new Array<GraphCacheRefreshResult["resources"][number] | undefined>(
      resources.length,
    );
    let completed = 0;

    const refreshOne = async (resource: GraphCacheResourceKind, slot: number) => {
      const definition = definitionForResource(resource);
      const request = pathForResource(resource);
      const refreshedAt = new Date().toISOString();
      onProgress?.({
        type: "resource-start",
        resource,
        label: definition.label,
        completed,
        total: resources.length,
      });
      try {
        const query: Record<string, string> = { ...(request.query ?? {}) };
        if (request.select && request.select.length > 0) {
          query.$select = request.select.join(",");
        }
        // Ask Graph for the tenant-wide total alongside the first page.
        // The cache holds at most a thousand rows, so without this a
        // question about a larger collection can only be answered from
        // a sample.
        const headers: Record<string, string> = { ...(request.headers ?? {}) };
        if (COUNTABLE_GRAPH_RESOURCES.has(resource)) {
          query.$count = "true";
          headers.ConsistencyLevel = "eventual";
        }
        const pageResult = await fetchGraphCachePages(
          graph,
          {
            path: request.path,
            query,
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
          },
          signal,
        );
        store.replaceGraphResources({
          tenantId: tenant.id,
          resource,
          label: definition.label,
          scopeSet: definition.scopes,
          rows: pageResult.rows,
          pageCount: pageResult.pages,
          pageLimitReached: pageResult.pageLimitReached,
          ...(pageResult.totalCount !== undefined
            ? { tenantTotal: pageResult.totalCount }
            : {}),
          refreshedAt,
        });
        slots[slot] = {
          resource,
          label: definition.label,
          rows: pageResult.rows.length,
          pages: pageResult.pages,
          pageLimitReached: pageResult.pageLimitReached,
          refreshedAt,
          ok: true,
        };
        completed += 1;
        onProgress?.({
          type: "resource-complete",
          result: slots[slot]!,
          completed,
          total: resources.length,
        });
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        // A 403 on a read resource almost always means the tenant was
        // consented before this permission existed in the requested set.
        // Surface the recovery path instead of the raw Graph body.
        const message = raw.includes("HTTP 403")
          ? `Microsoft Graph denied read access for ${definition.label}. This tenant was likely connected before OpenAdminOS requested ${definition.scopes.join(", ")}. Reconnect the tenant to grant the new read permissions, then refresh again.`
          : raw;
        store.recordGraphResourceError({
          tenantId: tenant.id,
          resource,
          label: definition.label,
          scopeSet: definition.scopes,
          error: message,
          now: refreshedAt,
        });
        slots[slot] = {
          resource,
          label: definition.label,
          rows: 0,
          refreshedAt,
          ok: false,
          error: message,
        };
        completed += 1;
        onProgress?.({
          type: "resource-complete",
          result: slots[slot]!,
          completed,
          total: resources.length,
        });
      }
    };

    // Refreshes used to run strictly one after another, so a question
    // planning a dozen resources waited for a dozen sequential Graph
    // list calls, each of which routinely takes tens of seconds. Graph
    // throttles per resource unit, so a small amount of cross-resource
    // parallelism is well within normal limits, and 429 responses are
    // already retried with Retry-After by the adapter.
    let next = 0;
    const workers = Array.from(
      { length: Math.min(GRAPH_REFRESH_CONCURRENCY, resources.length) },
      async () => {
        while (true) {
          const slot = next++;
          const resource = resources[slot];
          if (resource === undefined) return;
          if (signal?.aborted) return;
          await refreshOne(resource, slot);
        }
      },
    );
    await Promise.all(workers);

    return {
      tenantId: tenant.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      resources: slots.filter(
        (entry): entry is GraphCacheRefreshResult["resources"][number] =>
          entry !== undefined,
      ),
    };
  }

  /**
   * Exact per-resource counts for the answer pack. Cheap indexed
   * aggregates; failures are non-fatal because a missing count only
   * costs precision, and the model still has the sample rows.
   */
  private graphAggregatesFor(
    store: IntelligenceSqliteStore,
    tenantId: string,
    resources: readonly GraphCacheResourceKind[],
  ): Partial<
    Record<
      GraphCacheResourceKind,
      { total: number; breakdowns: Record<string, Record<string, number>> }
    >
  > {
    const aggregates: Partial<
      Record<
        GraphCacheResourceKind,
        { total: number; breakdowns: Record<string, Record<string, number>> }
      >
    > = {};
    for (const resource of resources) {
      try {
        aggregates[resource] = store.aggregateGraphResource(tenantId, resource);
      } catch {
        // Leave this resource without exact counts.
      }
    }
    return aggregates;
  }

  async sendIntuneChatMessage(
    input: SendIntuneChatMessageInput,
  ): Promise<SendIntuneChatMessageResult> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Chat message must not be empty.");
    }

    const store = this.host.requireIntelligenceStore();
    const persisted = await this.host.read();
    const tenant = this.host.resolveTenant(persisted);
    const providers = await this.host.listProviders();
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    const selectedModel = resolveProviderDefaultModel(
      provider,
      persisted.activeModelByProviderId,
    ).model;
    const chatBudget = intuneChatProviderBudget(providerId);
    const workspaceContext = input.workspaceContext
      ? this.buildWorkspacePromptContext(input.workspaceContext, tenant.id, persisted)
      : undefined;
    this.requireHostedChatConsent(
      input,
      tenant,
      provider,
      providerId,
      workspaceContext?.summary,
    );
    if (provider?.isLocal === false && input.hostedProviderConsent) {
      this.recordHostedProviderConsentSafely({
        tenantIds: [tenant.id],
        providerId,
        providerName: provider.name,
        ...(selectedModel ? { model: selectedModel } : {}),
        acknowledgedAt: input.hostedProviderConsent.acknowledgedAt,
        remember: input.hostedProviderConsent.remember,
        scope: "single-tenant-chat",
        ...(workspaceContext?.summary
          ? { workspaceContext: workspaceContext.summary }
          : {}),
      });
    }
    const planned = planChatContext(content);
    const now = new Date().toISOString();

    let conversation = input.conversationId
      ? store.getConversation(input.conversationId)
      : undefined;
    if (conversation) {
      assertConversationTenant(conversation, tenant.id);
    }
    if (!conversation) {
      conversation = store.createConversation({
        id: `chat_${randomUUID()}`,
        title: chatTitleForPrompt(content),
        tenantId: tenant.id,
        now,
      });
    }

    const userMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "user",
      content,
      status: "completed",
      createdAt: now,
    };
    store.insertMessage(userMessage);

    let refreshResult: GraphCacheRefreshResult | undefined;
    if (input.refreshIfStale !== false) {
      const before = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const staleResources = planned.resources.filter((resource) => {
        const status = before.find((entry) => entry.resource === resource);
        if (!status || status.rows === 0 || !status.refreshedAt) return true;
        return Date.now() - new Date(status.refreshedAt).getTime() > 6 * 60 * 60 * 1000;
      });
      if (staleResources.length > 0) {
        refreshResult = await this.refreshGraphCache({
          tenantId: tenant.id,
          resources: staleResources,
        });
        store.insertToolCall({
          id: `tool_${randomUUID()}`,
          conversationId: conversation.id,
          messageId: userMessage.id,
          type: "graph-cache-refresh",
          status: refreshResult.resources.some((resource) => resource.ok)
            ? "completed"
            : "failed",
          createdAt: now,
          completedAt: refreshResult.finishedAt,
          input: { resources: staleResources },
          output: refreshResult,
        });
      }
    }

    const cacheStatus = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
    const answerGeneratedAt = new Date().toISOString();
    const rows = readPlannedChatRows(store, {
      tenantId: tenant.id,
      question: content,
      generatedAt: answerGeneratedAt,
      resources: planned.resources,
      searchTerms: planned.searchTerms,
      limitPerResource: chatBudget.limitPerResource,
    });
    const agentSuggestions = matchAgentsToQuestion(content, persisted.installedAgents);
    const refreshedResources = new Set(
      refreshResult?.resources
        .filter((resource) => resource.ok)
        .map((resource) => resource.resource) ?? [],
    );
    const sources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: planned.resources,
      refreshedResources,
    });

    let assistantContent: string;
    let assistantStatus: IntuneChatMessage["status"] = "completed";
    let assistantError: string | undefined;
    let responseModel = selectedModel;
    let toolTrace: IntuneChatMessage["toolTrace"];

    if (planned.hasWriteIntent) {
      assistantContent = writeIntentBlockedMessage(agentSuggestions);
    } else {
      const llm = await this.host.buildLlm(providerId, selectedModel);
      const modelQuestion = workspaceContext
        ? `${content}\n\n${workspaceContext.promptBlock}`
        : content;
      const buildDeterministicAnswer = async (
        notice?: string,
      ): Promise<{ content: string; model?: string }> => {
        const answerPack = buildAnswerPack({
          question: modelQuestion,
          tenant,
          cacheStatus,
          rows,
          aggregates: this.graphAggregatesFor(store, tenant.id, planned.resources),
          hasWriteIntent: false,
          agentSuggestions,
          generatedAt: answerGeneratedAt,
          limits: chatBudget.answerPackLimits,
        });
        const documentation = await this.retrieveDocumentationSafely(modelQuestion);
        const completion = await llm.complete({
          system: buildIntuneChatSystemPrompt(provider?.isLocal === true),
          prompt: buildAnswerPrompt(answerPack, documentation),
          ...(selectedModel ? { model: selectedModel } : {}),
          temperature: 0.2,
          maxTokens: chatBudget.maxTokens,
        });
        let content = completion.text.trim();
        if (agentSuggestions.length > 0) {
          content = `${content}\n\nDetected matching agent: ${agentSuggestions[0]?.agentName}.`;
        }
        return {
          content: [notice, content].filter((part): part is string => Boolean(part)).join("\n\n"),
          model: completion.model,
        };
      };

      if (!llm.available) {
        assistantStatus = "failed";
        assistantError =
          "No LLM provider is connected. Start Ollama or choose another provider in Settings, then try again.";
        assistantContent = assistantError;
      } else {
        try {
          const investigationSettings = store.getChatInvestigationSettings();
          const capability = resolveAgenticCapability({
            mode: investigationSettings.mode,
            provider,
            providerId,
            model: selectedModel ?? llm.defaultModel,
          });
          if (capability.enabled) {
            const agentic = await runAgenticChat({
              question: modelQuestion,
              documentation: await this.retrieveDocumentationSafely(modelQuestion),
              tenant,
              providerId,
              providerIsLocal: provider?.isLocal === true,
              ...(selectedModel ? { model: selectedModel } : {}),
              llm,
              tools: this.buildChatToolContext(tenant.id),
              plannedResources: planned.resources,
              agentSuggestions,
              generatedAt: answerGeneratedAt,
              maxTokens: chatBudget.maxTokens,
            });
            responseModel = agentic.model ?? responseModel;
            toolTrace = agentic.toolTrace;
            recordAgenticOutcome(providerId, responseModel, agentic.ok);
            if (agentic.ok) {
              assistantContent = agentic.answer;
              if (agentSuggestions.length > 0) {
                assistantContent = `${assistantContent}\n\nDetected matching agent: ${agentSuggestions[0]?.agentName}.`;
              }
            } else {
              const deterministic = await buildDeterministicAnswer(agentic.fallbackNotice);
              assistantContent = deterministic.content;
              responseModel = deterministic.model ?? responseModel;
            }
          } else {
            const deterministic = await buildDeterministicAnswer(capability.notice);
            assistantContent = deterministic.content;
            responseModel = deterministic.model ?? responseModel;
          }
        } catch (caught) {
          assistantStatus = "failed";
          assistantError = caught instanceof Error ? caught.message : String(caught);
          assistantContent = `The selected LLM provider failed while answering this chat message. ${assistantError}`;
        }
      }
    }

    const assistantMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "assistant",
      content: assistantContent,
      status: assistantStatus,
      createdAt: new Date().toISOString(),
      providerId,
      model: responseModel,
      sources,
      ...(toolTrace && toolTrace.length > 0 ? { toolTrace } : {}),
      agentSuggestions,
      ...(assistantError ? { error: assistantError } : {}),
    };
    store.insertMessage(assistantMessage);
    if (toolTrace && toolTrace.length > 0) {
      this.persistToolTrace({
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        toolTrace,
      });
    }
    store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);

    await this.maybeCreateSelfTrainingSuggestionFromChat({
      tenantId: tenant.id,
      question: content,
      agentSuggestions,
    });

    return {
      conversation: store.getConversation(conversation.id) ?? conversation,
      userMessage,
      assistantMessage,
      cacheStatus: {
        tenantId: tenant.id,
        resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
        schedule: store.getGraphCacheRefreshSchedule(tenant.id),
      },
    };
  }

  async streamIntuneChatMessage(
    input: SendIntuneChatMessageInput,
    onEvent: (event: IntuneChatStreamEvent) => void,
    options: { signal?: AbortSignal } = {},
  ): Promise<SendIntuneChatMessageResult> {
    const content = input.content.trim();
    if (!content) {
      throw new Error("Chat message must not be empty.");
    }

    const store = this.host.requireIntelligenceStore();
    const persisted = await this.host.read();
    const tenant = this.host.resolveTenant(persisted);
    const providers = await this.host.listProviders();
    const provider =
      providers.find((entry) => entry.id === persisted.activeProviderId) ?? providers[0];
    const providerId = provider?.id ?? persisted.activeProviderId;
    const selectedModel = resolveProviderDefaultModel(
      provider,
      persisted.activeModelByProviderId,
    ).model;
    const chatBudget = intuneChatProviderBudget(providerId);
    const workspaceContext = input.workspaceContext
      ? this.buildWorkspacePromptContext(input.workspaceContext, tenant.id, persisted)
      : undefined;
    this.requireHostedChatConsent(
      input,
      tenant,
      provider,
      providerId,
      workspaceContext?.summary,
    );
    if (provider?.isLocal === false && input.hostedProviderConsent) {
      this.recordHostedProviderConsentSafely({
        tenantIds: [tenant.id],
        providerId,
        providerName: provider.name,
        ...(selectedModel ? { model: selectedModel } : {}),
        acknowledgedAt: input.hostedProviderConsent.acknowledgedAt,
        remember: input.hostedProviderConsent.remember,
        scope: "single-tenant-chat",
        ...(workspaceContext?.summary
          ? { workspaceContext: workspaceContext.summary }
          : {}),
      });
    }
    const planned = planChatContext(content);
    const now = new Date().toISOString();

    let conversation = input.conversationId
      ? store.getConversation(input.conversationId)
      : undefined;
    if (conversation) {
      assertConversationTenant(conversation, tenant.id);
    }
    if (!conversation) {
      conversation = store.createConversation({
        id: `chat_${randomUUID()}`,
        title: chatTitleForPrompt(content),
        tenantId: tenant.id,
        now,
      });
    }

    const userMessage: IntuneChatMessage = {
      id: `msg_${randomUUID()}`,
      conversationId: conversation.id,
      role: "user",
      content,
      status: "completed",
      createdAt: now,
    };
    store.insertMessage(userMessage);

    const assistantId = `msg_${randomUUID()}`;
    const pendingAssistant: IntuneChatMessage = {
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: new Date().toISOString(),
      providerId,
      ...(selectedModel ? { model: selectedModel } : {}),
    };
    const initialCacheStatus: GraphCacheStatus = {
      tenantId: tenant.id,
      resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
      schedule: store.getGraphCacheRefreshSchedule(tenant.id),
    };
    onEvent({
      type: "started",
      conversation,
      userMessage,
      assistantMessage: pendingAssistant,
      cacheStatus: initialCacheStatus,
    });
    const isCancelled = () => options.signal?.aborted === true;
    const finishCancelled = (): SendIntuneChatMessageResult => {
      const cancelledAt = new Date().toISOString();
      const currentCacheStatus = store.getGraphCacheStatus(tenant.id, [
        ...GRAPH_CACHE_RESOURCES,
      ]);
      const assistantMessage: IntuneChatMessage = {
        id: assistantId,
        conversationId: conversation.id,
        role: "assistant",
        content: "Response stopped by user before a final answer was saved.",
        status: "cancelled",
        createdAt: cancelledAt,
        providerId,
        ...(selectedModel ? { model: selectedModel } : {}),
        sources: buildIntuneChatSources({
          cacheStatus: currentCacheStatus,
          plannedResources: planned.resources,
          refreshedResources: new Set(),
        }),
        error: "Stopped by user.",
      };
      store.insertMessage(assistantMessage);
      store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);
      return {
        conversation: store.getConversation(conversation.id) ?? conversation,
        userMessage,
        assistantMessage,
        cacheStatus: {
          tenantId: tenant.id,
          resources: currentCacheStatus,
          schedule: store.getGraphCacheRefreshSchedule(tenant.id),
        },
      };
    };

    if (isCancelled()) {
      const result = finishCancelled();
      onEvent({ type: "cancelled", result });
      return result;
    }

    let refreshResult: GraphCacheRefreshResult | undefined;
    let progressRefreshResources: GraphCacheResourceKind[] = [];
    let progressRefreshResults: GraphCacheRefreshResourceResult[] = [];
    let progressActiveResource: GraphCacheResourceKind | undefined;
    let progressToolSteps: IntuneChatProgressStep[] = [];
    const sendProgress = (input: {
      message: string;
      stage: IntuneChatStreamStage;
      cacheCheckStatus?: IntuneChatProgressStep["status"];
      contextStatus?: IntuneChatProgressStep["status"];
      modelStatus?: IntuneChatProgressStep["status"];
      cacheStatus?: GraphCacheStatus;
    }) => {
      const progressSteps = buildChatProgressSteps({
        refreshResources: progressRefreshResources,
        refreshResults: progressRefreshResults,
        activeResource: progressActiveResource,
        cacheCheckStatus: input.cacheCheckStatus ?? "completed",
        contextStatus: input.contextStatus ?? "pending",
        modelStatus: input.modelStatus ?? "pending",
      });
      if (progressToolSteps.length > 0) {
        const modelIndex = progressSteps.findIndex((step) => step.id === "model-answer");
        progressSteps.splice(
          modelIndex >= 0 ? modelIndex : progressSteps.length,
          0,
          ...progressToolSteps,
        );
      }
      onEvent({
        type: "status",
        conversationId: conversation.id,
        message: input.message,
        stage: input.stage,
        progressSteps,
        progressPercent: estimateChatProgressPercent(progressSteps),
        ...(input.cacheStatus ? { cacheStatus: input.cacheStatus } : {}),
      });
    };
    sendProgress({
      message: "Checking cached tenant data.",
      stage: "checking-cache",
      cacheCheckStatus: "active",
    });

    if (input.refreshIfStale !== false) {
      const before = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
      const staleResources = planned.resources.filter((resource) => {
        const status = before.find((entry) => entry.resource === resource);
        if (!status || status.rows === 0 || !status.refreshedAt) return true;
        return Date.now() - new Date(status.refreshedAt).getTime() > 6 * 60 * 60 * 1000;
      });
      progressRefreshResources = staleResources;
      if (staleResources.length > 0) {
        sendProgress({
          message: `Refreshing ${staleResources.length} tenant data source${staleResources.length === 1 ? "" : "s"} before answering.`,
          stage: "refreshing-cache",
        });
        refreshResult = await this.refreshGraphCacheInternal(
          {
            tenantId: tenant.id,
            resources: staleResources,
          },
          (event) => {
            if (event.type === "resource-start") {
              progressActiveResource = event.resource;
              sendProgress({
                message: `Refreshing ${event.label}.`,
                stage: "refreshing-cache",
              });
              return;
            }
            progressActiveResource = undefined;
            progressRefreshResults = [...progressRefreshResults, event.result];
            sendProgress({
              message: event.result.ok
                ? `Cached ${event.result.label}.`
                : `Could not refresh ${event.result.label}.`,
              stage: "refreshing-cache",
            });
          },
          // Stop used to be checked only before and after the whole
          // refresh, so pressing it mid-refresh let every remaining
          // Graph call run to completion before the result was thrown
          // away. The signal now reaches the requests themselves.
          options.signal,
        );
        store.insertToolCall({
          id: `tool_${randomUUID()}`,
          conversationId: conversation.id,
          messageId: userMessage.id,
          type: "graph-cache-refresh",
          status: refreshResult.resources.some((resource) => resource.ok)
            ? "completed"
            : "failed",
          createdAt: now,
          completedAt: refreshResult.finishedAt,
          input: { resources: staleResources },
          output: refreshResult,
        });
        sendProgress({
          message: "Building answer context from local cache.",
          stage: "building-context",
          contextStatus: "active",
          cacheStatus: {
            tenantId: tenant.id,
            resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
            schedule: store.getGraphCacheRefreshSchedule(tenant.id),
          },
        });
      } else {
        sendProgress({
          message: "Using cached tenant context.",
          stage: "building-context",
          contextStatus: "active",
        });
      }
    }
    if (isCancelled()) {
      const result = finishCancelled();
      sendProgress({
        message: "Response stopped.",
        stage: "failed",
        contextStatus: "completed",
        modelStatus: "failed",
        cacheStatus: result.cacheStatus,
      });
      onEvent({ type: "cancelled", result });
      return result;
    }

    const cacheStatus = store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]);
    const answerGeneratedAt = new Date().toISOString();
    const rows = readPlannedChatRows(store, {
      tenantId: tenant.id,
      question: content,
      generatedAt: answerGeneratedAt,
      resources: planned.resources,
      searchTerms: planned.searchTerms,
      limitPerResource: chatBudget.limitPerResource,
    });
    const agentSuggestions = matchAgentsToQuestion(content, persisted.installedAgents);
    const refreshedResources = new Set(
      refreshResult?.resources
        .filter((resource) => resource.ok)
        .map((resource) => resource.resource) ?? [],
    );
    const sources = buildIntuneChatSources({
      cacheStatus,
      plannedResources: planned.resources,
      refreshedResources,
    });

    let assistantContent = "";
    let assistantStatus: IntuneChatMessage["status"] = "completed";
    let assistantError: string | undefined;
    let responseModel = selectedModel;
    let toolTrace: IntuneChatMessage["toolTrace"];

    const emitDelta = (content: string, delta: string = content) => {
      onEvent({
        type: "delta",
        conversationId: conversation.id,
        assistantMessageId: assistantId,
        delta,
        content,
        providerId,
        model: responseModel,
      });
    };

    if (planned.hasWriteIntent) {
      assistantContent = writeIntentBlockedMessage(agentSuggestions);
      emitDelta(assistantContent);
    } else {
      const llm = await this.host.buildLlm(providerId, selectedModel);
      const modelQuestion = workspaceContext
        ? `${content}\n\n${workspaceContext.promptBlock}`
        : content;
      const streamDeterministicAnswer = async (notice?: string) => {
        const answerPack = buildAnswerPack({
          question: modelQuestion,
          tenant,
          cacheStatus,
          rows,
          aggregates: this.graphAggregatesFor(store, tenant.id, planned.resources),
          hasWriteIntent: false,
          agentSuggestions,
          generatedAt: answerGeneratedAt,
          limits: chatBudget.answerPackLimits,
        });
        const prefix = notice ? `${notice}\n\n` : "";
        if (prefix) {
          assistantContent = prefix;
          emitDelta(assistantContent, prefix);
        }
        const streamDocumentation =
          await this.retrieveDocumentationSafely(modelQuestion);
        for await (const chunk of llm.stream({
          system: buildIntuneChatSystemPrompt(provider?.isLocal === true),
          prompt: buildAnswerPrompt(answerPack, streamDocumentation),
          ...(selectedModel ? { model: selectedModel } : {}),
          temperature: 0.2,
          maxTokens: chatBudget.maxTokens,
          signal: options.signal,
        })) {
          if (isCancelled()) {
            break;
          }
          responseModel = chunk.model;
          assistantContent = `${prefix}${chunk.accumulated}`;
          emitDelta(assistantContent, chunk.delta);
        }
        assistantContent = assistantContent.trim();
        if (agentSuggestions.length > 0) {
          assistantContent = `${assistantContent}\n\nDetected matching agent: ${agentSuggestions[0]?.agentName}.`;
        }
        emitDelta(assistantContent, "");
      };

      if (!llm.available) {
        assistantStatus = "failed";
        assistantError =
          "No LLM provider is connected. Start Ollama or choose another provider in Settings, then try again.";
        assistantContent = assistantError;
      } else {
        try {
          const investigationSettings = store.getChatInvestigationSettings();
          const capability = resolveAgenticCapability({
            mode: investigationSettings.mode,
            provider,
            providerId,
            model: selectedModel ?? llm.defaultModel,
          });
          if (capability.enabled) {
            sendProgress({
              message: "Investigative mode started.",
              stage: "running-tools",
              contextStatus: "completed",
              modelStatus: "active",
              cacheStatus: {
                tenantId: tenant.id,
                resources: cacheStatus,
                schedule: store.getGraphCacheRefreshSchedule(tenant.id),
              },
            });
            const agentic = await runAgenticChat({
              question: modelQuestion,
              documentation: await this.retrieveDocumentationSafely(modelQuestion),
              tenant,
              providerId,
              providerIsLocal: provider?.isLocal === true,
              ...(selectedModel ? { model: selectedModel } : {}),
              llm,
              tools: this.buildChatToolContext(tenant.id),
              plannedResources: planned.resources,
              agentSuggestions,
              generatedAt: answerGeneratedAt,
              maxTokens: chatBudget.maxTokens,
              signal: options.signal,
              onToolStart: (event) => {
                const stepId = `tool-${progressToolSteps.length + 1}-${event.tool}`;
                progressToolSteps = [
                  ...progressToolSteps,
                  {
                    id: stepId,
                    label: event.message,
                    status: "active",
                  },
                ];
                onEvent({
                  type: "tool-step-start",
                  conversationId: conversation.id,
                  assistantMessageId: assistantId,
                  tool: event.tool,
                  params: event.params,
                  message: event.message,
                  startedAt: event.startedAt,
                });
                sendProgress({
                  message: event.message,
                  stage: "running-tools",
                  contextStatus: "completed",
                  modelStatus: "active",
                });
              },
              onToolFinish: (event) => {
                progressToolSteps = progressToolSteps.map((step, index) =>
                  index === progressToolSteps.length - 1
                    ? {
                        ...step,
                        status: event.traceEntry.error ? "failed" : "completed",
                        detail: event.traceEntry.resultSummary,
                      }
                    : step,
                );
                onEvent({
                  type: "tool-step-finish",
                  conversationId: conversation.id,
                  assistantMessageId: assistantId,
                  traceEntry: event.traceEntry,
                  message: event.message,
                });
                sendProgress({
                  message: event.message,
                  stage: "running-tools",
                  contextStatus: "completed",
                  modelStatus: "active",
                });
              },
            });
            responseModel = agentic.model ?? responseModel;
            toolTrace = agentic.toolTrace;
            recordAgenticOutcome(providerId, responseModel, agentic.ok);
            if (agentic.ok) {
              sendProgress({
                message: "Model response started.",
                stage: "generating-answer",
                contextStatus: "completed",
                modelStatus: "active",
                cacheStatus: {
                  tenantId: tenant.id,
                  resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
                  schedule: store.getGraphCacheRefreshSchedule(tenant.id),
                },
              });
              assistantContent = agentic.answer.trim();
              if (agentSuggestions.length > 0) {
                assistantContent = `${assistantContent}\n\nDetected matching agent: ${agentSuggestions[0]?.agentName}.`;
              }
              emitDelta(assistantContent);
            } else {
              sendProgress({
                message: agentic.fallbackNotice,
                stage: "building-context",
                contextStatus: "active",
                modelStatus: "pending",
              });
              await streamDeterministicAnswer(agentic.fallbackNotice);
            }
          } else {
            if (capability.reason === "capability-fallback" && capability.notice) {
              sendProgress({
                message: capability.notice,
                stage: "building-context",
                contextStatus: "active",
                modelStatus: "pending",
              });
            }
            await streamDeterministicAnswer(capability.notice);
          }
        } catch (caught) {
          if (isCancelled()) {
            const result = finishCancelled();
            sendProgress({
              message: "Response stopped.",
              stage: "failed",
              contextStatus: "completed",
              modelStatus: "failed",
              cacheStatus: result.cacheStatus,
            });
            onEvent({ type: "cancelled", result });
            return result;
          }
          assistantStatus = "failed";
          assistantError = caught instanceof Error ? caught.message : String(caught);
          assistantContent = assistantContent.trim()
            ? `${assistantContent.trim()}\n\nThe selected LLM provider failed while answering this chat message. ${assistantError}`
            : `The selected LLM provider failed while answering this chat message. ${assistantError}`;
        }
      }
    }
    if (isCancelled()) {
      const result = finishCancelled();
      sendProgress({
        message: "Response stopped.",
        stage: "failed",
        contextStatus: "completed",
        modelStatus: "failed",
        cacheStatus: result.cacheStatus,
      });
      onEvent({ type: "cancelled", result });
      return result;
    }

    const assistantMessage: IntuneChatMessage = {
      id: assistantId,
      conversationId: conversation.id,
      role: "assistant",
      content: assistantContent,
      status: assistantStatus,
      createdAt: new Date().toISOString(),
      providerId,
      ...(responseModel ? { model: responseModel } : {}),
      sources,
      ...(toolTrace && toolTrace.length > 0 ? { toolTrace } : {}),
      agentSuggestions,
      ...(assistantError ? { error: assistantError } : {}),
    };
    store.insertMessage(assistantMessage);
    if (toolTrace && toolTrace.length > 0) {
      this.persistToolTrace({
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        toolTrace,
      });
    }
    store.touchConversation(conversation.id, undefined, assistantMessage.createdAt);

    await this.maybeCreateSelfTrainingSuggestionFromChat({
      tenantId: tenant.id,
      question: content,
      agentSuggestions,
    });

    const result: SendIntuneChatMessageResult = {
      conversation: store.getConversation(conversation.id) ?? conversation,
      userMessage,
      assistantMessage,
      cacheStatus: {
        tenantId: tenant.id,
        resources: store.getGraphCacheStatus(tenant.id, [...GRAPH_CACHE_RESOURCES]),
        schedule: store.getGraphCacheRefreshSchedule(tenant.id),
      },
    };

    sendProgress({
      message:
        assistantStatus === "failed"
          ? "Chat answer failed."
          : "Chat answer ready.",
      stage: assistantStatus === "failed" ? "failed" : "completed",
      contextStatus: "completed",
      modelStatus: assistantStatus === "failed" ? "failed" : "completed",
      cacheStatus: result.cacheStatus,
    });

    if (assistantStatus === "failed") {
      onEvent({
        type: "failed",
        result,
        error: assistantError ?? "The selected LLM provider failed.",
      });
    } else {
      onEvent({ type: "completed", result });
    }
    return result;
  }

  /**
   * Execute a single read-only chat tool for a fixed tenant. Used by
   * the MCP gateway to expose the exact same read surface (allowlist,
   * caps, drift access) to external AI clients without going through
   * the conversational loop.
   */
  async executeReadTool(
    tenantId: string,
    name: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const allowed: readonly IntuneChatInvestigationToolName[] = [
      "list_cached_resources",
      "query_cache",
      "graph_get",
      "query_drift",
    ];
    const match = allowed.find((candidate) => candidate === name);
    if (!match) {
      throw new Error(`Tool is not available through the gateway: ${name}`);
    }
    const ctx = this.buildChatToolContext(tenantId);
    const execution = await executeIntuneChatTool(ctx, match, params);
    if (execution.trace.error) {
      throw new Error(execution.trace.error);
    }
    return execution.result;
  }

  /**
   * Documentation retrieval must never take an answer down: a missing
   * index, an embedding model that was not pulled, or a stopped Ollama
   * all degrade to an ungrounded answer rather than an error.
   */
  private async retrieveDocumentationSafely(
    query: string,
  ): Promise<Array<{ file: string; title?: string; text: string; score: number }>> {
    if (!this.host.retrieveDocumentation) return [];
    try {
      return await this.host.retrieveDocumentation(query);
    } catch (error) {
      console.info(
        "[intune-chat] documentation retrieval unavailable:",
        error instanceof Error ? error.message : error,
      );
      return [];
    }
  }

  private buildChatToolContext(tenantId: string): IntuneChatToolContext {
    const store = this.host.requireIntelligenceStore();
    const log = (
      level: RunLogLevel,
      message: string,
      metadata?: Record<string, unknown>,
    ) => {
      console.info("[intune-chat][tool-graph]", level, message, metadata ?? "");
    };
    return {
      tenantId,
      store,
      graphForScopes: async (scopes) => {
        const uniqueScopes = [...new Set(scopes)].sort();
        return this.host.graphFactory
          ? this.host.graphFactory({ tenantId, scopes: uniqueScopes, log })
          : (await this.host.buildGraph(tenantId, uniqueScopes)).createGraph(log);
      },
      refreshResource: async (resource) => {
        const result = await this.refreshGraphCacheInternal({
          tenantId,
          resources: [resource],
        });
        const resourceResult = result.resources[0];
        if (resourceResult) return resourceResult;
        const definition = definitionForResource(resource);
        return {
          resource,
          label: definition.label,
          rows: 0,
          refreshedAt: result.finishedAt,
          ok: false,
          error: "Refresh did not return a resource result.",
        };
      },
      getDriftTimeline: (input) => this.host.getDriftTimeline(input),
    };
  }

  private persistToolTrace(input: {
    conversationId: string;
    messageId: string;
    toolTrace: NonNullable<IntuneChatMessage["toolTrace"]>;
  }): void {
    const store = this.host.requireIntelligenceStore();
    for (const trace of input.toolTrace) {
      store.insertToolCall({
        id: trace.id,
        conversationId: input.conversationId,
        messageId: input.messageId,
        type: trace.tool,
        status: trace.error ? "failed" : "completed",
        createdAt: trace.createdAt,
        completedAt: trace.completedAt,
        input: trace.params,
        output: trace,
        ...(trace.error ? { error: trace.error } : {}),
      });
    }
  }

  private requireHostedChatConsent(
    input: SendIntuneChatMessageInput,
    tenant: TenantRecord,
    provider: ProviderSummary | undefined,
    providerId: ProviderId,
    workspaceContext?: WorkspacePromptContextSummary,
  ): void {
    if (provider?.isLocal !== false) {
      return;
    }

    const consent = input.hostedProviderConsent;
    if (!consent) {
      throw new Error(
        "Hosted provider confirmation is required before Chat can send tenant context to the selected provider.",
      );
    }

    if (consent.tenantId !== tenant.id || consent.providerId !== providerId) {
      throw new Error(
        "Hosted provider confirmation does not match the active tenant and provider. Confirm the chat send again.",
      );
    }

    const acknowledgedAt = Date.parse(consent.acknowledgedAt);
    const now = Date.now();
    if (
      !Number.isFinite(acknowledgedAt) ||
      now - acknowledgedAt > 5 * 60 * 1000 ||
      acknowledgedAt - now > 60 * 1000
    ) {
      throw new Error(
        "Hosted provider confirmation expired. Confirm the chat send again.",
      );
    }

    if (!workspaceContext) {
      return;
    }

    const acknowledgedWorkspace = consent.workspaceContext;
    if (
      !acknowledgedWorkspace ||
      acknowledgedWorkspace.workspaceId !== workspaceContext.workspaceId ||
      acknowledgedWorkspace.tenantId !== workspaceContext.tenantId ||
      acknowledgedWorkspace.evidenceCount !== workspaceContext.evidenceCount ||
      acknowledgedWorkspace.noteCount !== workspaceContext.noteCount ||
      acknowledgedWorkspace.includesInstructions !== workspaceContext.includesInstructions
    ) {
      throw new Error(
        "Hosted provider confirmation does not include the attached workspace context. Confirm the chat send again.",
      );
    }
  }

  async getSelfTrainingSettings(): Promise<SelfTrainingSettings> {
    return this.host.requireIntelligenceStore().getSelfTrainingSettings();
  }

  async getChatInvestigationSettings(): Promise<ChatInvestigationSettings> {
    return this.host.requireIntelligenceStore().getChatInvestigationSettings();
  }

  async setChatInvestigationMode(
    mode: ChatInvestigationMode,
  ): Promise<ChatInvestigationSettings> {
    return this.host.requireIntelligenceStore().setChatInvestigationMode(
      mode,
      new Date().toISOString(),
    );
  }

  async setSelfTrainingEnabled(enabled: boolean): Promise<SelfTrainingSettings> {
    const now = new Date().toISOString();
    return this.host.requireIntelligenceStore().setSelfTrainingEnabled(enabled, now);
  }

  async listSelfTrainingSuggestions(
    status?: SelfTrainingSuggestionStatus,
  ): Promise<SelfTrainingSuggestion[]> {
    return this.host.requireIntelligenceStore().listSelfTrainingSuggestions(status);
  }

  async approveSelfTrainingSuggestion(id: string): Promise<SelfTrainingSuggestion> {
    const suggestion = this.host.requireIntelligenceStore().decideSelfTrainingSuggestion(
      id,
      "accepted",
      new Date().toISOString(),
    );
    await this.writeSelfTrainingFile(suggestion.tenantId, suggestion.agentSlug);
    return suggestion;
  }

  async rejectSelfTrainingSuggestion(id: string): Promise<SelfTrainingSuggestion> {
    return this.host.requireIntelligenceStore().decideSelfTrainingSuggestion(
      id,
      "rejected",
      new Date().toISOString(),
    );
  }

  async resetSelfTrainingSuggestions(
    input: ResetSelfTrainingInput,
  ): Promise<SelfTrainingSuggestion[]> {
    const persisted = await this.host.read();
    const tenantId = this.host.resolveTenant(persisted, input.tenantId).id;
    const reset = this.host.requireIntelligenceStore().resetAcceptedSelfTrainingSuggestions({
      tenantId,
      agentSlug: input.agentSlug,
      now: new Date().toISOString(),
    });
    await this.writeSelfTrainingFile(tenantId, input.agentSlug);
    return reset;
  }

  async refreshDueGraphCaches(): Promise<void> {
    if (!this.host.intelligenceStore) return;
    const persisted = await this.host.read();
    const nowMs = Date.now();

    for (const tenant of persisted.tenants) {
      if (!this.host.intelligenceStore.isGraphCacheRefreshDue(tenant.id, nowMs)) continue;
      const startedAt = new Date(nowMs).toISOString();
      try {
        const result = await this.refreshGraphCache({ tenantId: tenant.id });
        const failures = result.resources.filter((resource) => !resource.ok);
        this.host.intelligenceStore.markGraphCacheRefreshScheduleRun({
          tenantId: tenant.id,
          startedAt,
          success: failures.length === 0,
          ...(failures.length > 0
            ? {
                error: failures
                  .map((failure) => `${failure.label}: ${failure.error ?? "failed"}`)
                  .join("; "),
              }
            : {}),
        });
      } catch (error) {
        this.host.intelligenceStore.markGraphCacheRefreshScheduleRun({
          tenantId: tenant.id,
          startedAt,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(
          `[intune-chat] scheduled Graph cache refresh failed for tenant ${tenant.id}:`,
          error,
        );
      }
    }
  }
}


/**
 * Observed agentic capability, per provider+model.
 *
 * Model names are a poor proxy for whether a model can hold the
 * investigative JSON protocol: a name-based rule both misses capable
 * models and keeps re-attempting models that provably cannot emit the
 * tool schema, burning a round trip on every question before falling
 * back. Record what actually happened instead and stop retrying a model
 * that has failed repeatedly.
 *
 * Deliberately in-memory: if the user pulls a better build of the same
 * tag, or the failures were caused by a transient provider problem, a
 * restart re-evaluates rather than permanently branding the model.
 */
const AGENTIC_FAILURE_LIMIT = 2;
const agenticFailuresByModel = new Map<string, number>();

function agenticModelKey(providerId: string, model: string | undefined): string {
  return `${providerId}::${model ?? "default"}`;
}

export function recordAgenticOutcome(
  providerId: string,
  model: string | undefined,
  ok: boolean,
): void {
  const key = agenticModelKey(providerId, model);
  if (ok) {
    agenticFailuresByModel.delete(key);
    return;
  }
  agenticFailuresByModel.set(key, (agenticFailuresByModel.get(key) ?? 0) + 1);
}

function agenticModelHasFailedRepeatedly(
  providerId: string,
  model: string | undefined,
): boolean {
  return (
    (agenticFailuresByModel.get(agenticModelKey(providerId, model)) ?? 0) >=
    AGENTIC_FAILURE_LIMIT
  );
}

type AgenticCapabilityDecision = {
  enabled: boolean;
  reason: "setting" | "capable" | "capability-fallback";
  notice?: string;
};

/** Test seam for the capability decision; not used by app code. */
export function resolveAgenticCapabilityForTest(
  input: Parameters<typeof resolveAgenticCapability>[0],
): AgenticCapabilityDecision {
  return resolveAgenticCapability(input);
}

function resolveAgenticCapability(input: {
  mode: ChatInvestigationMode;
  provider: ProviderSummary | undefined;
  providerId: ProviderId;
  model?: string;
}): AgenticCapabilityDecision {
  if (input.mode === "always-agentic") {
    return { enabled: true, reason: "setting" };
  }
  if (input.mode === "always-deterministic") {
    return { enabled: false, reason: "setting" };
  }
  const observedModel =
    input.model ?? input.provider?.defaultModel ?? input.provider?.models?.[0];
  if (agenticModelHasFailedRepeatedly(input.providerId, observedModel)) {
    return {
      enabled: false,
      reason: "capability-fallback",
      notice: `Deterministic retrieval - ${observedModel ?? input.providerId} did not hold the investigative format, so this answer skips it.`,
    };
  }
  if (input.provider?.isLocal === false) {
    return { enabled: true, reason: "capable" };
  }
  const model = observedModel;
  if (modelSuggestsSmallLocalModel(model)) {
    return {
      enabled: false,
      reason: "capability-fallback",
      notice: `Deterministic retrieval — ${model ?? input.provider?.name ?? input.providerId} doesn't support investigative mode.`,
    };
  }
  return { enabled: true, reason: "capable" };
}

function modelSuggestsSmallLocalModel(model: string | undefined): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  if (/^(mock|test)(?:[-_:]|$)/.test(lower)) {
    return true;
  }
  if (/\b(tiny|small|mini|nano|phi|gemma:2b|gemma2:2b)\b/.test(lower)) {
    return true;
  }
  const match = lower.match(/(?:^|[^0-9])([1-6](?:\.\d+)?)\s*b(?:$|[^a-z0-9])/);
  return Boolean(match);
}

function writeIntentBlockedMessage(
  agentSuggestions: NonNullable<IntuneChatMessage["agentSuggestions"]>,
): string {
  const writeAgent = agentSuggestions.find((suggestion) => suggestion.mode === "write");
  return [
    "I cannot perform tenant changes directly from chat.",
    writeAgent
      ? `This looks like work for ${writeAgent.agentName}. Use the installed write agent so the normal plan and confirmation flow stays in force.`
      : "Use an installed write agent so the normal plan and confirmation flow stays in force.",
  ].join("\n\n");
}

/**
 * Put Microsoft documentation in front of the tenant data, and say
 * plainly which is which. The model must not present documentation as
 * observed tenant state, and it must cite the file a claim came from so
 * an admin can check it.
 */
function buildAnswerPrompt(
  answerPack: string,
  documentation: ReadonlyArray<{ file: string; title?: string; text: string }>,
): string {
  if (documentation.length === 0) {
    return `Use this retrieved tenant context to answer the admin.\n\n${answerPack}`;
  }
  const passages = documentation
    .map(
      (chunk, index) =>
        `[${index + 1}] ${chunk.title ? `${chunk.title} - ` : ""}${chunk.file}\n${chunk.text.trim()}`,
    )
    .join("\n\n");
  return [
    "Microsoft documentation passages retrieved locally for this question:",
    passages,
    "",
    "The documentation above describes how Microsoft 365 behaves in general. It is not this tenant's state. When you rely on it, cite the source in square brackets, for example [1]. If it does not cover the question, say so rather than guessing.",
    "",
    "Retrieved tenant context, which is this tenant's actual state:",
    answerPack,
  ].join("\n");
}
