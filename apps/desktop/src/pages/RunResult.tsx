import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { Button } from "../components/Button";
import {
  IconArrowLeft,
  IconBolt,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconHardDrive,
  IconLock,
  IconPlay,
  IconShield,
  IconWarning,
} from "../components/icons";

import { ShareMenu } from "../components/ShareMenu";
import { ActivityFeed } from "../components/ActivityFeed";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { ResultPanel } from "../components/ResultPanel";
import { RunFailureRemediation } from "../components/RunFailureRemediation";
import { RunTelemetry } from "../components/RunTelemetry";
import { useAppState } from "../state";
import type {
  RunRecord,
  RunStatus,
  TenantRecord,
  WriteAction,
  WritePlan,
} from "../shared/openAgents";
import {
  runReportJson,
  runReportMarkdown,
  runReportPlaintext,
} from "../shared/runReport";

export default function RunResult() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { state, startRun, confirmRun, rejectRun, cancelRun } = useAppState();
  const run = state.runs.find((candidate) => candidate.id === id);
  const agent = run
    ? state.installedAgents.find((candidate) => candidate.slug === run.agentSlug)
    : undefined;
  const isLive = run?.status === "queued" || run?.status === "running";
  const isAwaiting = run?.status === "awaiting-confirmation";
  const tenantDisplayName = run?.tenantId
    ? state.tenants.find((tenant) => tenant.id === run.tenantId)?.displayName
    : undefined;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    const intervalId = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(intervalId);
  }, [isLive]);

  // Keyboard: Esc cancels a live run.
  useEffect(() => {
    if (!isLive || !run) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void cancelRun(run.id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isLive, run, cancelRun]);

  if (!run) {
    return (
      <>
        <PageHeader
          eyebrow={
            <button
              onClick={() => navigate("/activity")}
              className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
            >
              <IconArrowLeft size={12} /> Run history
            </button>
          }
          title="Run not found"
          subtitle="This run is not present in local history."
        />
        <PageBody>
          <Card>
            <div className="p-8 text-[13px] text-[var(--color-text-muted)]">
              Run records are stored locally in this app profile. It may have
              been removed or created in another profile.
            </div>
          </Card>
        </PageBody>
      </>
    );
  }

  const reRun = () => {
    // Preserve the run's tenant pinning, provider override, AND model
    // override so re-runs don't silently drift to whatever's currently
    // active globally.
    const options: {
      tenantId?: string;
      providerId?: typeof run.providerId;
      model?: string;
    } = {};
    if (run.tenantId) options.tenantId = run.tenantId;
    if (run.providerId) options.providerId = run.providerId;
    if (run.model) options.model = run.model;
    void startRun(run.agentSlug, options).then((nextRun) =>
      navigate(`/runs/${nextRun.id}`),
    );
  };

  return (
    <>
      <PageHeader
        eyebrow={
          <button
            onClick={() => navigate("/activity")}
            className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text)]"
          >
            <IconArrowLeft size={12} /> Run history
          </button>
        }
        title={agent?.name ?? run.agentSlug}
        subtitle={
          <div className="flex flex-col gap-1">
            <span className="inline-flex flex-wrap items-center gap-2">
              <Pill tone={statusTone(run.status)}>
                {statusIcon(run.status)}
                {statusLabel(run.status)}
              </Pill>
              {isLive && (
                <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                  <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-[var(--color-warning)]" />
                  Streaming updates
                </span>
              )}
              {run.tenantId && (
                <Pill tone="success">
                  Tenant: {tenantDisplayName ?? run.tenantId}
                </Pill>
              )}
              {agent && (
                <Pill tone={agent.mode === "write" ? "warning" : "default"}>
                  {agent.mode === "write" ? "Write" : "Read"} · {agent.category}
                </Pill>
              )}
            </span>
            <span className="inline-flex flex-wrap items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
              <span>{formatDate(run.queuedAt)}</span>
              <span className="opacity-50">·</span>
              <span>{run.providerId ?? "provider pending"}</span>
              {run.model && (
                <>
                  <span className="opacity-50">·</span>
                  <span className="font-mono">{run.model}</span>
                </>
              )}
              <span className="opacity-50">·</span>
              <button
                onClick={() => {
                  void navigator.clipboard.writeText(run.id);
                }}
                title="Copy run id"
                className="inline-flex items-center gap-1 font-mono transition-colors hover:text-[var(--color-text)]"
              >
                <IconCopy size={10} />
                <span>{run.id.slice(0, 8)}</span>
              </button>
            </span>
          </div>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="md"
              leadingIcon={<IconCopy size={12} />}
              onClick={() => {
                void navigator.clipboard.writeText(
                  runReportPlaintext(run, {
                    agentName: agent?.name,
                    tenantName: tenantDisplayName,
                  }),
                );
              }}
            >
              Copy report
            </Button>
            <Button
              variant="secondary"
              size="md"
              leadingIcon={<IconDownload size={12} />}
              onClick={() => {
                void window.openAgents?.saveTextFile({
                  suggestedName: `${run.agentSlug}-${run.id}.json`,
                  content: runReportJson(run),
                  filters: [{ name: "JSON", extensions: ["json"] }],
                });
              }}
            >
              Export
            </Button>
            <ShareMenu
              contextLabel="run"
              onCopyLink={() => {
                void navigator.clipboard.writeText(`openagents://run/${run.id}`);
              }}
              copyLinkHint={`openagents://run/${run.id}`}
              onExportMarkdown={() => {
                void window.openAgents?.saveTextFile({
                  suggestedName: `${run.agentSlug}-${run.id}.md`,
                  content: runReportMarkdown(run, {
                    agentName: agent?.name,
                    tenantName: tenantDisplayName,
                  }),
                  filters: [{ name: "Markdown", extensions: ["md"] }],
                });
              }}
              exportMarkdownHint="Save report as .md"
            />
            {isLive && (
              <>
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => navigate("/")}
                  title="Run continues in the background"
                >
                  Run in background
                </Button>
                <Button
                  size="md"
                  onClick={() => {
                    void cancelRun(run.id);
                  }}
                  className="!bg-[var(--color-danger-soft)] !text-[var(--color-danger)] !ring-1 !ring-[var(--color-danger)]/30 hover:!bg-[var(--color-danger)]/15"
                  title="Cancel run (Esc)"
                >
                  Cancel run
                </Button>
              </>
            )}
            {!isLive && !isAwaiting && (
              <Button
                variant="primary"
                size="md"
                leadingIcon={<IconPlay size={12} />}
                onClick={reRun}
                title="Re-run with the same tenant pinning"
              >
                Run again
              </Button>
            )}
          </>
        }
      />
      <RunTelemetry run={run} nowMs={now} isLive={isLive} />
      <PageBody>
        <TenantDriftNote
          runTenantId={run.tenantId}
          activeTenantId={state.activeTenantId}
          tenants={state.tenants}
          onRetargetCurrent={() => {
            const options: { tenantId?: string } = {};
            if (state.activeTenantId) options.tenantId = state.activeTenantId;
            void startRun(run.agentSlug, options).then((nextRun) =>
              navigate(`/runs/${nextRun.id}`),
            );
          }}
        />

        <OutcomeCard run={run} agent={agent} trustLabel={state.trust.label} />

        {isAwaiting && run.plan && (
          <DiffConfirmPanel
            runId={run.id}
            plan={run.plan}
            onConfirm={confirmRun}
            onReject={rejectRun}
            writesAreReal={Boolean(run.tenantId)}
            tenantDisplayName={tenantDisplayName}
          />
        )}

        <RunFailureRemediation run={run} />

        <ActivityFeed run={run} />

        <ResultPanel run={run} />

        <div className="mt-2 flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
          <span
            className={
              state.trust.isLocal
                ? "inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-success)]"
                : "inline-block h-1.5 w-1.5 rounded-full bg-[var(--color-info)]"
            }
          />
          <span>{state.trust.detail}</span>
        </div>
      </PageBody>
    </>
  );
}

