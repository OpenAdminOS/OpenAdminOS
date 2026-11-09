import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { ActivityFeed } from "../components/ActivityFeed";
import { MarkdownPreview, stripMarkdownToPlainText } from "../components/MarkdownPreview";
import { ResultPanel } from "../components/ResultPanel";
import { RunFailureRemediation } from "../components/RunFailureRemediation";
import { RunProgressBar, RunStepTimeline } from "../components/RunProgress";
import { RunSection } from "../components/RunSection";
import { useToast } from "../components/Toast";
import { TenantTile } from "../components/TenantTile";
import { WritePlanRiskSummary } from "../components/WritePlanRiskSummary";
import {
  IconArrowLeft,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconClock,
  IconCloud,
  IconCopy,
  IconDownload,
  IconHardDrive,
  IconPlay,
  IconShare,
  IconShield,
  IconWarning,
} from "../components/icons";
import {
  Badge,
  Button,
  IconButton,
  Menu,
  Section,
  StatusDot,
  type MenuEntry,
} from "../components/ui";
import { ORGANIZATION_COPY, RERUN_COPY, userFacingErrorReason } from "../copy";
import { Modal, ModalHeader } from "../components/Modal";
import { createPendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { copyTextToClipboard } from "../shared/clipboard";
import { formatAgentDisplayName } from "../shared/agent-display";
import {
  activeOrganizationOf,
  deriveTrustState,
  providerCatalog,
  resolveOrganizations,
  splashtopRegion,
  type RunRecord,
  type TenantRecord,
  type WriteAction,
  type WritePlan,
  type WritePlanRiskFlag,
} from "../shared/openAdminOS";
import {
  runReportJson,
  runReportMarkdown,
  runReportPlaintext,
} from "../shared/runReport";
import { useAppState } from "../state";
import type { RerunChoice } from "./AgentDetail";
import {
  agentNameForRun,
  formatDate,
  formatDuration,
  providerNameForRun,
  statusLabel,
  tenantNameForRun,
  triggerForRun,
} from "./Runs";

export default function RunResult() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const { state } = useAppState();
  const run = state.runs.find((candidate) => candidate.id === id);
  if (!run) {
    return <MissingRun onBack={() => navigate(`/runs${location.search}`)} />;
  }
  return <RunResultPage key={run.id} run={run} />;
}

