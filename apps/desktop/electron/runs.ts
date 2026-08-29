import { randomUUID } from "node:crypto";

import {
  createQueuedRun,
  executeApply,
  executePlan,
  executeRun,
  tenantSatisfiesRequirement,
} from "@openadminos/runtime";
import {
  resolveProviderDefaultModel,
  resolveRunModel,
  type AgentSummary,
  type IntuneChatMessage,
  type ProviderId,
  type ProviderSummary,
  type RunGraphApi,
  type RunLlmApi,
  type RunLogLevel,
  type RunRecord,
  type RunStepStatus,
  type SecretAccessor,
  type StartRunOptions,
  type TenantRecord,
  type TenantSession,
} from "@openadminos/agent-sdk";

import {
  assertAgentCompatible,
  withAgentCompatibility,
} from "./agent-draft-helpers.js";
import { requestConnectorConfirmation } from "./connector-confirm-bridge.js";
import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import { fingerprintRunOutput } from "./run-delivery-format.js";
import {
  isTerminalRunStatus,
  withSelfTrainingOverlay,
} from "./state-helpers.js";

export interface RunPersistedState {
  activeProviderId: ProviderId;
  activeModelByProviderId?: Partial<Record<ProviderId, string>>;
  installedAgents: AgentSummary[];
  runs: RunRecord[];
  tenants: TenantRecord[];
  activeTenantId?: string;
}

export interface RunServiceHost {
  read(): Promise<RunPersistedState>;
  write(state: RunPersistedState): Promise<void>;
  serialize<T>(task: () => Promise<T>): Promise<T>;
  listProviders(): Promise<ProviderSummary[]>;
  providerCanRun(
    provider: ProviderSummary | undefined,
  ): provider is ProviderSummary & { status: "connected" | "available" };
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
  readConnectorConfigs(): Promise<Record<string, Record<string, unknown>>>;
  connectorSecretsFor(connectorId: string): SecretAccessor;
  selfTrainingPromptOverlay(tenantId: string, agentSlug: string): string | undefined;
  recordLearningEventSafely(input: {
    tenantId?: string;
    agentSlug?: string;
    eventType: string;
    source: string;
    payload: unknown;
  }): void;
  notifyRunFinished(run: RunRecord): void;
  emitStateChanged(reason: string, runId?: string): void;
  enqueueRunDeliveries(run: RunRecord): Promise<void>;
  processPendingRunDeliveries(): Promise<void>;
  readonly appVersion: string;
  readonly intelligenceStore: IntelligenceSqliteStore | undefined;
}

export class RunService {
  private readonly cancelledRunIds = new Set<string>();

  constructor(private readonly host: RunServiceHost) {}

  async cancelRun(runId: string): Promise<RunRecord> {
    const result = await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "rejected" ||
        run.status === "cancelled"
      ) {
        // Already terminal — nothing to cancel.
        return run;
      }