function statusIcon(status: RunStatus) {
  if (status === "completed") return <IconCheck size={10} />;
  if (status === "failed" || status === "rejected" || status === "cancelled") {
    return <IconWarning size={10} />;
  }
  if (status === "awaiting-confirmation") return <IconBolt size={10} />;
  return <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />;
}

function OutcomeCard({
  run,
  agent,
  trustLabel,
}: {
  run: RunRecord;
  agent: ReturnType<typeof useAppState>["state"]["installedAgents"][number] | undefined;
  trustLabel: string;
}) {
  return (
    <Card className="mb-6">
      <div className="grid grid-cols-1 gap-0 lg:grid-cols-[1fr_320px]">
        <div className="p-6">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {statusToOutcomeLabel(run.status)}
          </div>
          {run.summary ? (
            <MarkdownPreview
              source={run.summary}
              className="mt-3 text-[18px] font-medium leading-relaxed text-[var(--color-text)]"
            />
          ) : (
            <div className="mt-3 text-[18px] font-medium leading-relaxed text-[var(--color-text)]">
              Run is waiting for its first update.
            </div>
          )}
          {agent?.description && (
            <p className="mt-3 max-w-[640px] text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              {agent.description}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Pill>
              {run.steps.length} step{run.steps.length === 1 ? "" : "s"}
            </Pill>
            <Pill>
              {run.logs.length} log{run.logs.length === 1 ? "" : "s"}
            </Pill>
            {run.plan && (
              <Pill tone="warning">
                <IconLock size={9} /> {run.plan.actions.length} planned action
                {run.plan.actions.length === 1 ? "" : "s"}
              </Pill>
            )}
          </div>
        </div>
        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] p-6 lg:border-l lg:border-t-0">
          <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Data residency
          </div>
          <div className="mt-3 flex items-center gap-2">
            <IconHardDrive size={14} className="text-[var(--color-success)]" />
            <span className="text-[13px] font-medium text-[var(--color-text)]">
              {trustLabel}
            </span>
          </div>
          <div className="mt-4 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
            Run records are written to this profile's local store. They never
            leave the device when a local LLM provider is selected.
          </div>
        </div>
      </div>
    </Card>
  );
}

function statusToOutcomeLabel(status: RunStatus): string {
  if (status === "completed") return "Completed";
  if (status === "running" || status === "queued") return "In progress";
  if (status === "awaiting-confirmation") return "Waiting for confirmation";
  if (status === "failed") return "Failed";
  if (status === "rejected") return "Rejected";
  if (status === "cancelled") return "Cancelled";
  return "Outcome";
}

function TenantDriftNote({
  runTenantId,
  activeTenantId,
  tenants,
  onRetargetCurrent,
}: {
  runTenantId: string | undefined;
  activeTenantId: string | undefined;
  tenants: TenantRecord[];
  onRetargetCurrent: () => void;
}) {
  if (!runTenantId) return null;
  if (runTenantId === activeTenantId) return null;
  const runTenant = tenants.find((tenant) => tenant.id === runTenantId);
  const activeTenant = activeTenantId
    ? tenants.find((tenant) => tenant.id === activeTenantId)
    : undefined;
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3 rounded-lg bg-[var(--color-warning-soft)] px-4 py-3 ring-1 ring-[var(--color-warning)]/30">
      <div className="flex items-start gap-3">
        <IconWarning size={14} className="mt-0.5 shrink-0 text-[var(--color-warning)]" />
        <div className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
          This run executed against{" "}
          <span className="font-medium text-[var(--color-text)]">
            {runTenant?.displayName ?? `tenant ${runTenantId}`}
          </span>
          . The active tenant is now{" "}
          <span className="font-medium text-[var(--color-text)]">
            {activeTenant?.displayName ?? "no tenant"}
          </span>
          , so the results below reflect the original tenant.
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onRetargetCurrent}>
        Re-run against current tenant
      </Button>
    </div>
  );
}