function RunResultPage({ run }: { run: RunRecord }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { state, startRun, confirmRun, rejectRun, cancelRun, setActiveOrganization } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const toast = useToast();
  const [crossOrganization, setCrossOrganization] = useState(false);
  // The organization a Switch in the cross-organization dialog is moving
  // to; the rerun runs on the render where it is active, with fresh gates.
  const [rerunAfterSwitch, setRerunAfterSwitch] = useState<string | null>(null);
  const pendingRerunRef = useRef<string | null>(null);
  const proceedRerunRef = useRef<(() => void) | null>(null);
  const activeOrganizationId = activeOrganizationOf(state)?.id;

  const closeToRuns = () => navigate(`/runs${location.search}`);

  const agent = state.installedAgents.find(
    (candidate) => candidate.slug === run.agentSlug,
  );
  const runTenant = run.tenantId
    ? state.tenants.find((tenant) => tenant.id === run.tenantId)
    : undefined;
  // Fall back to the built-in catalog so a run whose provider entry was
  // later removed still reports where its data went.
  const runProvider = run.providerId
    ? state.providers.find((provider) => provider.id === run.providerId) ??
      providerCatalog.find((provider) => provider.id === run.providerId)
    : undefined;
  const derivedTrust = deriveTrustState({
    provider: runProvider,
    activeTenant: runTenant,
    model: run.model,
  });
  const runTrust = derivedTrust;
  const displayName = agent
    ? formatAgentDisplayName(agent)
    : agentNameForRun(run, state.installedAgents);
  const tenantName = tenantNameForRun(run, state.tenants);
  const isSystemRun = run.origin !== undefined;
  const requiresTeamReview = Boolean(
    run.officeContext && (agent?.mode === "write" || !runTrust.isLocal),
  );

  const openRerunPreflight = (slug: string, runChoice: RerunChoice) => {
    navigate(`/agents/${encodeURIComponent(slug)}/confirm`, { state: { runChoice } });
  };

  // A rerun of a run from an organization that is not active asks first:
  // switch to that organization, or run in the active one.
  const runOrganization = run.tenantId
    ? resolveOrganizations(state).find((organization) => organization.connections.microsoft365?.tenantId === run.tenantId)
    : undefined;
  const activeOrganization = activeOrganizationOf(state);

  const reRun = () => {
    // Agent Team reviews its own assignments with their tenant.
    if (!requiresTeamReview && run.tenantId && run.tenantId !== state.activeTenantId) {
      setCrossOrganization(true);
      return;
    }
    proceedRerun();
  };

  const proceedRerun = () => {
    proceedRerunImpl();
  };
  // The latest render's rerun, set before the effect below reads it.
  useEffect(() => {
    proceedRerunRef.current = proceedRerun;
  });
  useEffect(() => {
    pendingRerunRef.current = rerunAfterSwitch;
    if (!rerunAfterSwitch || activeOrganizationId !== rerunAfterSwitch) return;
    pendingRerunRef.current = null;
    setRerunAfterSwitch(null);
    proceedRerunRef.current?.();
  }, [activeOrganizationId, rerunAfterSwitch]);
  // Leaving the page before the switch lands does not drop the rerun silently.
  useEffect(
    () => () => {
      if (pendingRerunRef.current) toast.info(RERUN_COPY.rerunNotContinued);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const proceedRerunImpl = () => {
    if (requiresTeamReview) {
      navigate(
        run.office?.personaId
          ? `/office?persona=${encodeURIComponent(run.office.personaId)}`
          : "/office",
      );
      return;
    }
    // An ordinary rerun opens the agent's preflight with the same provider
    // and model, so it names the organization and services it will use,
    // whether or not the original run had an organization. Run for real
    // and Team retries keep their own flows.
    if (run.status !== "planned" && !run.officeContext) {
      openRerunPreflight(run.agentSlug, {
        ...(run.providerId ? { providerId: run.providerId } : {}),
        ...(run.model ? { model: run.model } : {}),
      });
      return;
    }
    if (
      !requireTenantAndProvider(
        createPendingIntent({
          kind: "agent-run",
          slug: run.agentSlug,
          ...(run.status === "planned" ? { runForRealOfRunId: run.id } : {}),
          ...(run.officeContext ? { retryOfRunId: run.id } : {}),
          ...(run.tenantId ? { tenantId: run.tenantId } : {}),
          ...(run.providerId ? { providerId: run.providerId } : {}),
          ...(run.model ? { model: run.model } : {}),
          returnTo: `/runs/${encodeURIComponent(run.id)}`,
        }),
      )
    ) {
      return;
    }
    const options: {
      runForRealOfRunId?: string;
      retryOfRunId?: string;
      tenantId?: string;
      providerId?: typeof run.providerId;
      model?: string;
    } = {};
    if (run.status === "planned") options.runForRealOfRunId = run.id;
    if (run.officeContext) options.retryOfRunId = run.id;
    if (run.tenantId) options.tenantId = run.tenantId;
    if (run.providerId) options.providerId = run.providerId;
    if (run.model) options.model = run.model;
    void startRun(run.agentSlug, options)
      .then((nextRun) => navigate(`/runs/${nextRun.id}`))
      .catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  };

  // Only an ordinary rerun can move to the active organization; Run for
  // real and Team retries stay with the run's own tenant.
  const ordinaryRerun = run.status !== "planned" && !run.officeContext;
  const crossOrganizationDialog = (
    <Modal open={crossOrganization} onClose={() => setCrossOrganization(false)} size="md">
      <ModalHeader
        title={RERUN_COPY.title(runOrganization?.name)}
        subtitle={displayName}
        onClose={() => setCrossOrganization(false)}
      />
      <div className="space-y-4 p-6">
        <p className="text-sm leading-relaxed text-[var(--color-text-soft)]">
          {RERUN_COPY.body(runOrganization?.name, activeOrganization?.name, ordinaryRerun)}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => setCrossOrganization(false)}>Cancel</Button>
          {ordinaryRerun && activeOrganization ? (
            <Button
              variant="secondary"
              onClick={() => {
                setCrossOrganization(false);
                openRerunPreflight(run.agentSlug, {
                  ...(run.providerId ? { providerId: run.providerId } : {}),
                  ...(run.model ? { model: run.model } : {}),
                });
              }}
            >
              {RERUN_COPY.runInActive(activeOrganization.name)}
            </Button>
          ) : null}
          {runOrganization ? (
            <Button
              variant="primary"
              onClick={() => {
                setCrossOrganization(false);
                // The rerun continues once the switch reaches the app state:
                // this closure still sees the organization before the switch.
                const target = runOrganization.id;
                setRerunAfterSwitch(target);
                void setActiveOrganization(target).catch((caught) => {
                  pendingRerunRef.current = null;
                  setRerunAfterSwitch(null);
                  toast.error(
                    ORGANIZATION_COPY.switchFailed(
                      userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? "",
                    ),
                  );
                });
              }}
            >
              {RERUN_COPY.switchTo(runOrganization.name)}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );

  if (run.status === "awaiting-confirmation" || run.status === "planned") {
    return (
      <>
      {crossOrganizationDialog}
      <ConfirmationPage
        run={run}
        displayName={displayName}
        tenant={runTenant}
        tenantName={tenantName}
        trustDetail={runTrust.detail}
        providerIsLocal={runProvider?.isLocal === true}
        onBack={closeToRuns}
        onConfirm={confirmRun}
        onReject={rejectRun}
        onRunForReal={reRun}
        inactiveOrganization={
          run.status === "awaiting-confirmation" && Boolean(run.tenantId) && run.tenantId !== state.activeTenantId
            ? { name: runOrganization?.name ?? tenantName, ...(runOrganization ? { id: runOrganization.id } : {}) }
            : undefined
        }
        onSwitchOrganization={(organizationId) =>
          void setActiveOrganization(organizationId).catch((caught) =>
            toast.error(
              ORGANIZATION_COPY.switchFailed(
                userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? "",
              ),
            ),
          )
        }
      />
      </>
    );
  }

  return (
    <>
    {crossOrganizationDialog}
    <RunPage
      key={run.id}
      run={run}
      displayName={displayName}
      tenantName={tenantName}
      providerName={providerNameForRun(run, state.providers)}
      providerIsLocal={runProvider?.isLocal}
      trustDetail={runTrust.detail}
      activeTenantId={state.activeTenantId}
      tenants={state.tenants}
      isSystemRun={isSystemRun}
      rerunLabel={requiresTeamReview ? "Review in Agent Team" : "Run again"}
      onBack={closeToRuns}
      onRerun={reRun}
      onCancel={() => cancelRun(run.id)}
      onRetargetCurrent={() => {
        if (!run.officeContext) {
          openRerunPreflight(run.agentSlug, {});
          return;
        }
        if (
          !requireTenantAndProvider(
            createPendingIntent({
              kind: "agent-run",
              slug: run.agentSlug,
              ...(state.activeTenantId
                ? { tenantId: state.activeTenantId }
                : {}),
              returnTo: `/runs/${encodeURIComponent(run.id)}`,
            }),
          )
        ) {
          return;
        }
        const options: { tenantId?: string } = {};
        if (state.activeTenantId) options.tenantId = state.activeTenantId;
        void startRun(run.agentSlug, options)
          .then((nextRun) => navigate(`/runs/${nextRun.id}`))
          .catch((error) =>
            toast.error(error instanceof Error ? error.message : String(error)),
          );
      }}
    />
    </>
  );
}

function MissingRun({ onBack }: { onBack: () => void }) {
  return (
    <>
      <PageHeader title="Run not found" breadcrumb={<BackToRuns onClick={onBack} />} />
      <PageBody>
        <div className="rounded-[10px] bg-[var(--color-surface)] px-6 py-8 text-base text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
          Run records are stored locally in this app profile. This record may
          have been removed or created in another profile.
        </div>
      </PageBody>
    </>
  );
}

function RunPage({
  run,
  displayName,
  tenantName,
  providerName,
  providerIsLocal,
  trustDetail,
  activeTenantId,
  tenants,
  isSystemRun,
  rerunLabel,
  onBack,
  onRerun,
  onCancel,
  onRetargetCurrent,
}: {
  run: RunRecord;
  displayName: string;
  tenantName: string;
  providerName: string;
  /** Undefined when the run recorded no provider. */
  providerIsLocal: boolean | undefined;
  trustDetail: string;
  activeTenantId?: string;
  tenants: TenantRecord[];
  isSystemRun: boolean;
  rerunLabel: string;
  onBack: () => void;
  onRerun: () => void;
  onCancel: () => Promise<RunRecord>;
  onRetargetCurrent: () => void;
}) {
  const live = run.status === "queued" || run.status === "running";
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const cancel = () => {
    if (cancelling) return;
    setCancelling(true);
    onCancel()
      .catch((error: unknown) => {
        const reason = userFacingErrorReason(
          error instanceof Error ? error.message : String(error),
        );
        toast.error(
          `The run could not be cancelled${reason ? `: ${reason}` : ""}. It may still be running. Check Runs before starting it again.`,
        );
      })
      .finally(() => setCancelling(false));
  };

  const failedLike = run.status === "failed" || run.status === "cancelled";
  // While a run is live, run.summary holds host status text such as
  // "X is running.", so only the streamed liveSummary counts as report.
  // Terminal non-completed summaries are host text too; the status card
  // shows them instead of presenting them as a report.
  const reportSource = live ? run.liveSummary : run.status === "completed" ? run.summary : undefined;
  const summaryStreaming = live && Boolean(run.liveSummary);
  const showReport = Boolean(reportSource) || live;
  const showSteps = run.steps.length > 0 && (live || failedLike);
  const showResult =
    run.result !== undefined || run.status === "completed" || run.status === "failed";

  // Sections fade in one after another. Sections that are already on
  // screen keep their place when the run updates, so nothing flickers.
  let sectionIndex = 0;
  const rise = (): CSSProperties => ({ animationDelay: `${60 * ++sectionIndex}ms` });

  return (
    <>
      <PageHeader
        title={displayName}
        breadcrumb={<BackToRuns onClick={onBack} />}
        subtitle={`${capitalize(triggerForRun(run))} run · ${formatDate(run.startedAt ?? run.queuedAt)}`}
        actions={
          <>
            {live ? (
              <>
                <Button variant="secondary" size="sm" onClick={onBack} title="The run continues in the background">
                  Run in background
                </Button>
                <Button variant="danger" size="sm" onClick={cancel} disabled={cancelling}>
                  Cancel run
                </Button>
              </>
            ) : !isSystemRun ? (
              <Button variant="primary" size="sm" leadingIcon={<IconPlay size={12} />} onClick={onRerun}>
                {rerunLabel}
              </Button>
            ) : null}
            <RunActionsMenu run={run} agentName={displayName} tenantName={tenantName} />
          </>
        }
      />
      <PageBody>
        <div className="calm-page-column space-y-5">
          <RunStatusCard
            run={run}
            tenantName={tenantName}
            providerName={providerName}
            providerIsLocal={providerIsLocal}
            trustDetail={trustDetail}
          />

          {!isSystemRun ? (
            <TenantDriftNote
              runTenantId={run.tenantId}
              activeTenantId={activeTenantId}
              tenants={tenants}
              allowRetarget={!run.officeContext}
              onRetargetCurrent={onRetargetCurrent}
            />
          ) : null}

          <RunFailureRemediation run={run} />
          {run.plan && run.plan.actions.length > 0 && run.riskAssessment ? (
            <WritePlanRiskSummary assessment={run.riskAssessment} />
          ) : null}

          {showSteps ? (
            <RunSection
              title={live ? "Progress" : "Where it stopped"}
              meta={`${settledStepCount(run)} of ${run.steps.length} steps finished`}
              className="run-rise"
              style={rise()}
            >
              <RunStepTimeline steps={run.steps} live={live} />
            </RunSection>
          ) : null}

          {showReport ? (
            <RunSection
              title="Report"
              meta={
                summaryStreaming ? (
                  <span className="inline-flex items-center gap-1.5 text-[var(--color-info)]">
                    <StatusDot tone="info" className="animate-pulse-soft" />
                    Writing
                  </span>
                ) : undefined
              }
              className="run-rise"
              style={rise()}
              bodyClassName="px-5 pb-6 sm:px-6"
            >
              <RunReport source={reportSource} streaming={summaryStreaming} queued={run.status === "queued"} />
            </RunSection>
          ) : null}

          {showResult ? (
            <div className="run-rise" style={rise()}>
              <ResultPanel run={run} />
            </div>
          ) : null}

          <RunDetails run={run} openOnFailure={run.status === "failed"} style={rise()} />
        </div>
      </PageBody>
    </>
  );
}

type StatusTone = "success" | "info" | "warning" | "danger" | "neutral";

const STATUS_TONE: Record<StatusTone, { text: string; tile: string; bar: string }> = {
  success: {
    text: "text-[var(--color-success)]",
    tile: "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    bar: "bg-[var(--color-success)]",
  },
  info: {
    text: "text-[var(--color-info)]",
    tile: "bg-[var(--color-info-soft)] text-[var(--color-info)]",
    bar: "bg-[var(--color-info)]",
  },
  warning: {
    text: "text-[var(--color-warning)]",
    tile: "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    bar: "bg-[var(--color-warning)]",
  },
  danger: {
    text: "text-[var(--color-danger)]",
    tile: "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
    bar: "bg-[var(--color-danger)]",
  },
  neutral: {
    text: "text-[var(--color-text)]",
    tile: "bg-[var(--color-hover)] text-[var(--color-text-muted)]",
    bar: "bg-[var(--color-border-strong)]",
  },
};

interface StatusView {
  tone: StatusTone;
  icon: ReactNode;
  headline: string;
  detail?: string;
  /** Shown next to the headline: a live clock, or when the run ended. */
  aside?: string;
}

function describeRunStatus(run: RunRecord, nowMs: number): StatusView {
  const formattedDuration = run.startedAt ? formatDuration(run, nowMs) : undefined;
  const elapsed = formattedDuration === "Not recorded" ? undefined : formattedDuration;
  const hostSummary = run.summary ? stripMarkdownToPlainText(run.summary) : undefined;
  const total = run.steps.length;
  const currentIndex = run.steps.findIndex((step) => step.status === "running");
  const current = currentIndex >= 0 ? run.steps[currentIndex] : undefined;
  const finished = run.finishedAt ? `Finished ${formatDate(run.finishedAt)}` : undefined;
  const tokens = totalTokens(run);
  const settledDetail = [
    total > 0 ? `${total} step${total === 1 ? "" : "s"}` : undefined,
    tokens > 0 ? `${tokens.toLocaleString()} tokens` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  switch (run.status) {
    case "queued":
      return {
        tone: "warning",
        icon: <IconClock size={18} />,
        headline: "Queued",
        detail: "Waiting to start. The run begins automatically.",
      };
    case "running":
      return {
        tone: "info",
        icon: (
          <span className="h-[18px] w-[18px] animate-spin rounded-full border-2 border-[var(--color-info)]/25 border-t-[var(--color-info)]" />
        ),
        headline: current && total > 0 ? `Running step ${currentIndex + 1} of ${total}` : "Running",
        detail: current?.label ?? "Starting the pipeline.",
        aside: elapsed,
      };
    case "completed":
      return {
        tone: "success",
        icon: <IconCheck size={18} />,
        headline: elapsed ? `Completed in ${elapsed}` : "Completed",
        detail: settledDetail || undefined,
        aside: finished,
      };
    case "failed": {
      const failedIndex = run.steps.findIndex((step) => step.status === "failed");
      const failedStep = failedIndex >= 0 ? run.steps[failedIndex] : undefined;
      return {
        tone: "danger",
        icon: <IconWarning size={18} />,
        headline: elapsed ? `Failed after ${elapsed}` : "Failed",
        detail: failedStep
          ? `Stopped at step ${failedIndex + 1} of ${total}: ${failedStep.label}`
          : run.error
            ? "The run stopped before it finished. The likely causes are listed below."
            : "The run stopped before it finished. Open Run details below for the logs.",
        aside: finished,
      };
    }
    case "cancelled":
      return {
        tone: "neutral",
        icon: <IconWarning size={18} />,
        headline: elapsed ? `Cancelled after ${elapsed}` : "Cancelled",
        detail: hostSummary ?? "The run was stopped before it finished.",
        aside: finished,
      };
    case "rejected":
      return {
        tone: "neutral",
        icon: <IconShield size={18} />,
        headline: "Rejected",
        detail: hostSummary ?? "The write plan was declined. No changes were applied to the tenant.",
        aside: run.rejectedAt ? `Rejected ${formatDate(run.rejectedAt)}` : finished,
      };
    default:
      // Confirmation and dry-run states render on the confirmation page.
      return {
        tone: "warning",
        icon: <IconBolt size={18} />,
        headline: statusLabel(run.status),
      };
  }
}

/** A clock that ticks only while `active`, so idle pages do not re-render. */
function useNow(active: boolean, intervalMs = 250): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [active, intervalMs]);
  return nowMs;
}

function settledStepCount(run: RunRecord): number {
  return run.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
}

function totalTokens(run: RunRecord): number {
  return (
    run.tokens?.totalTokens ??
    (run.tokens?.promptTokens ?? 0) + (run.tokens?.completionTokens ?? 0)
  );
}

function RunStatusCard({
  run,
  tenantName,
  providerName,
  providerIsLocal,
  trustDetail,
}: {
  run: RunRecord;
  tenantName: string;
  providerName: string;
  providerIsLocal: boolean | undefined;
  trustDetail: string;
}) {
  const live = run.status === "queued" || run.status === "running";
  const nowMs = useNow(live);
  const status = describeRunStatus(run, nowMs);
  const tone = STATUS_TONE[status.tone];
  const tokens = totalTokens(run);

  return (
    <section
      aria-label="Run status"
      className="relative overflow-hidden rounded-[14px] bg-[var(--color-surface)] shadow-[inset_0_0_0_1px_var(--color-border-soft)]"
    >
      <span
        aria-hidden="true"
        className={`absolute inset-x-0 top-0 h-[2px] opacity-70 transition-colors duration-500 ${tone.bar}`}
      />
      <div className="p-5 sm:p-6">
        <div className="flex items-start gap-4">
          <div
            aria-hidden="true"
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] transition-colors duration-500 ${tone.tile} ${
              run.status === "running" ? "run-live-ring" : ""
            }`}
          >
            {status.icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
              <div role="status" aria-live="polite" className={`text-md font-semibold ${tone.text}`}>
                {status.headline}
              </div>
              {status.aside ? (
                <div
                  className={`font-mono text-xs tabular-nums ${
                    live ? "text-[var(--color-info)]" : "text-[var(--color-text-muted)]"
                  }`}
                >
                  {status.aside}
                </div>
              ) : null}
            </div>
            {status.detail ? (
              <div className="mt-0.5 line-clamp-2 text-sm text-[var(--color-text-soft)]">{status.detail}</div>
            ) : null}
          </div>
        </div>

        <div className="mt-4">
          <RunProgressBar run={run} />
        </div>

        {run.external?.requiredScopes.length ? (
          <p className="mt-3 text-sm text-[var(--color-text-muted)]">
            Required scopes: {run.external.requiredScopes.join(", ")}
          </p>
        ) : null}
        {run.rollback && run.rollback.manualCount > 0 ? (
          <p className="mt-3 text-sm text-[var(--color-text-muted)]">
            {run.rollback.manualCount.toLocaleString()} changes need manual review and are not part of this plan.
          </p>
        ) : null}

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[var(--color-border-soft)] pt-4 sm:grid-cols-3 lg:grid-cols-5">
          <RunFact label="Tenant" value={tenantName} />
          <RunFact
            label="Provider"
            value={providerName}
            icon={
              providerIsLocal === undefined ? undefined : providerIsLocal ? <IconHardDrive size={12} /> : <IconCloud size={12} />
            }
            tone={providerIsLocal === undefined ? undefined : providerIsLocal ? "success" : "warning"}
          />
          <RunFact label="Model" value={run.model ?? "Not recorded"} mono={Boolean(run.model)} />
          <RunFact
            label="Tokens"
            value={tokens > 0 ? tokens.toLocaleString() : live ? "Counting" : "Not recorded"}
            mono={tokens > 0}
          />
          <RunFact
            label="Cost"
            value={
              providerIsLocal === undefined
                ? "Not recorded"
                : providerIsLocal
                  ? "Local, not billed"
                  : "Hosted, not recorded"
            }
          />
        </dl>

        <div className="mt-4">
          <TrustLine local={providerIsLocal === true} detail={trustDetail} />
        </div>
      </div>
    </section>
  );
}

function RunFact({
  label,
  value,
  icon,
  tone,
  mono = false,
}: {
  label: string;
  value: string;
  icon?: ReactNode;
  tone?: "success" | "warning";
  mono?: boolean;
}) {
  const iconTone =
    tone === "success"
      ? "text-[var(--color-success)]"
      : tone === "warning"
        ? "text-[var(--color-warning)]"
        : "text-[var(--color-text-muted)]";
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--color-text-muted)]">{label}</dt>
      <dd className="mt-0.5 flex min-w-0 items-center gap-1.5">
        {icon ? (
          <span aria-hidden="true" className={`inline-flex shrink-0 ${iconTone}`}>
            {icon}
          </span>
        ) : null}
        <span
          title={value}
          className={`truncate text-sm font-medium text-[var(--color-text)] ${mono ? "font-mono" : ""}`}
        >
          {value}
        </span>
      </dd>
    </div>
  );
}

function RunReport({
  source,
  streaming,
  queued,
}: {
  source: string | undefined;
  streaming: boolean;
  queued: boolean;
}) {
  if (!source) {
    return (
      <div>
        <div aria-hidden="true" className="flex max-w-[68ch] flex-col gap-2.5">
          <div className="run-skeleton h-3.5 w-[40%]" />
          <div className="run-skeleton h-3 w-[94%]" />
          <div className="run-skeleton h-3 w-[88%]" />
          <div className="run-skeleton h-3 w-[62%]" />
        </div>
        <p className="mt-4 text-sm text-[var(--color-text-muted)]">
          {queued
            ? "The report appears here once the run starts."
            : "The report appears here as the agent writes it."}
        </p>
      </div>
    );
  }
  return (
    <div aria-live={streaming ? "polite" : undefined} aria-busy={streaming || undefined}>
      <MarkdownPreview
        source={source}
        className="chat-answer run-report max-w-[68ch] text-[var(--color-text)]"
      />
      {streaming ? (
        <div aria-hidden="true" className="mt-4 flex max-w-[68ch] flex-col gap-2.5">
          <div className="run-skeleton h-3 w-[86%]" />
          <div className="run-skeleton h-3 w-[58%]" />
        </div>
      ) : null}
    </div>
  );
}

function RunDetails({
  run,
  openOnFailure,
  style,
}: {
  run: RunRecord;
  openOnFailure: boolean;
  style?: CSSProperties;
}) {
  // Opens by default for failed runs, including a run that fails while
  // the page is open. RunPage is keyed by run id, so this resets per run.
  const [open, setOpen] = useState(openOnFailure);
  useEffect(() => {
    if (openOnFailure) setOpen(true);
  }, [openOnFailure]);
  const panelId = useId();
  const reasoningCount = run.steps.filter(
    (step) => step.thinking && step.thinking.text.length > 0,
  ).length;
  return (
    <div
      style={style}
      className="run-rise overflow-hidden rounded-[14px] bg-[var(--color-surface)] shadow-[inset_0_0_0_1px_var(--color-border-soft)]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 px-5 py-3.5 text-left transition-colors hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus)]"
      >
        <span className="flex min-w-0 items-baseline gap-2.5">
          <span className="text-md font-semibold text-[var(--color-text)]">Run details</span>
          <span className="truncate text-sm text-[var(--color-text-muted)]">
            {run.steps.length} step{run.steps.length === 1 ? "" : "s"} · {run.logs.length} log
            {run.logs.length === 1 ? "" : "s"}
            {reasoningCount > 0 ? ` · reasoning for ${reasoningCount}` : ""}
          </span>
        </span>
        <IconChevronDown
          size={13}
          aria-hidden="true"
          className={`shrink-0 text-[var(--color-text-muted)] transition-transform motion-reduce:transition-none ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open ? (
        <div id={panelId} className="border-t border-[var(--color-border-soft)] px-5 pb-5 pt-3">
          {/* "Where it stopped" already shows the pipeline for failed runs. */}
          <ActivityFeed run={run} initialTab={openOnFailure ? "logs" : "pipeline"} />
        </div>
      ) : null}
    </div>
  );
}

