import { TENANT_CLOSED_COPY } from "./tenant-lifecycle.js";
import { createHash, randomUUID } from "node:crypto";

import {
  assertRunCanApply,
  assessWritePlanSafely,
  loadAgentManifestPreview,
  createQueuedRun,
  executeApply,
  executePlan,
  executeRun,
  isGraphHost,
  tenantSatisfiesRequirement,
} from "@openadminos/runtime";
import {
  agentCallsNoServiceApi,
  agentServiceIds,
  formatServiceList,
  organizationForTenant,
  serviceById,
  invalidAgentManifestCopy,
  missingServicesForAgent,
  uncoveredScopesCopy,
  unmappedScopesCopy,
  resolveProviderDefaultModel,
  resolveRunModel,
  runInitiator,
  type AgentSummary,
  type IntuneChatMessage,
  type ProviderId,
  type ProviderSummary,
  type RunGraphApi,
  type RunInitiator,
  type RunLlmApi,
  type RunLogLevel,
  type RunRecord,
  type RunStepStatus,
  type SecretAccessor,
  type StartRunOptions,
  type OrganizationRecord,
  type TenantRecord,
  type TenantSession,
  type WriteAction,
} from "@openadminos/agent-sdk";

import {
  assertAgentCompatible,
  withAgentCompatibility,
} from "./agent-draft-helpers.js";
import { requestConnectorConfirmation } from "./connector-confirm-bridge.js";
import { graphCacheResourcesForWrite } from "./intune-chat/planner.js";
import { IntelligenceSqliteStore } from "./intune-chat/sqlite-store.js";
import { fingerprintRunOutput, stableStringify } from "./run-delivery-format.js";
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
  organizations?: OrganizationRecord[];
}

/**
 * Why an agent cannot start with no organization active. Only an agent
 * that calls no service API runs without one; `services: []` with the
 * sign-in scopes still needs an organization.
 */
export function noOrganizationRunCopy(agent: Pick<AgentSummary, "name" | "scopes" | "services">): string {
  const titles = agentServiceIds(agent).map((id) => serviceById(id).title);
  const needs = titles.length > 0
    ? `reads ${formatServiceList(titles)}`
    : "uses the Microsoft 365 sign-in";
  return `No organization is active. ${agent.name} ${needs}, so it runs only in an organization where that is connected. Choose or add an organization in Connections, then run it again.`;
}

export const OTHER_ORGANIZATION_RUN_COPY =
  "That run belongs to an organization that is not active. Switch to it in the organization menu, then run the agent again.";
export const SCHEDULE_OTHER_ORGANIZATION_COPY =
  "This schedule belongs to another organization. It runs only while that organization is active.";
export const UNASSIGNED_SCHEDULE_RUN_COPY =
  "This schedule is unassigned, so it is paused. Assign it to an organization on the agent page, then run it.";

/** Why a reviewed plan cannot be applied while another organization, or none, is active. */
export function planOtherOrganizationCopy(organizationName: string): string {
  return `This plan was prepared in ${organizationName}, which is not the active organization. The plan is kept unchanged. Switch to ${organizationName} to review and apply it.`;
}

/** Why a plan prepared with no organization cannot be applied. It is never retargeted. */
export const PLAN_NO_ORGANIZATION_COPY =
  "This plan was prepared with no organization, so it cannot be applied. The plan is kept unchanged. Run the agent again in an organization to prepare a plan you can apply.";

/**
 * A start refused because its organization is not the active one, or its
 * schedule is unassigned. For a scheduled start this is waiting, not a
 * failure: the scheduler records nothing and keeps the due slot.
 */
export class OrganizationBoundaryError extends Error {
  override readonly name = "OrganizationBoundaryError";
}

/** Why nothing new starts or applies for an organization that is being disconnected. */
export const TENANT_DISCONNECTING_COPY = TENANT_CLOSED_COPY;

/**
 * What an action would send to the tenant, without the words around it.
 * A Graph write sends its request. A retire acts on `metadata.deviceId`
 * only. Any other action without a request is applied from its
 * metadata, so all of it counts. Ids, labels and descriptions do not:
 * apply runs the reviewed plan, so they cannot change what is written.
 */
function writeEffectKey(action: WriteAction): string {
  // Keyed by what the handler for this kind reads, never by which fields
  // happen to be present: a retire that also carries a request still
  // retires metadata.deviceId, so the request alone must not stand in for it.
  const request = action.request
    ? {
        method: action.request.method,
        path: action.request.path,
        ...(action.request.body !== undefined ? { body: action.request.body } : {}),
      }
    : null;
  if (action.kind === "graph-write") {
    return stableStringify({ kind: action.kind, request });
  }
  if (action.kind === "retire-managed-device") {
    return stableStringify({ kind: action.kind, deviceId: action.metadata?.deviceId ?? null });
  }
  // Any other kind: everything a handler could read.
  return stableStringify({ kind: action.kind, request, metadata: action.metadata ?? null });
}

/**
 * How a fresh read-only plan differs from the one the admin confirmed.
 * Actions are compared by what they send, as a multiset: the counts say
 * how many reviewed actions are gone and how many are new. A pure
 * reorder is not a change, because apply runs the reviewed plan in the
 * reviewed order, not the fresh one. A different confirmation phrase is.
 */