      const finishedAt = new Date().toISOString();
      const cancelled: RunRecord = {
        ...run,
        status: "cancelled",
        finishedAt,
        // Overwrite any stale in-progress summary (e.g. "X is running.")
        // with an explicit cancellation message. The original summary
        // would otherwise leak into Activity rows long after the cancel.
        summary: "Cancelled by user.",
        // Transition any in-flight step to "cancelled" and stop any
        // streaming reasoning indicator. Without this the UI keeps
        // spinning the active step and showing a "streaming" badge
        // even though the run is terminal.
        steps: run.steps.map((step) =>
          step.status === "running"
            ? {
                ...step,
                status: "cancelled",
                finishedAt: step.finishedAt ?? finishedAt,
                thinking: step.thinking
                  ? { ...step.thinking, streaming: false }
                  : step.thinking,
              }
            : step.thinking?.streaming
              ? {
                  ...step,
                  thinking: { ...step.thinking, streaming: false },
                }
              : step,
        ),
      };
      const nextRuns = persisted.runs.map((existing) =>
        existing.id === runId ? cancelled : existing,
      );
      await this.host.write({ ...persisted, runs: nextRuns });
      return cancelled;
    });
    this.cancelledRunIds.add(runId);
    return result;
  }

  async startRun(
    agentSlug: string,
    options: StartRunOptions = {},
  ): Promise<RunRecord> {
    const queued = await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const agent = persisted.installedAgents.find(
        (installedAgent) => installedAgent.slug === agentSlug,
      );

      if (!agent) {
        throw new Error(`Agent is not installed: ${agentSlug}`);
      }
      assertAgentCompatible(
        withAgentCompatibility(agent, this.host.appVersion),
        "run",
      );

      const providers = await this.host.listProviders();
      // Honor a per-run provider override if supplied; otherwise fall
      // back to the globally-active provider. Unknown ids are an error
      // — silently dropping the override would be misleading.
      let selectedProvider: ProviderSummary | undefined;
      if (options.providerId !== undefined) {
        selectedProvider = providers.find((p) => p.id === options.providerId);
        if (!selectedProvider) {
          throw new Error(`Unknown provider: ${String(options.providerId)}`);
        }
      } else {
        selectedProvider =
          providers.find((provider) => provider.id === persisted.activeProviderId) ??
          providers[0];
      }
      const activeProvider = selectedProvider;
      const providerId =
        activeProvider?.id ?? options.providerId ?? persisted.activeProviderId;

      // Resolve which model to stamp on the run, in priority order:
      //   1. Explicit per-run override (options.model) when supplied
      //   2. Agent manifest's preferredModel IF the provider has it pulled
      //   3. User's pinned activeModelByProviderId[providerId] if set
      //   4. Provider's first reported model (defaultModel)
      const knownModels = activeProvider?.models ?? [];
      const explicitModel =
        typeof options.model === "string" && options.model.length > 0
          ? options.model
          : undefined;
      if (explicitModel) {
        if (knownModels.length > 0 && !knownModels.includes(explicitModel)) {
          const recovery =
            activeProvider?.id === "ollama"
              ? ` Pull it with \`ollama pull ${explicitModel}\` and try again.`
              : " Pick one of the models reported by the provider and try again.";
          throw new Error(
            `Model "${explicitModel}" is not available for ${activeProvider?.name ?? providerId}.${recovery}`,
          );
        }
      }
      const model = resolveRunModel({
        provider: activeProvider,
        activeModelByProviderId: persisted.activeModelByProviderId,
        preferredModel: agent.preferredModel,
        explicitModel,
      }).model;

      // Preflight the LLM provider so a clearly-actionable error is
      // returned to the renderer synchronously instead of a queued
      // run that fails moments later when the runtime can't reach it.
      if (activeProvider && !this.host.providerCanRun(activeProvider)) {
        if (activeProvider.id === "ollama") {
          throw new Error(
            "Ollama isn't reachable. Start it with `ollama serve`, then try again.",
          );
        }
        throw new Error(
          `${activeProvider.name} isn't ready. Open Settings → LLM Providers to check the connection.`,
        );
      }

      // Resolve the effective tenant at queue time. Runs cannot proceed
      // without a connected tenant — onboarding is the gate that gets a
      // user here in the first place, but defend in depth.
      //   - explicit id  -> validate it exists and pin it
      //   - omitted      -> default to currently-active tenant
      let pinnedTenantId: string;
      if (typeof options.tenantId === "string") {
        const exists = persisted.tenants.some((tenant) => tenant.id === options.tenantId);
        if (!exists) {
          throw new Error(`Tenant not connected: ${options.tenantId}`);
        }
        pinnedTenantId = options.tenantId;
      } else if (persisted.activeTenantId) {
        pinnedTenantId = persisted.activeTenantId;
      } else {
        throw new Error(
          "No tenant connected. Connect a Microsoft 365 tenant before running agents.",
        );
      }

      // Entra ID tier preflight: if the agent declares a required tier
      // and the tenant's detected tier is known to fall short, refuse
      // the run with a clear remediation message. `unknown` tier (not
      // probed yet, or probe failed) is treated as informational —
      // runs proceed and the actual Graph call may fail with a real
      // 403, which still surfaces meaningfully via the runtime.
      const requiredTier = agent.requiresEntraTier ?? "free";
      if (requiredTier !== "free") {
        const tenantRecord = persisted.tenants.find((t) => t.id === pinnedTenantId);
        const satisfies = tenantSatisfiesRequirement(tenantRecord?.entraTier, requiredTier);
        if (satisfies === false) {
          const detectedLabel = tenantRecord?.entraTier === "free" ? "Entra ID Free" : `Entra ID ${tenantRecord?.entraTier?.toUpperCase()}`;
          const requiredLabel = `Entra ID ${requiredTier.toUpperCase()}`;
          throw new Error(
            `${agent.name} requires ${requiredLabel}. The active tenant (${tenantRecord?.displayName ?? pinnedTenantId}) is on ${detectedLabel}. Microsoft 365 Business Premium includes Entra ID P1 — check your tenant's subscription, or pick a free-tier agent.`,
          );
        }
      }

      const queuedRun = createQueuedRun({ agent, providerId, model });
      queuedRun.tenantId = pinnedTenantId;
      queuedRun.trigger = options.trigger ?? "manual";

      await this.host.write({
        ...persisted,
        runs: [queuedRun, ...persisted.runs],
      });

      return { agent, providerId, model, queuedRun };
    });

    if (options.source?.type === "intune-chat" && this.host.intelligenceStore) {
      const now = new Date().toISOString();
      const statusNote =
        queued.agent.mode === "write"
          ? "Write actions still require the normal confirmation flow."
          : "Read-only agent run queued.";
      const message: IntuneChatMessage = {
        id: `msg_${randomUUID()}`,
        conversationId: options.source.conversationId,
        role: "assistant",
        content: `${queued.agent.name} started from chat. Run ${queued.queuedRun.id} is ${queued.queuedRun.status}. ${statusNote}`,
        status: "completed",
        providerId: queued.providerId,
        model: queued.model,
        createdAt: now,
      };
      this.host.intelligenceStore.insertMessage(message);
      this.host.intelligenceStore.insertToolCall({
        id: `tool_${randomUUID()}`,
        conversationId: options.source.conversationId,
        messageId: message.id,
        type: "agent-run",
        status: "completed",
        createdAt: now,
        completedAt: now,
        input: {
          agentSlug,
          originatingMessageId: options.source.messageId,
        },
        output: {
          runId: queued.queuedRun.id,
          runStatus: queued.queuedRun.status,
        },
      });
      this.host.intelligenceStore.touchConversation(options.source.conversationId, undefined, now);
    }

    void this.driveRun({
      run: queued.queuedRun,
      agent: queued.agent,
      providerId: queued.providerId,
      model: queued.model,
    });
    this.host.recordLearningEventSafely({
      tenantId: queued.queuedRun.tenantId,
      agentSlug: queued.agent.slug,
      eventType: "agent.run-started",
      source: "run",
      payload: {
        runId: queued.queuedRun.id,
        trigger: queued.queuedRun.trigger,
        mode: queued.agent.mode,
      },
    });
    return queued.queuedRun;
  }

  /**
   * Queue a host-generated baseline-rollback run. The plan is built
   * deterministically by the drift service; this method only records it
   * and parks the run at the standard typed confirmation gate. Nothing
   * applies until `confirmRun` receives the exact phrase.
   */
  async startRollbackRun(input: {
    tenantId: string;
    baselineId: string;
    plan: NonNullable<RunRecord["plan"]>;
    requiredScopes: string[];
    manualCount: number;
  }): Promise<RunRecord> {
    if (input.plan.actions.length === 0) {
      throw new Error(
        "No drifted objects can be rolled back automatically. Review the manual items in the drift detail.",
      );
    }
    const queuedAt = new Date().toISOString();
    const run: RunRecord = {
      id: `run_${randomUUID()}`,
      agentSlug: "baseline-rollback",
      origin: "baseline-rollback",
      rollback: {
        baselineId: input.baselineId,
        requiredScopes: input.requiredScopes,
        manualCount: input.manualCount,
      },
      status: "awaiting-confirmation",
      queuedAt,
      trigger: "manual",
      summary: input.plan.summary,
      steps: [],
      logs: [],
      plan: input.plan,
      tenantId: input.tenantId,
    };
    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      await this.host.write({ ...persisted, runs: [run, ...persisted.runs] });
    });
    this.host.recordLearningEventSafely({
      tenantId: input.tenantId,
      agentSlug: "baseline-rollback",
      eventType: "drift.rollback-plan-queued",
      source: "run",
      payload: {
        runId: run.id,
        baselineId: input.baselineId,
        actionCount: input.plan.actions.length,
        manualCount: input.manualCount,
      },
    });
    return run;
  }

  /**
   * Queue an external gateway proposal as a system run. The plan was
   * validated by the gateway host; it parks at the same typed
   * confirmation gate and can never apply without a human in the app.
   */
  async startExternalProposalRun(input: {
    tenantId: string;
    clientName: string;
    plan: NonNullable<RunRecord["plan"]>;
    requiredScopes: string[];
  }): Promise<RunRecord> {
    if (input.plan.actions.length === 0) {
      throw new Error("A proposal needs at least one action.");
    }
    const queuedAt = new Date().toISOString();
    const run: RunRecord = {
      id: `run_${randomUUID()}`,
      agentSlug: "external-proposal",
      origin: "external-proposal",
      external: {
        clientName: input.clientName,
        requiredScopes: input.requiredScopes,
      },
      status: "awaiting-confirmation",
      queuedAt,
      trigger: "manual",
      summary: input.plan.summary,
      steps: [],
      logs: [],
      plan: input.plan,
      tenantId: input.tenantId,
    };
    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      await this.host.write({ ...persisted, runs: [run, ...persisted.runs] });
    });
    this.host.recordLearningEventSafely({
      tenantId: input.tenantId,
      agentSlug: "external-proposal",
      eventType: "gateway.proposal-queued",
      source: "run",
      payload: {
        runId: run.id,
        clientName: input.clientName,
        actionCount: input.plan.actions.length,
      },
    });
    this.host.emitStateChanged("gateway-proposal-queued", run.id);
    return run;
  }

  async confirmRun(runId: string, phrase: string): Promise<RunRecord> {
    const transition = await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (run.status !== "awaiting-confirmation") {
        throw new Error(
          `Run ${runId} is not awaiting confirmation (status: ${run.status}).`,
        );
      }
      if (!run.plan) {
        throw new Error(`Run ${runId} has no plan to confirm.`);
      }
      if (phrase !== run.plan.confirmationPhrase) {
        throw new Error("Confirmation phrase does not match.");
      }

      // System runs (baseline rollback, external gateway proposals) are
      // host-generated and have no installed agent behind them;
      // everything above (existence, status, stored plan, exact typed
      // phrase) is enforced identically.
      if (run.origin !== undefined) {
        const confirmedAt = new Date().toISOString();
        const updated: RunRecord = {
          ...run,
          status: "running",
          confirmedAt,
          startedAt: confirmedAt,
          summary:
            run.origin === "baseline-rollback"
              ? "Rollback is applying."
              : "Approved proposal is applying.",
        };
        await this.host.write({
          ...persisted,
          runs: persisted.runs.map((existing) =>
            existing.id === runId ? updated : existing,
          ),
        });
        return { kind: "rollback" as const, updated };
      }

      const agent = persisted.installedAgents.find(
        (installedAgent) => installedAgent.slug === run.agentSlug,
      );
      if (!agent) {
        throw new Error(`Agent is not installed: ${run.agentSlug}`);
      }
      if (agent.mode !== "write") {
        throw new Error(`Agent ${run.agentSlug} is not a write agent.`);
      }

      const confirmedAt = new Date().toISOString();
      const updated: RunRecord = {
        ...run,
        status: "running",
        confirmedAt,
        startedAt: confirmedAt,
        summary: `${agent.name} is applying.`,
      };
      await this.host.write({
        ...persisted,
        runs: persisted.runs.map((existing) =>
          existing.id === runId ? updated : existing,
        ),
      });

      const providers = await this.host.listProviders();
      const activeProvider =
        providers.find((provider) => provider.id === persisted.activeProviderId) ??
        providers[0];
      const providerId = run.providerId ?? activeProvider?.id ?? persisted.activeProviderId;
      const model =
        run.model ??
        resolveProviderDefaultModel(
          activeProvider,
          persisted.activeModelByProviderId,
        ).model;

      return { kind: "agent" as const, agent, providerId, model, updated };
    });

    if (transition.kind === "rollback") {
      void this.driveSystemApply({ run: transition.updated });
      this.host.recordLearningEventSafely({
        tenantId: transition.updated.tenantId,
        agentSlug: transition.updated.agentSlug,
        eventType:
          transition.updated.origin === "baseline-rollback"
            ? "drift.rollback-plan-confirmed"
            : "gateway.proposal-confirmed",
        source: "run",
        payload: {
          runId: transition.updated.id,
          actionCount: transition.updated.plan?.actions.length ?? 0,
        },
      });
      return transition.updated;
    }

    void this.driveApply({
      run: transition.updated,
      agent: transition.agent,
      providerId: transition.providerId,
      model: transition.model,
      plan: transition.updated.plan!,
    });
    this.host.recordLearningEventSafely({
      tenantId: transition.updated.tenantId,
      agentSlug: transition.agent.slug,
      eventType: "agent.write-plan-confirmed",
      source: "run",
      payload: {
        runId: transition.updated.id,
        actionCount: transition.updated.plan?.actions.length ?? 0,
      },
    });
    return transition.updated;
  }

  async rejectRun(runId: string): Promise<RunRecord> {
    return this.host.serialize(async () => {
      const persisted = await this.host.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (run.status !== "awaiting-confirmation") {
        throw new Error(
          `Run ${runId} cannot be rejected (status: ${run.status}).`,
        );
      }

      const rejectedAt = new Date().toISOString();
      const updated: RunRecord = {
        ...run,
        status: "rejected",
        rejectedAt,
        finishedAt: rejectedAt,
        summary: `Run rejected by user.`,
      };
      await this.host.write({
        ...persisted,
        runs: persisted.runs.map((existing) =>
          existing.id === runId ? updated : existing,
        ),
      });
      this.host.recordLearningEventSafely({
        tenantId: updated.tenantId,
        agentSlug: updated.agentSlug,
        eventType: "agent.write-plan-rejected",
        source: "run",
        payload: {
          runId: updated.id,
          actionCount: updated.plan?.actions.length ?? 0,
        },
      });
      return updated;
    });
  }

  async getRun(id: string): Promise<RunRecord | undefined> {
    const persisted = await this.host.read();
    return persisted.runs.find((run) => run.id === id);
  }

  private stampTenant(run: RunRecord, tenantId: string): RunRecord {
    return { ...run, tenantId };
  }

  private async driveRun(input: {
    run: RunRecord;
    agent: AgentSummary;
    providerId: ProviderId;
    model?: string;
  }): Promise<void> {
    try {
      const driver = input.agent.mode === "write" ? executePlan : executeRun;
      const baseLlm = await this.host.buildLlm(input.providerId, input.model);
      const selection = await this.host.buildGraph(input.run.tenantId, input.agent.scopes);
      const overlay = this.host.selfTrainingPromptOverlay(selection.tenantId, input.agent.slug);
      const llm = overlay ? withSelfTrainingOverlay(baseLlm, overlay) : baseLlm;
      const stampedRun = this.stampTenant(input.run, selection.tenantId);
      await this.persistRunSnapshot(stampedRun);
      await driver({
        run: stampedRun,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        llm,
        createGraph: selection.createGraph,
        tenant: selection.tenantSession,
        connectorConfigs: await this.host.readConnectorConfigs(),
        connectorSecretsFor: (connectorId) => this.host.connectorSecretsFor(connectorId),
        confirmCapability: requestConnectorConfirmation,
        realWrites: true,
        onProgress: (next) =>
          this.persistRunSnapshot(this.stampTenant(next, selection.tenantId)),
      });
    } catch (error) {
      await this.persistFailedSnapshot(input.run, input.agent, error);
    }
  }

  private async driveApply(input: {
    run: RunRecord;
    agent: AgentSummary;
    providerId: ProviderId;
    model?: string;
    plan: NonNullable<RunRecord["plan"]>;
  }): Promise<void> {
    try {
      const baseLlm = await this.host.buildLlm(input.providerId, input.model);
      const selection = await this.host.buildGraph(input.run.tenantId, input.agent.scopes);
      const overlay = this.host.selfTrainingPromptOverlay(selection.tenantId, input.agent.slug);
      const llm = overlay ? withSelfTrainingOverlay(baseLlm, overlay) : baseLlm;
      await executeApply({
        run: input.run,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        plan: input.plan,
        llm,
        createGraph: selection.createGraph,
        tenant: selection.tenantSession,
        connectorConfigs: await this.host.readConnectorConfigs(),
        connectorSecretsFor: (connectorId) => this.host.connectorSecretsFor(connectorId),
        confirmCapability: requestConnectorConfirmation,
        realWrites: true,
        onProgress: (next) =>
          this.persistRunSnapshot(this.stampTenant(next, selection.tenantId)),
      });
    } catch (error) {
      await this.persistFailedSnapshot(input.run, input.agent, error);
    }
  }

  /**
   * Apply a confirmed system-run plan (baseline rollback or approved
   * gateway proposal). Actions run strictly in order and the apply is
   * fail-stop: the first Graph error marks the run failed with an
   * exact count of what was applied, and nothing after the failed
   * action is attempted. The stored plan is the only source of
   * requests; nothing is re-rendered at apply time.
   */
  private async driveSystemApply(input: { run: RunRecord }): Promise<void> {
    const plan = input.run.plan;
    const isRollback = input.run.origin === "baseline-rollback";
    const noun = isRollback ? "Rollback" : "Proposal";
    try {
      if (!plan) throw new Error(`${noun} run has no plan.`);
      const scopes =
        input.run.rollback?.requiredScopes ??
        input.run.external?.requiredScopes ??
        [];
      const selection = await this.host.buildGraph(input.run.tenantId, scopes);
      const graph = selection.createGraph((level, message, metadata) => {
        void this.appendRunLog(input.run.id, level, message, metadata);
      });
      let run = this.stampTenant(input.run, selection.tenantId);
      let applied = 0;
      for (const [index, action] of plan.actions.entries()) {
        const startedAt = new Date().toISOString();
        const step = {
          id: `step_rollback_${index}`,
          runId: run.id,
          label: action.label,
          status: "running" as const,
          ...(action.description ? { detail: action.description } : {}),
          startedAt,
        };
        run = { ...run, steps: [...run.steps, step] };
        await this.persistRunSnapshot(run);
        try {
          if (!action.request) {
            throw new Error(`${noun} action carries no Graph request.`);
          }
          await graph.request({
            method: action.request.method,
            path: action.request.path,
            ...(action.request.body !== undefined
              ? { body: action.request.body }
              : {}),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const finishedAt = new Date().toISOString();
          run = {
            ...run,
            steps: run.steps.map((existing) =>
              existing.id === step.id
                ? { ...existing, status: "failed", finishedAt, detail: message }
                : existing,
            ),
            status: "failed",
            finishedAt,
            error: message,
            summary: `${noun} stopped at "${action.label}" after applying ${applied} of ${plan.actions.length} actions. Nothing after the failed action was attempted.`,
          };
          await this.persistRunSnapshot(run);
          return;
        }
        applied += 1;
        run = {
          ...run,
          steps: run.steps.map((existing) =>
            existing.id === step.id
              ? { ...existing, status: "completed", finishedAt: new Date().toISOString() }
              : existing,
          ),
        };
        await this.persistRunSnapshot(run);
      }
      const manualCount = input.run.rollback?.manualCount ?? 0;
      run = {
        ...run,
        status: "completed",
        finishedAt: new Date().toISOString(),
        summary:
          (isRollback
            ? applied === 1
              ? "1 object rolled back to its baseline state."
              : `${applied} objects rolled back to their baseline state.`
            : applied === 1
              ? "1 proposed change applied."
              : `${applied} proposed changes applied.`) +
          (manualCount > 0
            ? ` ${manualCount} ${manualCount === 1 ? "change" : "changes"} still need manual review.`
            : ""),
        result: { appliedActions: applied, manualItems: manualCount },
      };
      await this.persistRunSnapshot(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.persistRunSnapshot({
        ...input.run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        summary: `${noun} failed before any action was applied: ${message}`,
        error: message,
      });
    }
  }

  private async persistFailedSnapshot(
    run: RunRecord,
    agent: AgentSummary,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date().toISOString();
    await this.persistRunSnapshot({
      ...run,
      status: "failed",
      finishedAt,
      summary: `${agent.name} failed: ${message}`,
      error: message,
    });
  }

  async persistRunSnapshot(run: RunRecord): Promise<void> {
    if (this.cancelledRunIds.has(run.id)) {
      // Run was soft-cancelled: discard further progress snapshots so
      // the stored state stays in the "cancelled" terminal state even
      // while background work finishes returning.
      return Promise.resolve();
    }
    let deliveryCandidate: RunRecord | undefined;
    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const previous = persisted.runs.find((existing) => existing.id === run.id);
      const wasTerminal = previous ? isTerminalRunStatus(previous.status) : false;
      const isNowTerminal = isTerminalRunStatus(run.status);
      const nextRun =
        isNowTerminal && run.status === "completed" && run.trigger === "schedule"
          ? this.withScheduleChangeState(run, persisted.runs)
          : run;
      const exists = previous !== undefined;
      const nextRuns = exists
        ? persisted.runs.map((existing) => (existing.id === nextRun.id ? nextRun : existing))
        : [nextRun, ...persisted.runs];
      await this.host.write({ ...persisted, runs: nextRuns });
      if (!wasTerminal && isNowTerminal) {
        this.host.notifyRunFinished(nextRun);
      }
      if (!wasTerminal && isNowTerminal) {
        deliveryCandidate = nextRun;
      }
    });
    if (deliveryCandidate) {
      await this.host.enqueueRunDeliveries(deliveryCandidate);
      void this.host.processPendingRunDeliveries();
    }
  }

  private withScheduleChangeState(run: RunRecord, runs: RunRecord[]): RunRecord {
    const previous = runs.find(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.agentSlug === run.agentSlug &&
        candidate.trigger === "schedule" &&
        candidate.status === "completed",
    );
    if (!previous) return { ...run, changeState: "new" };
    return {
      ...run,
      changeState:
        fingerprintRunOutput(previous) === fingerprintRunOutput(run)
          ? "unchanged"
          : "changed",
    };
  }

  async appendRunLog(
    runId: string,
    level: RunLogLevel,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const timestamp = new Date().toISOString();
      const nextRuns = persisted.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              logs: [
                ...run.logs,
                {
                  id: `log_${randomUUID()}`,
                  runId,
                  timestamp,
                  level,
                  message,
                  ...(metadata ? { metadata } : {}),
                },
              ],
            }
          : run,
      );
      await this.host.write({ ...persisted, runs: nextRuns });
    });
    this.host.emitStateChanged("run-log-appended", runId);
  }

  async appendRunStep(
    runId: string,
    input: {
      label: string;
      status: RunStepStatus;
      detail?: string;
    },
  ): Promise<string> {
    const stepId = `step_delivery_${randomUUID().slice(0, 8)}`;
    const timestamp = new Date().toISOString();
    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const nextRuns = persisted.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              steps: [
                ...run.steps,
                {
                  id: stepId,
                  runId,
                  label: input.label,
                  status: input.status,
                  ...(input.detail ? { detail: input.detail } : {}),
                  startedAt: timestamp,
                  ...(input.status === "running" ? {} : { finishedAt: timestamp }),
                },
              ],
            }
          : run,
      );
      await this.host.write({ ...persisted, runs: nextRuns });
    });
    this.host.emitStateChanged("run-step-appended", runId);
    return stepId;
  }

  async finishRunStep(
    runId: string,
    stepId: string,
    status: Extract<RunStepStatus, "completed" | "failed" | "skipped">,
    detail?: string,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const nextRuns = persisted.runs.map((run) =>
        run.id === runId
          ? {
              ...run,
              steps: run.steps.map((step) =>
                step.id === stepId
                  ? {
                      ...step,
                      status,
                      finishedAt,
                      ...(detail ? { detail } : {}),
                    }
                  : step,
              ),
            }
          : run,
      );
      await this.host.write({ ...persisted, runs: nextRuns });
    });
    this.host.emitStateChanged("run-step-updated", runId);
  }
}