function ConfirmationPage({
  run,
  displayName,
  tenant,
  tenantName,
  trustDetail,
  providerIsLocal,
  onBack,
  onConfirm,
  onReject,
  onRunForReal,
  inactiveOrganization,
  onSwitchOrganization,
}: {
  run: RunRecord;
  displayName: string;
  tenant?: TenantRecord;
  tenantName: string;
  trustDetail: string;
  providerIsLocal: boolean;
  /** The plan's organization when it is not the active one. Applying waits for it. */
  inactiveOrganization?: { name: string; id?: string } | undefined;
  onSwitchOrganization?: (organizationId: string) => void;
  onBack: () => void;
  onConfirm: (runId: string, phrase: string) => Promise<RunRecord>;
  onReject: (runId: string) => Promise<RunRecord>;
  onRunForReal: () => void;
}) {
  const dryRun = run.dryRun === true || run.status === "planned";
  const plan = run.plan;
  const destructiveCount =
    plan?.actions.filter((action) => action.severity === "destructive").length ?? 0;
  const actionCount = plan
    ? `${plan.actions.length} ${plan.actions.length === 1 ? "action" : "actions"}`
    : null;
  return (
    <>
      <PageHeader
        title={displayName}
        breadcrumb={<BackToRuns onClick={onBack} />}
        actions={
          <>
            <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-text-muted)]"><StatusDot tone={dryRun ? "info" : "warning"} />{dryRun ? "Dry run: not applied" : "Awaiting confirmation"}</span>
            <RunActionsMenu run={run} agentName={displayName} tenantName={tenantName} />
          </>
        }
      />
      <PageBody>
        <div className="calm-page-column space-y-6">
          <div className="flex items-center gap-3 rounded-[14px] bg-[var(--color-surface)] px-4 py-3 shadow-[inset_0_0_0_1px_var(--color-border-soft)]">
            {tenant ? <TenantTile tenantId={tenant.id} displayName={tenant.displayName} size="row" /> : <span className="calm-row-icon"><IconWarning size={15} /></span>}
            <div className="min-w-0 flex-1">
              <div className="font-medium text-[var(--color-text)]">{tenantName}</div>
              <div className="mt-0.5 truncate text-sm text-[var(--color-text-muted)]">Proposed by {run.external?.clientName ?? displayName}</div>
              <div className="mt-1 text-sm text-[var(--color-text-soft)]">
                {dryRun ? "Planning is complete. This run cannot apply changes." : "Write operation paused for confirmation. OpenAdminOS will not proceed until the exact phrase is typed."}
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm text-[var(--color-warning)]"><StatusDot tone={dryRun ? "info" : "warning"} />{dryRun ? "Not applied" : "Review required"}</span>
          </div>

          <p className="text-sm text-[var(--color-text-muted)]">
            {dryRun ? `Proposed changes for ${tenantName}` : run.tenantId
              ? `Applies to ${tenantName} through ${run.origin === "splashtop-change" ? `the Splashtop Open API (${splashtopRegion(run.splashtop?.region ?? "global").host})` : "Microsoft Graph"}`
              : `Simulates changes for ${tenantName} without Microsoft Graph writes`}
            {actionCount ? ` · ${actionCount} · ${destructiveCount} destructive` : ""}
          </p>

          {dryRun ? (
            <div role="status" className="rounded-[14px] bg-[var(--color-info-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-info)]">
              Dry run. Nothing was changed in {tenantName}.
            </div>
          ) : plan && run.tenantId ? (
            <div className="rounded-[14px] bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
              {run.origin === "splashtop-change" ? (
                <>
                  <div className="mb-1 flex items-center gap-2 font-medium"><IconWarning size={14} />Splashtop write</div>
                  Approving will call the Splashtop Open API at {splashtopRegion(run.splashtop?.region ?? "global").host} with the token of {tenantName}. {plan.actions.length} planned {plan.actions.length === 1 ? "change" : "changes"} will be applied in order, and the first error stops the rest. Reboots, deletions, disabled users and ended sessions cannot be undone from OpenAdminOS.
                </>
              ) : (
                <>
                  <div className="mb-1 flex items-center gap-2 font-medium"><IconWarning size={14} />Microsoft Graph write</div>
                  Approving will call Microsoft Graph. {plan.actions.length} planned {plan.actions.length === 1 ? "change" : "changes"} will be applied to {tenantName}. Review every operation below. Microsoft Graph changes may not be reversible.
                </>
              )}
            </div>
          ) : plan && run.status === "awaiting-confirmation" ? (
            // The host refuses a plan with no organization; it is never applied elsewhere.
            <div role="alert" className="rounded-[14px] bg-[var(--color-warning-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text)] ring-1 ring-[var(--color-warning)]/25">
              <div className="font-medium">{RERUN_COPY.planNoOrganizationTitle}</div>
              <p className="mt-1 text-[var(--color-text-soft)]">{RERUN_COPY.planNoOrganizationBody}</p>
            </div>
          ) : null}

          {inactiveOrganization && !dryRun && plan ? (
            <div role="alert" className="rounded-[14px] bg-[var(--color-warning-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-text)] ring-1 ring-[var(--color-warning)]/25">
              <div className="font-medium">{RERUN_COPY.planElsewhereTitle(inactiveOrganization.name)}</div>
              <p className="mt-1 text-[var(--color-text-soft)]">{RERUN_COPY.planElsewhereBody(inactiveOrganization.name)}</p>
              {inactiveOrganization.id && onSwitchOrganization ? (
                <div className="mt-3">
                  <Button variant="primary" onClick={() => onSwitchOrganization(inactiveOrganization.id!)}>
                    {RERUN_COPY.switchTo(inactiveOrganization.name)}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          {run.external?.requiredScopes.length ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Required scopes: {run.external.requiredScopes.join(", ")}
            </p>
          ) : null}

          {plan ? (
            <>
              <WritePlanRiskSummary assessment={run.riskAssessment} />
              <Section title={plan.summary}>
                <div className="divide-y divide-[var(--color-border-soft)] overflow-hidden rounded-[14px] bg-[var(--color-surface)] shadow-[inset_0_0_0_1px_var(--color-border-soft)]">
                  {plan.actions.map((action, index) => (
                    <ActionRow key={action.id} action={action} index={index}
                      flags={run.riskAssessment?.status === "complete" ? run.riskAssessment.flags.filter((flag) => flag.actionIds.includes(action.id)) : []} />
                  ))}
                </div>
              </Section>
              {dryRun ? (
                <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
                  <p className="text-sm text-[var(--color-text-muted)]">Run for real reads the tenant again and prepares a fresh plan using the same settings. Review and confirmation are required before any change.</p>
                  <Button variant="primary" onClick={onRunForReal}>Run for real</Button>
                </div>
              ) : <TypedConfirmation
                key={JSON.stringify([run.id, plan, run.riskAssessment])}
                runId={run.id}
                plan={plan}
                requiresRiskAcknowledgement={run.riskAssessment?.status === "complete" && run.riskAssessment.flags.some((flag) => flag.severity === "danger")}
                blocked={Boolean(inactiveOrganization) || !run.tenantId}
                onConfirm={onConfirm}
                onReject={onReject}
              />}
            </>
          ) : (
            <div
              role="alert"
              className="rounded-[10px] bg-[var(--color-danger-soft)] px-4 py-3 text-base text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30"
            >
              The confirmation plan is unavailable. Cancel this run and prepare a new proposal.
            </div>
          )}

          <TrustLine local={providerIsLocal} detail={trustDetail} />
        </div>
      </PageBody>
    </>
  );
}

function TypedConfirmation({
  runId,
  plan,
  requiresRiskAcknowledgement,
  blocked = false,
  onConfirm,
  onReject,
}: {
  runId: string;
  plan: WritePlan;
  /** Apply stays disabled while the plan's organization is not active. */
  blocked?: boolean;
  requiresRiskAcknowledgement: boolean;
  onConfirm: (runId: string, phrase: string) => Promise<RunRecord>;
  onReject: (runId: string) => Promise<RunRecord>;
}) {
  const [typed, setTyped] = useState("");
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = !blocked && typed === plan.confirmationPhrase && (!requiresRiskAcknowledgement || riskAcknowledged);

  const confirm = async () => {
    if (!armed || busy) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm(runId, typed);
      setTyped("");
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setError(null);
    setBusy(true);
    try {
      await onReject(runId);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : String(caughtError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="typed-confirmation-title"
      className="border-t border-[var(--color-border)] pt-5"
    >
      <h2 id="typed-confirmation-title" className="text-md font-semibold text-[var(--color-text)]">
        Type the phrase below to confirm
      </h2>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">
        Every destructive operation requires a typed phrase. There is no "remember my choice."
      </p>
      {requiresRiskAcknowledgement ? (
        <label className="mt-4 flex items-center gap-2 text-sm text-[var(--color-text)]">
          <input type="checkbox" name="risk-acknowledgement" autoComplete="off" checked={riskAcknowledged} disabled={busy}
            onChange={(event) => setRiskAcknowledged(event.target.checked)}
            className="h-4 w-4 accent-[var(--color-danger)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-focus)]" />
          I have reviewed the flagged actions
        </label>
      ) : null}
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,0.8fr)_minmax(260px,1fr)_auto]">
        <div className="flex min-h-11 items-center rounded-lg bg-[var(--color-danger-soft)] px-4 font-mono text-base text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25">
          {plan.confirmationPhrase}
        </div>
        <label htmlFor="run-confirmation-phrase" className="sr-only">
          Type confirmation phrase
        </label>
        <input
          id="run-confirmation-phrase"
          name="run-confirmation-phrase"
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="Type here to enable Apply"
          autoComplete="off"
          disabled={busy}
          className={`h-11 rounded-lg bg-[var(--color-bg-raised)] px-4 font-mono text-base text-[var(--color-text)] ring-1 placeholder:text-[var(--color-text-placeholder)] focus:outline-none focus:ring-2 ${
            armed
              ? "ring-[var(--color-danger)] focus:ring-[var(--color-danger)]"
              : "ring-[var(--color-border)] focus:ring-[var(--color-focus)]"
          }`}
        />
        <div className="flex gap-2">
          <Button variant="secondary" size="md" onClick={() => void reject()} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="md"
            disabled={!armed || busy}
            onClick={() => void confirm()}
            leadingIcon={<IconBolt size={12} />}
          >
            Apply {plan.actions.length} change{plan.actions.length === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
      {error ? (
        <div role="alert" className="mt-3 text-sm text-[var(--color-danger)]">
          {userFacingErrorReason(error) ??
            "The confirmation action could not be completed. Review the tenant connection, then try again."}
        </div>
      ) : null}
    </section>
  );
}

function ActionRow({ action, index, flags = [] }: { action: WriteAction; index: number; flags?: WritePlanRiskFlag[] }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewId = useId();
  const destructive = action.severity === "destructive";
  const badgeLabel = action.request?.method ?? action.kind;
  return (
    <div className="px-4 py-3">
      <div className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-3">
        <div className="text-xs tabular-nums text-[var(--color-text-muted)]">
          {String(index + 1).padStart(2, "0")}
        </div>
        <div className="min-w-0">
          <div className="truncate text-base font-medium text-[var(--color-text)]">
            {action.label}
          </div>
          {action.description ? (
            <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
              {action.description}
            </div>
          ) : null}
          {flags.length > 0 ? (
            <ul aria-label={`Risk flags for ${action.label}`} className="mt-1 flex flex-wrap gap-2">
              {flags.map((flag) => (
                <li key={flag.id}><Badge tone={flag.severity === "danger" ? "danger" : "warning"}>{flag.severity === "danger" ? "Danger" : "Warning"}: {flag.title}</Badge></li>
              ))}
            </ul>
          ) : null}
          <div className={`mt-1 whitespace-pre-wrap break-words font-mono text-xs ${destructive ? "text-[var(--color-danger)]" : "text-[var(--color-text-soft)]"}`}>
            {actionRequestSummary(action)}
          </div>
        </div>
        <Badge tone={destructive ? "danger" : "neutral"}>{badgeLabel}</Badge>
      </div>
      {action.request ? (
        <div className="mt-2 pl-10">
          <button
            type="button"
            onClick={() => setPreviewOpen((open) => !open)}
            aria-expanded={previewOpen}
            aria-controls={previewId}
            className="inline-flex items-center gap-1.5 rounded text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
          >
            <IconChevronDown
              size={11}
              aria-hidden="true"
              className={`transition-transform motion-reduce:transition-none ${previewOpen ? "" : "-rotate-90"}`}
            />
            {previewOpen ? "Hide request preview" : "Show request preview"}
          </button>
          {previewOpen ? (
            <pre
              id={previewId}
              className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg-raised)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
            >
              {formatRequestPreview(action.request)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TenantDriftNote({
  runTenantId,
  activeTenantId,
  tenants,
  allowRetarget,
  onRetargetCurrent,
}: {
  runTenantId: string | undefined;
  activeTenantId: string | undefined;
  tenants: TenantRecord[];
  allowRetarget: boolean;
  onRetargetCurrent: () => void;
}) {
  if (!runTenantId || runTenantId === activeTenantId) return null;
  const runTenant = tenants.find((tenant) => tenant.id === runTenantId);
  const activeTenant = activeTenantId
    ? tenants.find((tenant) => tenant.id === activeTenantId)
    : undefined;
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-l-2 border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-4 py-3">
      <div className="flex min-w-0 flex-1 items-start gap-2 text-sm leading-relaxed text-[var(--color-text-soft)]">
        <IconWarning size={14} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
        <span>
          This run used {runTenant?.displayName ?? runTenantId}. The active tenant is now {activeTenant?.displayName ?? "not connected"}, so this result still reflects the original tenant.
        </span>
      </div>
      {allowRetarget ? (
        <Button variant="secondary" size="sm" onClick={onRetargetCurrent}>
          Re-run against current tenant
        </Button>
      ) : null}
    </div>
  );
}

function RunActionsMenu({
  run,
  agentName,
  tenantName,
}: {
  run: RunRecord;
  agentName: string;
  tenantName: string;
}) {
  const toast = useToast();
  const items: MenuEntry[] = [
    {
      id: "copy-report",
      label: "Copy report",
      icon: <IconCopy size={13} />,
      onSelect: () => {
        void copyTextToClipboard(runReportPlaintext(run, { agentName, tenantName }))
          .then(() => toast.success("Run report copied."))
          .catch((error) =>
            toast.error(error instanceof Error ? error.message : String(error)),
          );
      },
    },
    {
      id: "export",
      label: "Export",
      icon: <IconDownload size={13} />,
      onSelect: () => {
        void window.openAdminOS?.saveTextFile({
          suggestedName: `${run.agentSlug}-${run.id}.json`,
          content: runReportJson(run),
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
      },
    },
    {
      id: "share",
      label: "Share",
      icon: <IconShare size={13} />,
      onSelect: () => {
        void window.openAdminOS?.saveTextFile({
          suggestedName: `${run.agentSlug}-${run.id}.md`,
          content: runReportMarkdown(run, { agentName, tenantName }),
          filters: [{ name: "Markdown", extensions: ["md"] }],
        });
      },
    },
    { id: "separator-id", type: "separator" },
    {
      id: "copy-id",
      label: "Copy run ID",
      icon: <IconCopy size={13} />,
      onSelect: () => {
        void copyTextToClipboard(run.id)
          .then(() => toast.success("Run ID copied."))
          .catch((error) =>
            toast.error(error instanceof Error ? error.message : String(error)),
          );
      },
    },
  ];
  return (
    <Menu
      ariaLabel="Run actions"
      items={items}
      trigger={
        <IconButton
          label="Run actions"
          tooltip="Copy, export, or share"
          size="sm"
          icon={<span className="text-md leading-none">•••</span>}
        />
      }
    />
  );
}

function BackToRuns({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
    >
      <IconArrowLeft size={12} aria-hidden="true" /> Runs
    </button>
  );
}

function TrustLine({ local, detail }: { local: boolean; detail: string }) {
  return (
    <div className="flex items-start gap-2 text-xs leading-relaxed text-[var(--color-text-muted)]">
      <StatusDot tone={local ? "success" : "warning"} />
      <span>{detail}</span>
    </div>
  );
}

function formatRequestPreview(request: NonNullable<WriteAction["request"]>): string {
  const head = `${request.method} ${request.path}`;
  if (request.body === undefined) return head;
  let body: string;
  try {
    body = JSON.stringify(request.body, null, 2);
  } catch {
    body = String(request.body);
  }
  return `${head}\n\n${body}`;
}

function actionRequestSummary(action: WriteAction): string {
  const request = action.request;
  if (!request) return `${action.kind}: ${action.label}`;
  const requestTarget = `${request.method} ${request.path}`;
  if (request.body === undefined) return requestTarget;
  if (
    request.body !== null &&
    typeof request.body === "object" &&
    !Array.isArray(request.body)
  ) {
    const fields = Object.entries(request.body as Record<string, unknown>);
    if (fields.length === 0) return `${requestTarget} · body: {}`;
    return `${requestTarget} · ${fields
      .map(([field, value]) => `${field}: ${requestSummaryValue(value)}`)
      .join(" · ")}`;
  }
  return `${requestTarget} · body: ${requestSummaryValue(request.body)}`;
}

function requestSummaryValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