export function planChangeSinceReview(
  reviewed: NonNullable<RunRecord["plan"]>,
  fresh: NonNullable<RunRecord["plan"]>,
): { changed: boolean; reviewed: number; removed: number; added: number; phraseChanged: boolean } {
  const phraseChanged = fresh.confirmationPhrase !== reviewed.confirmationPhrase;
  const remaining = new Map<string, number>();
  for (const action of fresh.actions) {
    const key = writeEffectKey(action);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  let removed = 0;
  for (const action of reviewed.actions) {
    const key = writeEffectKey(action);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else removed += 1;
  }
  const added = [...remaining.values()].reduce((sum, count) => sum + count, 0);
  return { changed: phraseChanged || removed > 0 || added > 0, reviewed: reviewed.actions.length, removed, added, phraseChanged };
}

/**
 * The refusal when the live tenant no longer gives the confirmed plan.
 * Agent Team keeps its proposal wording; other runs point at Run again.
 */
export function planChangedSinceReviewCopy(
  change: ReturnType<typeof planChangeSinceReview>,
  kind: "office" | "agent",
  options: { usesModel?: boolean } = {},
): string {
  const actions = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "action" : "actions"}`;
  const parts: string[] = [];
  if (change.removed > 0) {
    parts.push(`${change.removed.toLocaleString("en-US")} of the ${actions(change.reviewed)} you reviewed ${change.removed === 1 ? "is" : "are"} no longer in the plan`);
  }
  if (change.added > 0) parts.push(`${actions(change.added)} ${change.added === 1 ? "is" : "are"} new`);
  if (parts.length === 0) parts.push("the confirmation phrase is different");
  const what = parts.join(", and ");
  const model = options.usesModel ? ` ${PLAN_REVALIDATION_MODEL_COPY}` : "";
  return kind === "office"
    ? `The proposed actions changed since review: ${what}. Nothing was applied.${model} Run the assignment again to review a fresh proposal.`
    : `The planned actions changed since review: ${what}. Nothing was applied.${model} Select Run again to review a fresh plan.`;
}

/** Added to the refusal when the agent called a model while planning. */
export const PLAN_REVALIDATION_MODEL_COPY = "An agent that uses a model can plan differently on a second pass, even when the tenant has not changed.";

/** Why a Graph write was refused while a confirmed plan is checked again. */
export const PLAN_REVALIDATION_READ_ONLY_COPY = "Checking a plan before apply permits only Graph reads.";

/** The Graph client for the replan before apply: reads pass, every write is refused before it is sent. */
export function readOnlyRevalidationGraph(graph: RunGraphApi): RunGraphApi {
  return {
    ...graph,
    retireManagedDevice: async () => {
      throw new Error(PLAN_REVALIDATION_READ_ONLY_COPY);
    },
    request: async (request) => {
      if (request.method !== "GET") throw new Error(PLAN_REVALIDATION_READ_ONLY_COPY);
      return graph.request(request);
    },
  };
}

/**
 * The connector transport for the replan before apply: requests to Graph
 * other than GET are refused before they are sent, and everything else
 * goes through `transport`, so its lifecycle guard and Graph write audit
 * still apply. Without a transport it wraps the global fetch, so a
 * connector never falls back to an unguarded one.
 */
export function readOnlyRevalidationTransport(
  transport: { fetch?: typeof fetch; assertEgress?: () => void } | undefined,
): { fetch: typeof fetch; assertEgress?: () => void } {
  const base: typeof fetch = transport?.fetch ?? ((input, init) => fetch(input, init));
  return {
    ...transport,
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET" && isGraphHost(url.hostname)) {
        throw new Error(`${method} ${url.pathname} was not sent. ${PLAN_REVALIDATION_READ_ONLY_COPY}`);
      }
      return base(input, init);
    }) as typeof fetch,
  };
}

/** `run` with the model usage of `source`, a later snapshot of the same run. */
function withUsageOf(run: RunRecord, source: Pick<RunRecord, "tokens" | "usage">): RunRecord {
  const { tokens: _tokens, usage: _usage, ...rest } = run;
  return {
    ...rest,
    ...(source.tokens !== undefined ? { tokens: source.tokens } : {}),
    ...(source.usage !== undefined ? { usage: source.usage } : {}),
  };
}

/** How many gateway proposals one paired client may have waiting for review at once. */
export const GATEWAY_PENDING_PROPOSALS_PER_CLIENT = 5;
/** How long an identical proposal is refused after the admin rejected it. */
export const GATEWAY_REJECTED_PROPOSAL_COOLDOWN_MS = 15 * 60_000;

/**
 * A rejected gateway proposal whose cooldown is still running. Run history
 * retention keeps it, because the cooldown is read from this record and
 * pruning it would let the same proposal be queued again at once.
 */
export function gatewayRejectionCoolingDown(run: RunRecord, nowMs: number): boolean {
  if (run.status !== "rejected" || !run.external?.clientId || !run.rejectedAt) return false;
  const rejectedAtMs = Date.parse(run.rejectedAt);
  return Number.isFinite(rejectedAtMs) && nowMs - rejectedAtMs < GATEWAY_REJECTED_PROPOSAL_COOLDOWN_MS;
}

/**
 * Identifies what a gateway plan would change: the ordered Graph
 * requests, not the client's labels or title, so renaming a rejected
 * proposal does not make it a new one.
 */
export function externalPlanDigest(plan: NonNullable<RunRecord["plan"]>): string {
  return createHash("sha256")
    .update(stableStringify(plan.actions.map((action) => action.request ?? null)))
    .digest("hex");
}

/** A gateway proposal the host refused to queue; the message goes back to the client. */
export class GatewayProposalRefusedError extends Error {
  override readonly name = "GatewayProposalRefusedError";
  constructor(
    readonly reason: "pending-limit" | "rejected-cooldown",
    message: string,
    readonly details: { planDigest: string; existingRunId?: string; retryAfter?: string },
  ) {
    super(message);
  }
}

export function gatewayPendingLimitCopy(clientName: string): string {
  return `${clientName} already has ${GATEWAY_PENDING_PROPOSALS_PER_CLIENT} proposals waiting for review in OpenAdminOS, the most one client can have. No new proposal was queued. Ask the admin to confirm or reject a waiting proposal, then propose again.`;
}

export function gatewayRejectedCooldownCopy(clientName: string, minutesLeft: number): string {
  const window = GATEWAY_REJECTED_PROPOSAL_COOLDOWN_MS / 60_000;
  return `The admin rejected an identical proposal from ${clientName} less than ${window} minutes ago. No new proposal was queued. Propose it again in ${minutesLeft} ${minutesLeft === 1 ? "minute" : "minutes"} at the earliest, or ask the admin what to change first.`;
}

/** What a Splashtop change run needs at apply: the team and a request bound to the organization's host and token. */
/** How a run uses its Graph client: cancellation, sign-in, and what its writes are audited under. */
export interface RunGraphExecution {
  signal: AbortSignal;
  allowInteractive: boolean;
  onAuthRequired(): Promise<void>;
  audit?: { runId: string; agentSlug: string; initiator: RunInitiator };
}

export interface SplashtopRunClient {
  teamId: number;
  /** Refuses anything but the request kinds the host plans, for this team. */
  apply(action: WriteAction, signal: AbortSignal): Promise<void>;
}

export interface RunServiceHost {
  /**
   * False once a disconnect of this tenant began, and for work of an
   * older generation of it (see tenant-lifecycle.ts).
   */
  tenantWritable?(tenantId: string): boolean;
  /**
   * Run a tenant's work under its lease: refused when the tenant is not
   * open, drained by Disconnect, and `signal` fires when it starts closing.
   */
  tenantLease?<T>(tenantId: string, work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** The guarded connector transport for a tenant's runs (see tenant-lifecycle.ts). */
  connectorTransport?(tenantId: string, audit?: RunGraphExecution["audit"]): { fetch: typeof fetch; assertEgress: () => void };
  read(): Promise<RunPersistedState>;
  write(state: RunPersistedState): Promise<void>;
  serialize<T>(task: () => Promise<T>): Promise<T>;
  listProviders(): Promise<ProviderSummary[]>;
  providerCanRun(
    provider: ProviderSummary | undefined,
  ): provider is ProviderSummary & { status: "connected" | "available" };
  validateOfficeApproval?(run: RunRecord): Promise<void>;
  buildLlm(providerId: ProviderId, model: string | undefined): Promise<RunLlmApi>;
  buildGraph(
    pinnedTenantId?: string,
    agentScopes?: string[],
    execution?: RunGraphExecution,
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
  /**
   * The Splashtop connection a "splashtop-change" run applies through,
   * read again at apply: the run's organization must still hold its
   * tenant and the same Splashtop team and region. Throws a designed
   * message otherwise; nothing is sent then.
   */
  splashtopForRun?(run: RunRecord): Promise<SplashtopRunClient>;
  /** The validation error of the agent's manifest on disk, if it is invalid. */
  agentManifestError?(agent: AgentSummary): string | undefined;
  emitStateChanged(reason: string, runId?: string): void;
  enqueueRunDeliveries(run: RunRecord): Promise<void>;
  processPendingRunDeliveries(): Promise<void>;
  readonly appVersion: string;
  readonly intelligenceStore: IntelligenceSqliteStore | undefined;
}

export class RunService {
  private readonly controllers = new Map<string, AbortController>();
  /** The work driving each run, so a disconnect can wait for it to stop. */
  private readonly drives = new Map<string, Promise<void>>();

  /** Admission: a clear refusal before anything is written for a closing tenant. */
  private assertTenantOpen(tenantId: string | undefined): void {
    if (tenantId && this.host.tenantWritable && !this.host.tenantWritable(tenantId)) throw new OrganizationBoundaryError(TENANT_DISCONNECTING_COPY);
  }

  /**
   * Drive a run under its tenant's lease. When the tenant starts closing,
   * the lease signal cancels the run and Disconnect waits for the drive.
   */
  private track(runId: string, tenantId: string | undefined, start: () => Promise<void>): void {
    const leased = tenantId && this.host.tenantLease
      ? this.host.tenantLease(tenantId, async (signal) => {
          const stop = () => this.controllers.get(runId)?.abort(signal.reason);
          signal.addEventListener("abort", stop, { once: true });
          try { return await start(); } finally { signal.removeEventListener("abort", stop); }
        })
      : start();
    const settled = leased.catch(() => undefined).finally(() => {
      if (this.drives.get(runId) === settled) this.drives.delete(runId);
    });
    this.drives.set(runId, settled);
  }

  private readonly progress = new Map<string, { snapshot: RunRecord; waiters: Array<{ resolve(): void; reject(error: unknown): void }> }>();
  private readonly progressDrains = new Set<string>();

  /** Coalesce cumulative streaming snapshots so a terminal state cannot queue behind every token. */
  queueRunSnapshot(run: RunRecord): Promise<void> {
    const finished = new Promise<void>((resolve, reject) => {
      const pending = this.progress.get(run.id);
      if (pending) {
        pending.snapshot = run;
        pending.waiters.push({ resolve, reject });
      } else {
        this.progress.set(run.id, { snapshot: run, waiters: [{ resolve, reject }] });
      }
    });
    if (!this.progressDrains.has(run.id)) {
      this.progressDrains.add(run.id);
      void this.drainProgress(run.id);
    }
    return finished;
  }

  private async drainProgress(runId: string): Promise<void> {
    try {
      while (this.progress.has(runId)) {
        const pending = this.progress.get(runId)!;
        this.progress.delete(runId);
        try {
          await this.persistRunSnapshot(pending.snapshot);
          for (const waiter of pending.waiters) waiter.resolve();
        } catch (error) { for (const waiter of pending.waiters) waiter.reject(error); }
      }
    } finally { this.progressDrains.delete(runId); }
  }


  constructor(private readonly host: RunServiceHost) {}

  async cancelRun(runId: string): Promise<RunRecord> {
    const result = await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      if (
        run.status === "planned" ||
        run.status === "completed" ||
        run.status === "failed" ||
        run.status === "rejected" ||
        run.status === "cancelled"
      ) {
        // Already terminal, nothing to cancel.
        return run;
      }

      this.controllers.get(runId)?.abort(new Error("Run cancelled by user."));
      const finishedAt = new Date().toISOString();
      const cancelled: RunRecord = {
        ...run,
        status: "cancelled",
        finishedAt,
        // Overwrite any stale in-progress summary (e.g. "X is running.")
        // with an explicit cancellation message. The original summary
        // would otherwise leak into Activity rows long after the cancel.
        summary: run.confirmedAt
          ? "Cancelled by user. Requests already sent may have completed; review the action steps before retrying."
          : "Cancelled by user.",
        liveSummary: undefined,
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
    this.host.emitStateChanged("run-cancelled", runId);
    return result;
  }

  /**
   * Queue a run. `boundary.activeOrganizationOnly` is set for every start
   * that comes from the renderer: it may only pin the active tenant.
   * Host-owned callers (multi-tenant batches, Agent Team) pin their own
   * tenants. A scheduled start is always held to the active organization,
   * checked here under the same lock that queues the run.
   */
  async startRun(
    agentSlug: string,
    options: StartRunOptions = {},
    boundary: { activeOrganizationOnly?: boolean } = {},
  ): Promise<RunRecord> {
    const queued = await this.host.serialize(async () => {
      const persisted = await this.host.read();
      let agent = persisted.installedAgents.find(
        (installedAgent) => installedAgent.slug === agentSlug,
      );

      if (!agent) {
        throw new Error(`Agent is not installed: ${agentSlug}`);
      }
      // A manifest that no longer validates cannot be trusted to run,
      // manually, from Chat or from a schedule.
      const manifestError = this.host.agentManifestError?.(agent);
      if (manifestError) throw new Error(invalidAgentManifestCopy(agent.name, manifestError));
      const requestedTenantId =
        typeof options.tenantId === "string" ? options.tenantId : persisted.activeTenantId;
      // Admission closes before a disconnect drains its work, under this lock.
      this.assertTenantOpen(requestedTenantId);
      if (options.dryRun !== undefined && typeof options.dryRun !== "boolean") {
        throw new Error("startRun.dryRun must be a boolean.");
      }
      if (options.dryRun && agent.mode !== "write") {
        throw new Error("Dry run is only available for write agents. Run this read agent normally.");
      }
      if ((options.dryRun || options.runForRealOfRunId) && options.trigger === "schedule") {
        throw new Error("Dry runs and Run for real are manual run options. Open the agent to run it manually.");
      }
      // An installed agent's schedule. Agent Team persona recurrence also
      // starts with trigger "schedule", but it is host-owned (`office` is
      // set, and the renderer cannot pass it) and keeps the persona's own
      // validated tenant binding; whether personas move to organizations is
      // an open question for the maintainer.
      const agentSchedule = options.trigger === "schedule" && !options.office;
      // Hard constraint 3: a start the renderer asks for, and every
      // installed-agent scheduled start, runs only in the organization
      // active right now.
      if (
        (boundary.activeOrganizationOnly || agentSchedule) &&
        options.tenantId !== undefined &&
        options.tenantId !== persisted.activeTenantId
      ) {
        throw new OrganizationBoundaryError(OTHER_ORGANIZATION_RUN_COPY);
      }
      if (agentSchedule) {
        const active = organizationForTenant(persisted.organizations ?? [], persisted.activeTenantId);
        if (!agent.schedule?.organizationId) {
          throw new OrganizationBoundaryError(UNASSIGNED_SCHEDULE_RUN_COPY);
        }
        if (!active || agent.schedule.organizationId !== active.id) {
          throw new OrganizationBoundaryError(SCHEDULE_OTHER_ORGANIZATION_COPY);
        }
      }
      if (options.dryRun && (options.office || options.officeContext)) {
        throw new Error("Dry runs are available from the agent page or Chat. Run this assignment from Agent Team normally.");
      }
      if (options.runForRealOfRunId) {
        const original = persisted.runs.find(run => run.id === options.runForRealOfRunId);
        if (
          !original?.dryRun || original.status !== "planned" ||
          original.agentSlug !== agentSlug || !original.tenantId ||
          !original.inputSettings || agent.mode !== "write" ||
          original.office || original.officeContext
        ) {
          throw new Error("The completed dry run is unavailable. Open the write agent and prepare a new run.");
        }
        if (options.dryRun || options.retryOfRunId || options.office || options.officeContext) {
          throw new Error("Run for real must start a fresh normal run. Open the completed dry run and try again.");
        }
        if (
          (options.tenantId && options.tenantId !== original.tenantId) ||
          (options.providerId && options.providerId !== original.providerId) ||
          (options.model && options.model !== original.model)
        ) {
          throw new Error("Run for real must keep the dry run tenant, provider, and model. Start a new run from the agent page to change them.");
        }
        agent = { ...agent, settings: structuredClone(original.inputSettings) };
        options = {
          ...options,
          tenantId: original.tenantId,
          providerId: original.providerId,
          model: original.model,
        };
      }
      assertAgentCompatible(
        withAgentCompatibility(agent, this.host.appVersion),
        "run",
      );

      if (options.retryOfRunId) {
        const original = persisted.runs.find(run => run.id === options.retryOfRunId);
        if (!original || original.agentSlug !== agentSlug || !original.officeContext || !original.tenantId || !isTerminalRunStatus(original.status)) throw new Error("The original Team task is unavailable or still running. Open Agent Team to review the assignment.");
        if (agent.mode !== 'read') throw new Error("Retry write assignments from Agent Team so their assignment approval is reviewed again.");
        if (options.tenantId && options.tenantId !== original.tenantId) throw new Error("A Team retry cannot move evidence to another tenant.");
        if (options.office || options.officeContext) throw new Error("A retry must use the original host-owned task context.");
        options = { ...options, tenantId: original.tenantId, providerId: options.providerId ?? original.providerId, model: options.model ?? original.model, officeContext: structuredClone(original.officeContext) };
      }

      const providers = await this.host.listProviders();
      // Honor a per-run provider override if supplied; otherwise fall
      // back to the globally-active provider. Unknown ids are an error
      // because silently dropping the override would be misleading.
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

      if (options.retryOfRunId && activeProvider?.isLocal !== true) {
        throw new Error("Review and retry this assignment in Agent Team to confirm the hosted provider destination before sending its evidence.");
      }

      // Resolve the effective tenant at queue time. Runs cannot proceed
      // without a connected tenant. Onboarding is the gate that gets a
      // user here in the first place, but defend in depth.
      //   - explicit id  -> validate it exists and pin it
      //   - omitted      -> default to currently-active tenant
      //   - none active  -> only an agent that calls no service API runs,
      //                     manually, with no tenant at all
      let pinnedTenantId: string | undefined;
      if (typeof options.tenantId === "string") {
        const exists = persisted.tenants.some((tenant) => tenant.id === options.tenantId);
        if (!exists) {
          throw new Error(`Tenant not connected: ${options.tenantId}`);
        }
        pinnedTenantId = options.tenantId;
      } else if (persisted.activeTenantId) {
        pinnedTenantId = persisted.activeTenantId;
      } else if (
        !agentCallsNoServiceApi(agent) ||
        options.trigger === "schedule" ||
        options.office ||
        options.officeContext ||
        options.retryOfRunId
      ) {
        throw new Error(noOrganizationRunCopy(agent));
      }
      // Run for real and Team retries take the tenant of the original run;
      // a renderer start, and an installed-agent scheduled start, still
      // runs only in the active organization.
      if (
        (boundary.activeOrganizationOnly || agentSchedule) &&
        pinnedTenantId !== undefined &&
        pinnedTenantId !== persisted.activeTenantId
      ) {
        throw new OrganizationBoundaryError(OTHER_ORGANIZATION_RUN_COPY);
      }

      // Entra ID tier preflight: if the agent declares a required tier
      // and the tenant's detected tier is known to fall short, refuse
      // the run with a clear remediation message. `unknown` tier (not
      // probed yet, or probe failed) is treated as informational :
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
            `${agent.name} requires ${requiredLabel}. The active tenant (${tenantRecord?.displayName ?? pinnedTenantId}) is on ${detectedLabel}. Microsoft 365 Business Premium includes Entra ID P1. Check your tenant's subscription, or pick a free-tier agent.`,
          );
        }
      }

      // A scope no service lists is a dependency that cannot be checked.
      // Block the run rather than treat it as needing no service.
      const unmapped = unmappedScopesCopy(agent.scopes);
      if (unmapped) throw new Error(unmapped);
      // Declared services must cover every scope, or the service preflight
      // below checks the wrong services. Agents installed before the parser
      // enforced this still carry such a declaration.
      const uncovered = uncoveredScopesCopy(agent);
      if (uncovered) throw new Error(uncovered);

      // Service preflight: an agent whose service is not connected for
      // this tenant cannot reach its data. Refuse with the service to add.
      const runTenant = persisted.tenants.find((t) => t.id === pinnedTenantId);
      const missingServices = runTenant
        ? missingServicesForAgent(runTenant, agentServiceIds(agent))
        : [];
      if (runTenant && missingServices.length > 0) {
        const titles = missingServices.map((service) => service.title);
        const one = titles.length === 1;
        throw new Error(
          `${agent.name} needs ${formatServiceList(titles)}, which ${one ? "is" : "are"} not connected for ${runTenant.displayName}. Add ${one ? "it" : "them"} in Connections, then run the agent again.`,
        );
      }

      if ((options.office || options.officeContext) && persisted.runs.some(r=>(r.office || r.officeContext) && ["queued","running"].includes(r.status))) throw new Error("Team compute slot is occupied. This assignment remains queued.");
      if (options.dryRun) {
        const manifest = loadAgentManifestPreview(agent)?.manifest;
        const defaults = Object.fromEntries(
          (manifest?.definition.settings ?? [])
            .filter(setting => setting.default !== undefined)
            .map(setting => [setting.id, setting.default]),
        );
        agent = { ...agent, settings: { ...defaults, ...agent.settings } };
      }
      const queuedRun = createQueuedRun({ agent, providerId, model, dryRun: options.dryRun });
      if (options.dryRun || options.runForRealOfRunId) queuedRun.inputSettings = structuredClone(agent.settings ?? {});
      if (options.runForRealOfRunId) queuedRun.runForRealOfRunId = options.runForRealOfRunId;
      queuedRun.assessmentKey = createHash("sha256").update(JSON.stringify({ schema: 1,
        slug: agent.slug, version: agent.version, manifest: agent.provenance?.manifestSha256,
        settings: agent.settings, personaId: options.office?.personaId, officeAssessment:options.officeContext?.assessmentKey })).digest("hex");
      if (options.retryOfRunId) queuedRun.retryOfRunId = options.retryOfRunId;
      if (pinnedTenantId) queuedRun.tenantId = pinnedTenantId;
      queuedRun.trigger = options.trigger ?? "manual";
      queuedRun.initiator = options.office ? "office" : queuedRun.trigger === "schedule" ? "schedule" : "person";
      if (options.office) queuedRun.office = options.office;
      if (options.officeContext) {
        if ((!options.office && !options.retryOfRunId) || options.officeContext.tenantId !== pinnedTenantId || Buffer.byteLength(JSON.stringify(options.officeContext), "utf8") > 40000) throw new Error("Invalid team task context.");
        for (const source of options.officeContext.evidence) {
          const evidence = persisted.runs.find(r=>r.id===source.runId);
          if (!evidence || evidence.tenantId !== pinnedTenantId || evidence.status !== "completed") throw new Error("Team evidence is missing or belongs to another tenant.");
        }
        queuedRun.officeContext = options.officeContext;
      }

      await this.host.write({
        ...persisted,
        runs: [queuedRun, ...persisted.runs],
      });

      return { agent, providerId, model, queuedRun };
    });

    if (options.source?.type === "intune-chat" && this.host.intelligenceStore) {
      const now = new Date().toISOString();
      const statusNote = queued.queuedRun.dryRun
        ? "Dry run only. Nothing will be applied."
        : queued.agent.mode === "write"
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

    this.track(queued.queuedRun.id, queued.queuedRun.tenantId, () => this.driveRun({
      run: queued.queuedRun,
      agent: queued.agent,
      providerId: queued.providerId,
      model: queued.model,
    }));
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
      initiator: "rollback",
      summary: input.plan.summary,
      steps: [],
      logs: [],
      plan: input.plan,
      tenantId: input.tenantId,
    };
    await this.host.serialize(async () => {
      this.assertTenantOpen(input.tenantId);
      const persisted = await this.host.read();
      run.riskAssessment = this.assessPlan(run, persisted);
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
   * Under the state lock, an identical proposal (same client, tenant and
   * plan digest) already waiting is returned instead of a second one; a
   * client at the pending limit, or one re-proposing a plan the admin
   * rejected within the cooldown window, is refused.
   */
  async startExternalProposalRun(input: {
    tenantId: string;
    clientId: string;
    clientName: string;
    plan: NonNullable<RunRecord["plan"]>;
    requiredScopes: string[];
  }): Promise<{ run: RunRecord; alreadyWaiting: boolean }> {
    if (input.plan.actions.length === 0) {
      throw new Error("A proposal needs at least one action.");
    }
    const planDigest = externalPlanDigest(input.plan);
    const queuedAt = new Date().toISOString();
    const run: RunRecord = {
      id: `run_${randomUUID()}`,
      agentSlug: "external-proposal",
      origin: "external-proposal",
      external: {
        clientId: input.clientId,
        clientName: input.clientName,
        requiredScopes: input.requiredScopes,
      },
      status: "awaiting-confirmation",
      queuedAt,
      trigger: "manual",
      initiator: "gateway",
      summary: input.plan.summary,
      steps: [],
      logs: [],
      plan: input.plan,
      tenantId: input.tenantId,
    };
    const existing = await this.host.serialize(async () => {
      this.assertTenantOpen(input.tenantId);
      const persisted = await this.host.read();
      const fromClient = persisted.runs.filter(
        (candidate) =>
          candidate.origin === "external-proposal" &&
          candidate.external?.clientId === input.clientId &&
          candidate.tenantId === input.tenantId,
      );
      const pending = fromClient.filter((candidate) => candidate.status === "awaiting-confirmation");
      const same = (candidate: RunRecord) =>
        candidate.plan !== undefined && externalPlanDigest(candidate.plan) === planDigest;
      const waiting = pending.find(same);
      if (waiting) return waiting;
      const nowMs = Date.parse(queuedAt);
      const rejectedAtMs = fromClient
        .filter((candidate) => candidate.status === "rejected" && candidate.rejectedAt && same(candidate))
        .map((candidate) => Date.parse(candidate.rejectedAt!))
        .filter((at) => Number.isFinite(at) && nowMs - at < GATEWAY_REJECTED_PROPOSAL_COOLDOWN_MS)
        .sort((left, right) => right - left)[0];
      if (rejectedAtMs !== undefined) {
        const retryAtMs = rejectedAtMs + GATEWAY_REJECTED_PROPOSAL_COOLDOWN_MS;
        throw new GatewayProposalRefusedError(
          "rejected-cooldown",
          gatewayRejectedCooldownCopy(input.clientName, Math.max(1, Math.ceil((retryAtMs - nowMs) / 60_000))),
          { planDigest, retryAfter: new Date(retryAtMs).toISOString() },
        );
      }
      if (pending.length >= GATEWAY_PENDING_PROPOSALS_PER_CLIENT) {
        throw new GatewayProposalRefusedError("pending-limit", gatewayPendingLimitCopy(input.clientName), { planDigest });
      }
      run.riskAssessment = this.assessPlan(run, persisted);
      await this.host.write({ ...persisted, runs: [run, ...persisted.runs] });
      return undefined;
    });
    if (existing) return { run: existing, alreadyWaiting: true };
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
    return { run, alreadyWaiting: false };
  }

  /**
   * Queue a host-built Splashtop change plan. Like a rollback it parks at
   * the typed confirmation gate; it applies only through the Splashtop
   * connection of the organization that holds `tenantId`.
   */
  async startSplashtopChangeRun(input: {
    tenantId: string;
    organizationId: string;
    kind: NonNullable<RunRecord["splashtop"]>["kind"];
    region: NonNullable<RunRecord["splashtop"]>["region"];
    /** The connection the plan was read through; apply refuses any other. */
    connectedAt: string;
    plan: NonNullable<RunRecord["plan"]>;
  }): Promise<RunRecord> {
    if (input.plan.actions.length === 0) throw new Error("A Splashtop change needs at least one target.");
    const queuedAt = new Date().toISOString();
    const run: RunRecord = {
      id: `run_${randomUUID()}`,
      agentSlug: "splashtop-change",
      origin: "splashtop-change",
      splashtop: { organizationId: input.organizationId, kind: input.kind, region: input.region, connectedAt: input.connectedAt },
      status: "awaiting-confirmation",
      queuedAt,
      trigger: "manual",
      initiator: "person",
      summary: input.plan.summary,
      steps: [],
      logs: [],
      plan: input.plan,
      tenantId: input.tenantId,
    };
    await this.host.serialize(async () => {
      this.assertTenantOpen(input.tenantId);
      const persisted = await this.host.read();
      run.riskAssessment = this.assessPlan(run, persisted);
      await this.host.write({ ...persisted, runs: [run, ...persisted.runs] });
    });
    this.host.recordLearningEventSafely({
      tenantId: input.tenantId,
      agentSlug: "splashtop-change",
      eventType: "splashtop.change-plan-queued",
      source: "run",
      payload: { runId: run.id, kind: input.kind, actionCount: input.plan.actions.length },
    });
    this.host.emitStateChanged("splashtop-change-queued", run.id);
    return run;
  }

  /**
   * Apply a reviewed plan. `boundary.activeOrganizationOnly` is set for
   * every approval from the renderer, which covers agent write plans,
   * baseline rollbacks, gateway proposals and Agent Team approvals: the
   * plan's tenant must be the active one, checked under this lock. A
   * refused plan is left exactly as it was; it is never retargeted.
   */
  async confirmRun(
    runId: string,
    phrase: string,
    boundary: { activeOrganizationOnly?: boolean } = {},
  ): Promise<RunRecord> {
    const transition = await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const run = persisted.runs.find((existing) => existing.id === runId);
      if (!run) {
        throw new Error(`Run not found: ${runId}`);
      }
      assertRunCanApply(run);
      this.assertTenantOpen(run.tenantId);
      if (run.status !== "awaiting-confirmation") {
        throw new Error(
          `Run ${runId} is not awaiting confirmation (status: ${run.status}).`,
        );
      }
      if (!run.plan) {
        throw new Error(`Run ${runId} has no plan to confirm.`);
      }
      // A plan with no organization has no tenant to apply to, whatever is
      // active now; it is refused here so it stays exactly as it was.
      if (!run.tenantId) throw new OrganizationBoundaryError(PLAN_NO_ORGANIZATION_COPY);
      if (boundary.activeOrganizationOnly && run.tenantId !== persisted.activeTenantId) {
        const name =
          organizationForTenant(persisted.organizations ?? [], run.tenantId)?.name ??
          persisted.tenants.find((tenant) => tenant.id === run.tenantId)?.displayName ??
          "another organization";
        throw new OrganizationBoundaryError(planOtherOrganizationCopy(name));
      }
      if (phrase !== run.plan.confirmationPhrase) {
        throw new Error("Confirmation phrase does not match.");
      }

      if (run.office) await this.host.validateOfficeApproval?.(run);

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
              : run.origin === "splashtop-change"
                ? "Splashtop changes are applying."
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

      return {
        kind: "agent" as const,
        agent: run.inputSettings ? { ...agent, settings: structuredClone(run.inputSettings) } : agent,
        providerId, model, updated,
      };
    });

    if (transition.kind === "rollback") {
      this.track(transition.updated.id, transition.updated.tenantId, () => this.driveSystemApply({ run: transition.updated }));
      this.host.recordLearningEventSafely({
        tenantId: transition.updated.tenantId,
        agentSlug: transition.updated.agentSlug,
        eventType:
          transition.updated.origin === "baseline-rollback"
            ? "drift.rollback-plan-confirmed"
            : transition.updated.origin === "splashtop-change"
              ? "splashtop.change-plan-confirmed"
              : "gateway.proposal-confirmed",
        source: "run",
        payload: {
          runId: transition.updated.id,
          actionCount: transition.updated.plan?.actions.length ?? 0,
        },
      });
      return transition.updated;
    }

    this.track(transition.updated.id, transition.updated.tenantId, () => this.driveApply({
      run: transition.updated,
      agent: transition.agent,
      providerId: transition.providerId,
      model: transition.model,
      plan: transition.updated.plan!,
    }));
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

  private executionOptions(run: RunRecord, signal: AbortSignal): RunGraphExecution {
    return {
      signal,
      audit: { runId: run.id, agentSlug: run.agentSlug, initiator: runInitiator(run) },
      allowInteractive: run.trigger !== "schedule",
      onAuthRequired: async () => {
        const message = "Waiting for Microsoft sign-in. Complete sign-in in your browser, or select Cancel run. This request expires after five minutes.";
        await this.host.serialize(async () => {
          signal.throwIfAborted();
          const state = await this.host.read();
          await this.host.write({ ...state, runs: state.runs.map((current) =>
            current.id === run.id && !isTerminalRunStatus(current.status)
              ? { ...current, summary: message, steps: current.steps.map((step) =>
                step.status === "running" ? { ...step, detail: message } : step) }
              : current) });
        });
        await this.appendRunLog(run.id, "info", message);
      },
    };
  }

  async recoverInterruptedRuns(): Promise<void> {
    await this.host.serialize(async () => {
      const state = await this.host.read();
      const finishedAt = new Date().toISOString();
      const runs = state.runs.map((run): RunRecord => {
        if (!["running", "queued"].includes(run.status) || this.controllers.has(run.id)) return run;
        const message = run.confirmedAt
          ? "OpenAdminOS closed during this run. Requests already sent may have completed. Review the tenant before running it again."
          : "OpenAdminOS closed before this run finished. Run the agent again to retry.";
        return { ...run, status: "failed", finishedAt, summary: message, error: message,
          liveSummary: undefined,
          steps: run.steps.map((step) => ({ ...step,
            ...(step.status === "running" ? { status: "failed" as const, finishedAt, detail: message } : {}),
            ...(step.thinking ? { thinking: { ...step.thinking, streaming: false } } : {}),
          })),
        };
      });
      if (runs.some((run, index) => run !== state.runs[index])) await this.host.write({ ...state, runs });
    });
  }

  /** Every run builds the provider LLM. */
  private async baseRunLlm(
    _run: RunRecord,
    _agent: AgentSummary,
    providerId: ProviderId,
    model: string | undefined,
  ): Promise<RunLlmApi> {
    return await this.host.buildLlm(providerId, model);
  }

  private withOverlay(_run: RunRecord, llm: RunLlmApi, tenantId: string, agentSlug: string): RunLlmApi {
    const overlay = this.host.selfTrainingPromptOverlay(tenantId, agentSlug);
    return overlay ? withSelfTrainingOverlay(llm, overlay) : llm;
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
    const controller = new AbortController();
    this.controllers.set(input.run.id, controller);
    try {
      if ((await this.getRun(input.run.id))?.status === "cancelled") return;
      const driver = input.agent.mode === "write" ? executePlan : executeRun;
      const baseLlm = await this.baseRunLlm(input.run, input.agent, input.providerId, input.model);
      // A run without a tenant was admitted only for an agent that calls
      // no service API. It gets no tenant session, and a Graph client
      // that refuses every call, so nothing can reach a service.
      // A run without a tenant whose agent now needs a service fails
      // closed: it never falls back to the organization active now.
      if (!input.run.tenantId && !agentCallsNoServiceApi(input.agent)) {
        throw new Error(noOrganizationRunCopy(input.agent));
      }
      const selection = !input.run.tenantId
        ? { createGraph: () => noServiceGraph(), tenantId: undefined, tenantSession: undefined }
        : await this.host.buildGraph(input.run.tenantId, input.agent.scopes, this.executionOptions(input.run, controller.signal));
      const llm = selection.tenantId
        ? this.withOverlay(input.run, baseLlm, selection.tenantId, input.agent.slug)
        : baseLlm;
      const stamp = (next: RunRecord) => (selection.tenantId ? this.stampTenant(next, selection.tenantId) : next);
      const stampedRun = stamp(input.run);
      await this.persistRunSnapshot(stampedRun);
      controller.signal.throwIfAborted();
      await driver({
        signal: controller.signal,
        run: stampedRun,
        agent: input.agent,
        providerId: input.providerId,
        model: input.model,
        llm,
        createGraph: selection.createGraph,
        ...(selection.tenantSession ? { tenant: selection.tenantSession } : {}),
        connectorConfigs: await this.host.readConnectorConfigs(),
        connectorSecretsFor: (connectorId) => this.host.connectorSecretsFor(connectorId),
        ...(input.run.tenantId && this.host.connectorTransport ? { connectorTransport: this.host.connectorTransport(input.run.tenantId, { runId: input.run.id, agentSlug: input.run.agentSlug, initiator: runInitiator(input.run) }) } : {}),
        confirmCapability: (info) => requestConnectorConfirmation(info, controller.signal),
        realWrites: true,
        onProgress: (next) => this.queueRunSnapshot(stamp(next)),
      });
    } catch (error) {
      await this.persistFailedSnapshot(input.run, input.agent, error);
    } finally {
      if (this.controllers.get(input.run.id) === controller) this.controllers.delete(input.run.id);
    }
  }

  /**
   * Confirmed writes mutate tenant state outside the chat cache. Mark
   * the affected resources stale so the next chat question refreshes
   * instead of answering from the pre-write snapshot until TTL expiry.
   */
  private invalidateGraphCacheAfterWrite(
    runId: string,
    tenantId: string,
    input: { scopes?: string[]; paths?: string[] },
  ): void {
    try {
      const store = this.host.intelligenceStore;
      if (!store) return;
      const resources = graphCacheResourcesForWrite(input);
      const marked = store.markGraphResourcesStale(tenantId, resources);
      if (marked > 0) {
        void this.appendRunLog(
          runId,
          "info",
          `Marked ${marked} cached Graph resources stale after the confirmed write. Chat will refresh them before the next answer.`,
        );
      }
    } catch {
      // Cache invalidation must never fail a completed write run.
    }
  }

  private async driveApply(input: {
    run: RunRecord;
    agent: AgentSummary;
    providerId: ProviderId;
    model?: string;
    plan: NonNullable<RunRecord["plan"]>;
  }): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(input.run.id, controller);
    // The replan calls the model like any other phase, and those calls are
    // billed. Its snapshots carry the run's usage so far plus its own, and
    // that total stays on the run however apply ends.
    let usage: Pick<RunRecord, "tokens" | "usage"> = input.run;
    try {
      assertRunCanApply(input.run);
      if ((await this.getRun(input.run.id))?.status === "cancelled") return;
      if (!input.run.tenantId) throw new Error(noOrganizationRunCopy(input.agent));
      const baseLlm = await this.baseRunLlm(input.run, input.agent, input.providerId, input.model);
      const selection = await this.host.buildGraph(input.run.tenantId, input.agent.scopes, this.executionOptions(input.run, controller.signal));
      const llm = this.withOverlay(input.run, baseLlm, selection.tenantId, input.agent.slug);
      controller.signal.throwIfAborted();
      // Re-plan read-only against the live tenant immediately before apply,
      // for every agent write run. Replanning has no mutation authority, and
      // a plan that differs from the confirmed one needs a fresh decision.
      const kind = input.run.office ? "office" : "agent";
      const runContext = { runId: input.run.id, agentSlug: input.run.agentSlug, initiator: runInitiator(input.run) };
      const fresh = await executePlan({
        signal: controller.signal, run: { ...input.run, steps: [], logs: [] }, agent: input.agent,
        providerId: input.providerId, model: input.model, llm, tenant: selection.tenantSession,
        createGraph: (log) => readOnlyRevalidationGraph(selection.createGraph(log)),
        realWrites: false, connectorConfigs: await this.host.readConnectorConfigs(),
        connectorSecretsFor: (id) => this.host.connectorSecretsFor(id),
        connectorTransport: readOnlyRevalidationTransport(this.host.connectorTransport?.(input.run.tenantId, runContext)),
        confirmCapability: async () => ({ approved: false, reason: "Revalidating a plan cannot send notifications or change external state." }),
        onProgress: (next) => {
          usage = next;
        },
      });
      controller.signal.throwIfAborted();
      if (fresh.status === "failed" || !fresh.plan) {
        throw new Error(kind === "office"
          ? `Proposal could not be revalidated. ${fresh.error ?? "Run the assignment again."}`
          : `The plan could not be checked against the tenant before applying, so nothing was applied. ${fresh.error ?? "Select Run again to review a fresh plan."}`);
      }
      const change = planChangeSinceReview(input.plan, fresh.plan);
      if (change.changed) throw new Error(planChangedSinceReviewCopy(change, kind, { usesModel: (fresh.usage?.calls ?? 0) > 0 }));
      controller.signal.throwIfAborted();
      // Apply gets the reviewed plan, never the fresh one, and runs its
      // actions in the reviewed order; the fresh plan only decides
      // whether apply may start.
      try {
        await executeApply({
          signal: controller.signal,
          run: withUsageOf(input.run, usage),
          agent: input.agent,
          providerId: input.providerId,
          model: input.model,
          plan: input.plan,
          llm,
          createGraph: selection.createGraph,
          tenant: selection.tenantSession,
          connectorConfigs: await this.host.readConnectorConfigs(),
          connectorSecretsFor: (connectorId) => this.host.connectorSecretsFor(connectorId),
          ...(this.host.connectorTransport ? { connectorTransport: this.host.connectorTransport(input.run.tenantId, runContext) } : {}),
          confirmCapability: (info) => requestConnectorConfirmation(info, controller.signal),
          realWrites: true,
          onProgress: (next) =>
            this.queueRunSnapshot(this.stampTenant(next, selection.tenantId)),
        });
      } finally {
        // An apply that threw partway may still have committed earlier
        // actions; marking stale is safe either way, so always invalidate.
        this.invalidateGraphCacheAfterWrite(input.run.id, selection.tenantId, {
          scopes: input.agent.scopes,
          paths: input.plan.actions.flatMap((action) => action.request?.path ? [action.request.path] : []),
        });
      }
    } catch (error) {
      await this.persistFailedSnapshot(withUsageOf(input.run, usage), input.agent, error);
    } finally {
      if (this.controllers.get(input.run.id) === controller) this.controllers.delete(input.run.id);
    }
  }

  /**
   * Apply a confirmed system-run plan (baseline rollback or approved
   * gateway proposal). Actions run strictly in order and the apply is
   * fail-stop: the first Graph error marks the run failed with an
   * exact count of what was applied, and nothing after the failed
   * action is attempted. The stored plan is the only source of
   * requests; nothing is re-rendered at apply time.
   *
   * Unlike agent write runs, these plans are not re-planned before
   * apply. A gateway proposal comes from outside with no agent to plan
   * it again: the proposing client owns the plan, and the diff the admin
   * confirmed is applied as-is. A rollback plan is built from the local
   * drift snapshots, not a live read, so rebuilding it would compare the
   * snapshot with itself. Splashtop plans apply only through the
   * connection they were read through.
   */
  private async driveSystemApply(input: { run: RunRecord }): Promise<void> {
    if (input.run.origin === "splashtop-change") return this.driveSplashtopApply(input.run);
    const plan = input.run.plan;
    const isRollback = input.run.origin === "baseline-rollback";
    const noun = isRollback ? "Rollback" : "Proposal";
    const controller = new AbortController();
    this.controllers.set(input.run.id, controller);
    let applied = 0;
    let selectionTenantId: string | undefined;
    const attemptedPaths: string[] = [];
    let systemScopes: string[] = [];
    try {
      if ((await this.getRun(input.run.id))?.status === "cancelled") return;
      assertRunCanApply(input.run);
      if (!plan) throw new Error(`${noun} run has no plan.`);
      const scopes =
        input.run.rollback?.requiredScopes ??
        input.run.external?.requiredScopes ??
        [];
      systemScopes = scopes;
      if (!input.run.tenantId) {
        throw new Error(`${noun} run has no organization, so it cannot apply. Prepare it again in an organization.`);
      }
      const selection = await this.host.buildGraph(input.run.tenantId, scopes, this.executionOptions(input.run, controller.signal));
      selectionTenantId = selection.tenantId;
      const graph = selection.createGraph((level, message, metadata) => {
        void this.appendRunLog(input.run.id, level, message, metadata);
      });
      let run = this.stampTenant(input.run, selection.tenantId);
      for (const [index, action] of plan.actions.entries()) {
        controller.signal.throwIfAborted();
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
          controller.signal.throwIfAborted();
          attemptedPaths.push(action.request.path);
          await graph.request({
            signal: controller.signal,
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
        summary:
          applied > 0
            ? `${noun} stopped after applying ${applied} of ${plan?.actions.length ?? applied} actions: ${message}`
            : `${noun} failed before any action was applied: ${message}`,
        error: message,
      });
    } finally {
      // Invalidate for every attempted request, including a cancel at
      // the loop boundary and a request whose response was lost: the
      // write may have committed server-side either way, and a stale
      // answer after a confirmed change is the worse failure.
      if (attemptedPaths.length > 0 && selectionTenantId) {
        this.invalidateGraphCacheAfterWrite(input.run.id, selectionTenantId, {
          // Scopes carry the family signal paths cannot: deleting a
          // managed device also changes the overview totals.
          scopes: systemScopes,
          paths: attemptedPaths,
        });
      }
      if (this.controllers.get(input.run.id) === controller) this.controllers.delete(input.run.id);
    }
  }

  /**
   * Stops every Splashtop change of the organization that is applying and
   * waits until each has stopped, so a disconnect can delete the token
   * knowing no apply still holds it. A stopped run is marked failed with
   * the exact count it applied; the request in flight is aborted.
   */
  async stopSplashtopApplies(organizationId: string, reason: string): Promise<void> {
    const persisted = await this.host.read();
    const runIds = persisted.runs
      .filter((run) => run.origin === "splashtop-change" && run.splashtop?.organizationId === organizationId)
      .filter((run) => run.status === "running" || run.status === "queued" || this.drives.has(run.id))
      .map((run) => run.id);
    for (const runId of runIds) this.controllers.get(runId)?.abort(new Error(reason));
    await Promise.all(runIds.map((runId) => this.drives.get(runId) ?? Promise.resolve()));
  }

  /**
   * Apply a confirmed Splashtop change plan: in order, one request per
   * action, through the run's own organization's connection. Fail-stop:
   * the first error marks the run failed with an exact count, and nothing
   * after it is attempted. No Graph token is built for this run.
   */
  private async driveSplashtopApply(input: RunRecord): Promise<void> {
    const plan = input.plan;
    const controller = new AbortController();
    this.controllers.set(input.id, controller);
    let applied = 0;
    let run = input;
    try {
      if ((await this.getRun(input.id))?.status === "cancelled") return;
      assertRunCanApply(input);
      if (!plan) throw new Error("Splashtop change run has no plan.");
      if (!this.host.splashtopForRun) throw new Error("Splashtop is not available in this build.");
      const client = await this.host.splashtopForRun(input);
      for (const [index, action] of plan.actions.entries()) {
        controller.signal.throwIfAborted();
        const step = {
          id: `step_splashtop_${index}`,
          runId: run.id,
          label: action.label,
          status: "running" as const,
          ...(action.description ? { detail: action.description } : {}),
          startedAt: new Date().toISOString(),
        };
        run = { ...run, steps: [...run.steps, step] };
        await this.persistRunSnapshot(run);
        try {
          await client.apply(action, controller.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const finishedAt = new Date().toISOString();
          run = {
            ...run,
            steps: run.steps.map((existing) => existing.id === step.id ? { ...existing, status: "failed", finishedAt, detail: message } : existing),
            status: "failed",
            finishedAt,
            error: message,
            summary: `Splashtop changes stopped at "${action.label}" after applying ${applied} of ${plan.actions.length}. Nothing after it was attempted.`,
          };
          await this.persistRunSnapshot(run);
          return;
        }
        applied += 1;
        run = {
          ...run,
          steps: run.steps.map((existing) => existing.id === step.id ? { ...existing, status: "completed", finishedAt: new Date().toISOString() } : existing),
        };
        await this.persistRunSnapshot(run);
      }
      run = {
        ...run,
        status: "completed",
        finishedAt: new Date().toISOString(),
        summary: applied === 1 ? "1 Splashtop change applied." : `${applied} Splashtop changes applied.`,
        result: { appliedActions: applied },
      };
      await this.persistRunSnapshot(run);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.persistRunSnapshot({
        ...run,
        status: "failed",
        finishedAt: new Date().toISOString(),
        summary: applied > 0
          ? `Splashtop changes stopped after applying ${applied} of ${plan?.actions.length ?? applied}: ${message}`
          : `Splashtop changes failed before any was applied: ${message}`,
        error: message,
      });
    } finally {
      if (this.controllers.get(input.id) === controller) this.controllers.delete(input.id);
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
    let deliveryCandidate: RunRecord | undefined;
    await this.host.serialize(async () => {
      const persisted = await this.host.read();
      const previous = persisted.runs.find((existing) => existing.id === run.id);
      // A run deleted with its disconnected tenant never comes back from a
      // late snapshot, and its report is never delivered.
      if (!previous && run.tenantId && this.host.tenantWritable && !this.host.tenantWritable(run.tenantId)) return;
      if (previous?.status === "cancelled") {
        const steps = previous.steps.map((step) => {
          const incoming = run.steps.find((candidate) => candidate.id === step.id);
          if (step.status !== "cancelled" || !incoming ||
              !["completed", "failed"].includes(incoming.status)) return step;
          if (incoming.status === "failed" && /cancelled/i.test(incoming.detail ?? "")) return { ...step, detail: incoming.detail };
          return { ...incoming, thinking: incoming.thinking ? { ...incoming.thinking, streaming: false } : undefined };
        });
        const logs = [...previous.logs];
        for (const log of run.logs) if (!logs.some((existing) => existing.id === log.id)) logs.push(log);
        // Model calls made before the run stopped were billed, so a late
        // snapshot that counts more of them keeps its usage.
        const kept = (run.usage?.calls ?? 0) > (previous.usage?.calls ?? 0) ? withUsageOf(previous, run) : previous;
        await this.host.write({ ...persisted, runs: persisted.runs.map((existing) =>
          existing.id === run.id ? { ...kept, steps, logs } : existing) });
        return;
      }
      if (previous && isTerminalRunStatus(previous.status) && !isTerminalRunStatus(run.status)) return;

      if ((run.status === "awaiting-confirmation" || run.status === "planned") && run.plan) {
        run = {
          ...run,
          riskAssessment: previous?.riskAssessment && stableStringify(previous.plan) === stableStringify(run.plan)
            ? previous.riskAssessment
            : this.assessPlan(run, persisted),
        };
      } else if (previous?.riskAssessment) {
        run = { ...run, riskAssessment: previous.riskAssessment };
      }

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
      // Grants are recorded from the scopes tokens return during the run
      // (see the host's buildGraph), never from the agent's declaration.
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

  private assessPlan(run: RunRecord, state: RunPersistedState): RunRecord["riskAssessment"] {
    if (!run.plan) return undefined;
    const agent = state.installedAgents.find((candidate) => candidate.slug === run.agentSlug);
    // Installed agent summaries carry every declared Graph read and write.
    // An empty or missing list means there is no declaration set to compare.
    const graphOperations = run.origin === undefined && agent?.graphOperations?.length
      ? agent.graphOperations
      : undefined;
    return assessWritePlanSafely(run.plan, {
      ...(graphOperations ? { graphOperations } : {}),
      historicalConfirmedActionCounts: run.origin !== undefined || !run.tenantId ? [] : state.runs.flatMap((previous) =>
        previous.id !== run.id && previous.agentSlug === run.agentSlug &&
        previous.tenantId === run.tenantId && previous.confirmedAt && Array.isArray(previous.plan?.actions)
          ? [previous.plan.actions.length]
          : []),
    });
  }

  private withScheduleChangeState(run: RunRecord, runs: RunRecord[]): RunRecord {
    const previous = runs.find(
      (candidate) =>
        candidate.id !== run.id &&
        candidate.agentSlug === run.agentSlug &&
        candidate.tenantId === run.tenantId &&
        candidate.assessmentKey === run.assessmentKey &&
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

/**
 * The Graph client of a run with no organization. Such a run is admitted
 * only for an agent that calls no service API, so any call is a defect in
 * the agent, and it fails instead of reaching a tenant.
 */
function noServiceGraph(): RunGraphApi {
  const refuse = async (): Promise<never> => {
    throw new Error("This run has no organization, so it cannot call Microsoft Graph. Choose an organization with the service connected, then run the agent again.");
  };
  return {
    listManagedDevices: refuse,
    retireManagedDevice: refuse,
    request: refuse,
  };
}
