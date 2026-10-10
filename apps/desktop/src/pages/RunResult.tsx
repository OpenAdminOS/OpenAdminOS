import { useEffect, useId, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { ActivityFeed } from "../components/ActivityFeed";
import { MarkdownPreview, stripMarkdownToPlainText } from "../components/MarkdownPreview";
import { Modal } from "../components/Modal";
import { ResultPanel } from "../components/ResultPanel";
import { RunFailureRemediation } from "../components/RunFailureRemediation";
import { CompactRunTelemetry, RunTelemetry } from "../components/RunTelemetry";
import { useToast } from "../components/Toast";
import {
  IconArrowLeft,
  IconBolt,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconPlay,
  IconShare,
  IconWarning,
} from "../components/icons";
import {
  Badge,
  Button,
  Drawer,
  IconButton,
  Menu,
  Section,
  StatusDot,
  type MenuEntry,
} from "../components/ui";
import { userFacingErrorReason } from "../copy";
import { createPendingIntent } from "../setup/pending-intent";
import { useSetupFlow } from "../setup/SetupFlowContext";
import { copyTextToClipboard } from "../shared/clipboard";
import { formatAgentDisplayName } from "../shared/agent-display";
import {
  deriveTrustState,
  type RunRecord,
  type TenantRecord,
  type WriteAction,
  type WritePlan,
} from "../shared/openAdminOS";
import {
  runReportJson,
  runReportMarkdown,
  runReportPlaintext,
} from "../shared/runReport";
import { useAppState } from "../state";
import Runs, {
  agentNameForRun,
  formatDate,
  providerNameForRun,
  statusLabel,
  statusTone,
  tenantNameForRun,
  triggerForRun,
} from "./Runs";

export default function RunResult() {
  const navigate = useNavigate();
  const location = useLocation();
  const { id } = useParams();
  const { state, startRun, confirmRun, rejectRun, cancelRun } = useAppState();
  const { requireTenantAndProvider } = useSetupFlow();
  const toast = useToast();
  const run = state.runs.find((candidate) => candidate.id === id);

  const closeToRuns = () => navigate(`/runs${location.search}`);

  if (!run) {
    return <MissingRun onBack={closeToRuns} />;
  }

  const agent = state.installedAgents.find(
    (candidate) => candidate.slug === run.agentSlug,
  );
  const runTenant = run.tenantId
    ? state.tenants.find((tenant) => tenant.id === run.tenantId)
    : undefined;
  const runProvider = run.providerId
    ? state.providers.find((provider) => provider.id === run.providerId)
    : undefined;
  const runTrust = deriveTrustState({
    provider: runProvider,
    activeTenant: runTenant,
    model: run.model,
  });
  const displayName = agent
    ? formatAgentDisplayName(agent)
    : agentNameForRun(run, state.installedAgents);
  const tenantName = tenantNameForRun(run, state.tenants);
  const isLive = run.status === "queued" || run.status === "running";
  const isSystemRun = run.origin !== undefined;
  const requiresTeamReview = Boolean(
    run.officeContext && (agent?.mode === "write" || !runTrust.isLocal),
  );

  const reRun = () => {
    if (requiresTeamReview) {
      navigate(
        run.office?.personaId
          ? `/office?persona=${encodeURIComponent(run.office.personaId)}`
          : "/office",
      );
      return;
    }
    if (
      !requireTenantAndProvider(
        createPendingIntent({
          kind: "agent-run",
          slug: run.agentSlug,
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
      retryOfRunId?: string;
      tenantId?: string;
      providerId?: typeof run.providerId;
      model?: string;
    } = {};
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

  if (run.status === "awaiting-confirmation") {
    return (
      <ConfirmationPage
        run={run}
        displayName={displayName}
        tenantName={tenantName}
        trustDetail={runTrust.detail}
        providerIsLocal={runProvider?.isLocal === true}
        onBack={closeToRuns}
        onConfirm={confirmRun}
        onReject={rejectRun}
      />
    );
  }

  if (isLive) {
    return (
      <>
        <Runs />
        <LiveRunModal
          run={run}
          displayName={displayName}
          tenantName={tenantName}
          providerName={providerNameForRun(run, state.providers)}
          providerIsLocal={runProvider?.isLocal}
          trustDetail={runTrust.detail}
          onBackground={closeToRuns}
          onCancel={() => cancelRun(run.id)}
        />
      </>
    );
  }

  return (
    <>
      <Runs />
      <RunDrawer
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
        onClose={closeToRuns}
        onRerun={reRun}
        onRetargetCurrent={() => {
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

function RunDrawer({
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
  onClose,
  onRerun,
  onRetargetCurrent,
}: {
  run: RunRecord;
  displayName: string;
  tenantName: string;
  providerName: string;
  providerIsLocal?: boolean;
  trustDetail: string;
  activeTenantId?: string;
  tenants: TenantRecord[];
  isSystemRun: boolean;
  rerunLabel: string;
  onClose: () => void;
  onRerun: () => void;
  onRetargetCurrent: () => void;
}) {
  const shouldShowResult =
    run.result !== undefined || run.status === "completed" || run.status === "failed";
  return (
    <Drawer
      open
      title={displayName}
      onClose={onClose}
      actions={
        <>
          {!isSystemRun ? (
            <Button
              variant="primary"
              size="sm"
              leadingIcon={<IconPlay size={12} />}
              onClick={onRerun}
            >
              {rerunLabel}
            </Button>
          ) : null}
          <RunActionsMenu run={run} agentName={displayName} tenantName={tenantName} />
        </>
      }
    >
      <div className="space-y-6 p-5">
        <section aria-label="Run summary" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge>
            <span className="text-sm text-[var(--color-text-muted)]">
              {tenantName} · {capitalize(triggerForRun(run))} · {formatDate(run.startedAt ?? run.queuedAt)}
            </span>
          </div>
          <p className="text-md font-medium leading-relaxed text-[var(--color-text)]">
            {run.liveSummary ?? run.summary
              ? stripMarkdownToPlainText(run.liveSummary ?? run.summary ?? "")
              : "No summary was recorded for this run."}
          </p>
          {run.external?.requiredScopes.length ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Required scopes: {run.external.requiredScopes.join(", ")}
            </p>
          ) : null}
          {run.rollback && run.rollback.manualCount > 0 ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              {run.rollback.manualCount.toLocaleString()} changes need manual review and are not part of this plan.
            </p>
          ) : null}
        </section>

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
        {shouldShowResult ? <ResultPanel run={run} /> : null}
        <CompactRunTelemetry
          run={run}
          providerIsLocal={providerIsLocal}
          providerName={providerName}
        />
        <ActivityFeed run={run} />
        <TrustLine local={providerIsLocal === true} detail={trustDetail} />
      </div>
    </Drawer>
  );
}

function LiveRunModal({
  run,
  displayName,
  tenantName,
  providerName,
  providerIsLocal,
  trustDetail,
  onBackground,
  onCancel,
}: {
  run: RunRecord;
  displayName: string;
  tenantName: string;
  providerName: string;
  providerIsLocal?: boolean;
  trustDetail: string;
  onBackground: () => void;
  onCancel: () => Promise<RunRecord>;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <Modal
      open
      size="lg"
      closeOnScrim={false}
      ariaLabel={`Live run: ${displayName}`}
      onClose={() => void onCancel()}
    >
      <header className="flex shrink-0 items-start gap-3 border-b border-[var(--color-border-soft)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-md font-semibold text-[var(--color-text)]">
              {displayName}
            </h2>
            <Badge tone={run.status === "running" ? "info" : "warning"}>
              <StatusDot tone={run.status === "running" ? "info" : "warning"} />
              {statusLabel(run.status)}
            </Badge>
          </div>
          <div className="mt-1 truncate text-sm text-[var(--color-text-muted)]">
            {tenantName} · {providerName} · {run.id}
          </div>
        </div>
        <RunActionsMenu run={run} agentName={displayName} tenantName={tenantName} />
      </header>

      <RunTelemetry
        run={run}
        nowMs={nowMs}
        isLive
        providerIsLocal={providerIsLocal}
        providerName={providerName}
      />

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        {run.liveSummary || run.summary ? (
          <section
            aria-label="Live summary"
            aria-live="polite"
            className="border-b border-[var(--color-border-soft)] pb-5"
          >
            <MarkdownPreview
              source={run.liveSummary ?? run.summary ?? ""}
              className="text-base leading-relaxed text-[var(--color-text)]"
            />
          </section>
        ) : null}
        {run.result !== undefined ? <ResultPanel run={run} /> : null}
        <ActivityFeed run={run} />
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-3 border-t border-[var(--color-border-soft)] px-5 py-3">
        <div className="min-w-0 flex-1">
          <TrustLine local={providerIsLocal === true} detail={trustDetail} />
        </div>
        <Button variant="secondary" size="sm" onClick={onBackground}>
          Run in background
        </Button>
        <Button variant="danger" size="sm" onClick={() => void onCancel()}>
          Cancel run
        </Button>
      </footer>
    </Modal>
  );
}

function ConfirmationPage({
  run,
  displayName,
  tenantName,
  trustDetail,
  providerIsLocal,
  onBack,
  onConfirm,
  onReject,
}: {
  run: RunRecord;
  displayName: string;
  tenantName: string;
  trustDetail: string;
  providerIsLocal: boolean;
  onBack: () => void;
  onConfirm: (runId: string, phrase: string) => Promise<RunRecord>;
  onReject: (runId: string) => Promise<RunRecord>;
}) {
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
            <Badge tone="warning">Awaiting confirmation</Badge>
            <RunActionsMenu run={run} agentName={displayName} tenantName={tenantName} />
          </>
        }
      />
      <PageBody>
        <div className="mx-auto max-w-[1040px] space-y-6">
          <div className="flex items-start gap-3 border-b border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] px-4 py-3 text-sm text-[var(--color-warning)]">
            <IconWarning size={14} className="mt-0.5 shrink-0" />
            <span>
              Write operation paused for confirmation. OpenAdminOS will not proceed until the exact phrase is typed.
            </span>
          </div>

          <p className="text-base text-[var(--color-text-soft)]">
            {run.tenantId
              ? `Applies to ${tenantName} through Microsoft Graph`
              : `Simulates changes for ${tenantName} without Microsoft Graph writes`}
            {actionCount ? ` · ${actionCount} · ${destructiveCount} destructive` : ""}
          </p>

          {plan && run.tenantId ? (
            <div className="border-l-2 border-[var(--color-danger)] bg-[var(--color-danger-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-danger)]">
              Approving will call Microsoft Graph. {plan.actions.length} planned {plan.actions.length === 1 ? "change" : "changes"} will be applied to {tenantName}. Review every operation below. Microsoft Graph changes may not be reversible.
            </div>
          ) : plan ? (
            <div className="border-l-2 border-[var(--color-info)] bg-[var(--color-info-soft)] px-4 py-3 text-sm leading-relaxed text-[var(--color-info)]">
              Apply will be simulated. No Microsoft Graph writes will be made.
            </div>
          ) : null}

          {run.external?.requiredScopes.length ? (
            <p className="text-sm text-[var(--color-text-muted)]">
              Required scopes: {run.external.requiredScopes.join(", ")}
            </p>
          ) : null}

          {plan ? (
            <>
              <Section title={plan.summary}>
                <div className="divide-y divide-[var(--color-border-soft)] overflow-hidden rounded-[10px] bg-[var(--color-surface)] ring-1 ring-[var(--color-border)]">
                  {plan.actions.map((action, index) => (
                    <ActionRow key={action.id} action={action} index={index} />
                  ))}
                </div>
              </Section>
              <TypedConfirmation
                runId={run.id}
                plan={plan}
                onConfirm={onConfirm}
                onReject={onReject}
              />
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
  onConfirm,
  onReject,
}: {
  runId: string;
  plan: WritePlan;
  onConfirm: (runId: string, phrase: string) => Promise<RunRecord>;
  onReject: (runId: string) => Promise<RunRecord>;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed === plan.confirmationPhrase;

  const confirm = async () => {
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
      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(220px,0.8fr)_minmax(260px,1fr)_auto]">
        <div className="flex min-h-11 items-center rounded-lg bg-[var(--color-bg-raised)] px-4 font-mono text-base text-[var(--color-warning)] ring-1 ring-[var(--color-border)]">
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
              : "ring-[var(--color-border)] focus:ring-[var(--color-accent)]"
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

function ActionRow({ action, index }: { action: WriteAction; index: number }) {
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

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