function DiffConfirmPanel({
  runId,
  plan,
  onConfirm,
  onReject,
  writesAreReal,
  tenantDisplayName,
}: {
  runId: string;
  plan: WritePlan;
  onConfirm: (runId: string, phrase: string) => Promise<RunRecord>;
  onReject: (runId: string) => Promise<RunRecord>;
  writesAreReal: boolean;
  tenantDisplayName: string | undefined;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = typed === plan.confirmationPhrase;
  const destructiveCount = plan.actions.filter(
    (action) => action.severity === "destructive",
  ).length;

  const handleConfirm = async () => {
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

  const handleReject = async () => {
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
    <Card className="mb-6 ring-[var(--color-warning)]/35">
      <div className="border-b border-[var(--color-warning)]/30 bg-[var(--color-warning-soft)] px-6 py-3">
        <div className="flex items-center gap-3 text-[12.5px] font-medium text-[var(--color-warning)]">
          <IconWarning size={14} />
          Write operation paused for confirmation. Open Agents will not proceed until the exact phrase is typed.
        </div>
      </div>

      {writesAreReal ? (
        <div className="border-b border-[var(--color-danger)]/35 bg-[var(--color-danger-soft)] px-6 py-3">
          <div className="flex items-start gap-3 text-[12.5px] text-[var(--color-danger)]">
            <IconWarning size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-semibold">Approving will call Microsoft Graph.</span>{" "}
              {plan.actions.length} {plan.actions.length === 1 ? "device" : "devices"} in{" "}
              <span className="font-mono">{tenantDisplayName ?? "the active tenant"}</span>{" "}
              will be retired. There is no undo at the Graph level.
            </span>
          </div>
        </div>
      ) : (
        <div className="border-b border-[var(--color-info)]/25 bg-[var(--color-info-soft)] px-6 py-3">
          <div className="flex items-start gap-3 text-[12.5px] text-[var(--color-info)]">
            <IconShield size={14} className="mt-0.5 shrink-0" />
            <span>
              <span className="font-semibold">Apply will be simulated.</span>{" "}
              No Graph writes. The agent will emit a trace of what it would have
              retired. Connect a real tenant in Settings → Tenants to perform
              real changes.
            </span>
          </div>
        </div>
      )}

      <div className="p-6">
        <div className="mb-5 flex items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="mb-1.5 flex items-center gap-2">
              <Pill tone="warning">
                <IconBolt size={10} /> Write
              </Pill>
              <Pill>
                <IconLock size={10} /> {plan.actions.length} action{plan.actions.length === 1 ? "" : "s"}
              </Pill>
              {destructiveCount > 0 && (
                <Pill tone="danger">{destructiveCount} destructive</Pill>
              )}
            </div>
            <h2 className="text-[18px] font-medium text-[var(--color-text)]">
              {plan.summary}
            </h2>
          </div>
        </div>

        <div className="mb-6 rounded-lg ring-1 ring-[var(--color-border-soft)]">
          <div className="border-b border-[var(--color-border-soft)] px-5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            Operations
          </div>
          <div className="max-h-[320px] divide-y divide-[var(--color-border-soft)] overflow-auto">
            {plan.actions.map((action, index) => (
              <ActionRow key={action.id} action={action} index={index} />
            ))}
          </div>
        </div>

        <div className="rounded-lg bg-[var(--color-bg-raised)] p-5 ring-1 ring-[var(--color-border-soft)]">
          <div className="flex items-start gap-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-warning-soft)]">
              <IconWarning size={18} className="text-[var(--color-warning)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium text-[var(--color-text)]">
                Type the phrase below to confirm
              </div>
              <div className="mt-1 text-[12.5px] text-[var(--color-text-soft)]">
                Every destructive operation requires a typed phrase. There is no "remember my choice."
              </div>

              <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-[280px_1fr_auto]">
                <div className="flex h-11 items-center gap-2 rounded-lg bg-[var(--color-bg)] px-4 ring-1 ring-[var(--color-border)]">
                  <span className="font-mono text-[13px] tracking-wide text-[var(--color-warning)]">
                    {plan.confirmationPhrase}
                  </span>
                </div>
                <input
                  autoFocus
                  value={typed}
                  onChange={(event) => setTyped(event.target.value)}
                  placeholder="Type here to enable Apply"
                  disabled={busy}
                  className={`h-11 rounded-lg bg-[var(--color-bg)] px-4 font-mono text-[13px] text-[var(--color-text)] ring-1 placeholder:text-[var(--color-text-muted)] focus:outline-none ${
                    armed
                      ? "ring-[var(--color-warning)]/55 focus:ring-[var(--color-warning)]"
                      : "ring-[var(--color-border)] focus:ring-[var(--color-accent)]/50"
                  }`}
                />
                <div className="flex gap-2">
                  <Button variant="secondary" size="md" onClick={() => void handleReject()} disabled={busy}>
                    Cancel
                  </Button>
                  <Button
                    size="md"
                    disabled={!armed || busy}
                    onClick={() => void handleConfirm()}
                    leadingIcon={<IconBolt size={11} />}
                    className={
                      armed
                        ? "!bg-[var(--color-warning)] !text-[#1a120c] hover:!bg-[var(--color-warning)]/90"
                        : ""
                    }
                  >
                    Apply {plan.actions.length} change{plan.actions.length === 1 ? "" : "s"}
                  </Button>
                </div>
              </div>

              {error && (
                <div className="mt-3 text-[12px] text-[var(--color-danger)]">{error}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ActionRow({ action, index }: { action: WriteAction; index: number }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const destructive = action.severity === "destructive";
  // For graph-write actions we display the HTTP method as the badge;
  // for the legacy retire-managed-device kind (no rendered request)
  // we fall back to the kind string so the existing UI keeps working.
  const badgeLabel = action.request?.method ?? action.kind;
  return (
    <div className="px-5 py-3">
      <div className="grid grid-cols-[40px_1fr_auto] items-center gap-4">
        <div className="font-mono text-[10.5px] text-[var(--color-text-muted)] tabular-nums">
          {String(index + 1).padStart(2, "0")}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium text-[var(--color-text)]">
            {action.label}
          </div>
          {action.description && (
            <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
              {action.description}
            </div>
          )}
        </div>
        <Pill tone={destructive ? "danger" : "default"}>
          <IconBolt size={9} /> {badgeLabel}
        </Pill>
      </div>
      {action.request && (
        <div className="mt-2 pl-[56px]">
          <button
            type="button"
            onClick={() => setPreviewOpen((open) => !open)}
            className="inline-flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-text-soft)]"
          >
            <IconChevronDown
              size={10}
              style={{
                transform: previewOpen ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
              }}
            />
            {previewOpen ? "Hide request preview" : "Show request preview"}
          </button>
          {previewOpen && (
            <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md bg-[var(--color-bg-raised)] p-3 font-mono text-[11px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
              {formatRequestPreview(action.request)}
            </pre>
          )}
        </div>
      )}
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

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusLabel(status: RunStatus) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "awaiting-confirmation") return "Awaiting confirmation";
  if (status === "completed") return "Completed";
  if (status === "rejected") return "Rejected";
  if (status === "cancelled") return "Cancelled";
  return "Failed";
}

function statusTone(status: RunStatus) {
  if (status === "failed") return "danger";
  if (status === "rejected" || status === "cancelled") return "default";
  if (status === "completed") return "success";
  return "warning";
}
