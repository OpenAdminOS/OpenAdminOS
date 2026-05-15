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
  IconCopy,
  IconDownload,
  IconHardDrive,
  IconLock,
  IconPlay,
  IconShare,
  IconWarning,
} from "../components/icons";
import { useAppState } from "../state";
import type {
  RunRecord,
  RunStatus,
  RunStepRecord,
  TenantRecord,
  WriteAction,
  WritePlan,
} from "../shared/openAgents";

export default function RunResult() {
  const navigate = useNavigate();
  const { id } = useParams();
  const { state, startRun, confirmRun, rejectRun } = useAppState();
  const run = state.runs.find((candidate) => candidate.id === id);
  const agent = run
    ? state.installedAgents.find((candidate) => candidate.slug === run.agentSlug)
    : undefined;
  const isLive = run?.status === "queued" || run?.status === "running";
  const isAwaiting = run?.status === "awaiting-confirmation";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    const intervalId = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(intervalId);
  }, [isLive]);

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
          <span className="inline-flex items-center gap-2">
            <Pill tone={statusTone(run.status)}>
              {run.status === "completed" ? (
                <IconCheck size={10} />
              ) : run.status === "failed" || run.status === "rejected" ? (
                <IconWarning size={10} />
              ) : run.status === "awaiting-confirmation" ? (
                <IconBolt size={10} />
              ) : (
                <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />
              )}
              {statusLabel(run.status)}
            </Pill>
            {isLive && (
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--color-text-muted)]">
                <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-[var(--color-warning)]" />
                Streaming updates
              </span>
            )}
            {run.dataSource && (
              <Pill tone={run.dataSource === "graph" ? "success" : "default"}>
                {run.dataSource === "graph"
                  ? `Tenant: ${
                      state.tenants.find((tenant) => tenant.id === run.tenantId)?.displayName ??
                      run.tenantId ??
                      "real"
                    }`
                  : "Synthetic data"}
              </Pill>
            )}
            <span>{formatDate(run.queuedAt)}</span>
            <span className="opacity-50">·</span>
            <span>{run.providerId ?? "provider pending"}</span>
            {run.model && (
              <>
                <span className="opacity-50">·</span>
                <span className="font-mono">{run.model}</span>
              </>
            )}
          </span>
        }
        actions={
          <>
            <Button variant="secondary" size="md" leadingIcon={<IconCopy size={12} />}>
              Copy report
            </Button>
            <Button variant="secondary" size="md" leadingIcon={<IconDownload size={12} />}>
              Export
            </Button>
            <Button variant="secondary" size="md" leadingIcon={<IconShare size={12} />}>
              Share
            </Button>
            {!isLive && !isAwaiting && (
              <Button
                variant="primary"
                size="md"
                leadingIcon={<IconPlay size={12} />}
                onClick={() => {
                  void startRun(run.agentSlug).then((nextRun) =>
                    navigate(`/runs/${nextRun.id}`),
                  );
                }}
              >
                Run again
              </Button>
            )}
          </>
        }
      />
      <PageBody>
        <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <Card>
            <div className="flex items-stretch gap-6 p-6">
              <div className="flex flex-col justify-center">
                <SectionLabel>Run summary</SectionLabel>
                <div className="mt-3 max-w-[680px] text-[18px] font-medium leading-relaxed text-[var(--color-text)]">
                  {run.summary ?? "Run is waiting for its first update."}
                </div>
                <div className="mt-4 flex items-center gap-2">
                  <Pill tone={statusTone(run.status)}>{statusLabel(run.status)}</Pill>
                  <Pill>{run.steps.length} steps</Pill>
                  <Pill>{run.logs.length} logs</Pill>
                  {run.plan && <Pill tone="warning">{run.plan.actions.length} planned actions</Pill>}
                </div>
              </div>
              <div className="ml-auto flex flex-col items-end justify-center gap-2 border-l border-[var(--color-border-soft)] pl-6">
                <SmallStat label="Duration" value={formatDuration(run, now)} mono />
                <SmallStat label="Provider" value={run.providerId ?? "-"} mono />
                <SmallStat
                  label="Cost"
                  value={state.trust.isLocal ? "$0.00" : "External"}
                  valueClass="text-[var(--color-success)]"
                  caption={state.trust.label}
                />
              </div>
            </div>
          </Card>

          <Card>
            <div className="p-6">
              <SectionLabel>Data residency</SectionLabel>
              <div className="mt-3 flex items-center gap-2">
                <IconHardDrive size={16} className="text-[var(--color-success)]" />
                <span className="text-[14px] font-medium text-[var(--color-text)]">
                  {state.trust.label}
                </span>
              </div>
              <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                {state.trust.detail}
              </div>
            </div>
          </Card>
        </div>

        {isAwaiting && run.plan && (
          <DiffConfirmPanel
            runId={run.id}
            plan={run.plan}
            onConfirm={confirmRun}
            onReject={rejectRun}
          />
        )}

        <TenantDriftNote
          runTenantId={run.tenantId}
          activeTenantId={state.activeTenantId}
          tenants={state.tenants}
        />

        <Card className="mb-6">
          <div className="p-6">
            <SectionLabel>Steps</SectionLabel>
            <div className="mt-4 flex flex-col gap-2">
              {run.steps.length === 0 ? (
                <div className="text-[12px] text-[var(--color-text-muted)]">
                  No steps recorded yet.
                </div>
              ) : (
                run.steps.map((step) => <StepRow key={step.id} step={step} />)
              )}
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <div className="p-6">
              <SectionLabel>Result</SectionLabel>
              <pre className="mt-4 max-h-[360px] overflow-auto rounded-lg bg-[var(--color-bg-raised)] p-4 font-mono text-[11.5px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
                {JSON.stringify(run.result ?? { status: run.status }, null, 2)}
              </pre>
            </div>
          </Card>

          <Card>
            <div className="p-6">
              <SectionLabel>Logs</SectionLabel>
              <div className="mt-4 flex max-h-[360px] flex-col gap-2 overflow-auto">
                {run.logs.length === 0 ? (
                  <div className="text-[12px] text-[var(--color-text-muted)]">
                    No logs recorded yet.
                  </div>
                ) : (
                  run.logs.map((log) => (
                    <div
                      key={log.id}
                      className="rounded-lg bg-[var(--color-bg-raised)] p-3 font-mono text-[11.5px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]"
                    >
                      <span className="text-[var(--color-text-muted)]">
                        {formatTime(log.timestamp)} {log.level}
                      </span>{" "}
                      {log.message}
                    </div>
                  ))
                )}
              </div>
            </div>
          </Card>
        </div>
      </PageBody>
    </>
  );
}

function TenantDriftNote({
  runTenantId,
  activeTenantId,
  tenants,
}: {
  runTenantId: string | undefined;
  activeTenantId: string | undefined;
  tenants: TenantRecord[];
}) {
  if (!runTenantId) return null;
  if (runTenantId === activeTenantId) return null;
  const runTenant = tenants.find((tenant) => tenant.id === runTenantId);
  const activeTenant = activeTenantId
    ? tenants.find((tenant) => tenant.id === activeTenantId)
    : undefined;
  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg bg-[var(--color-info-soft)] px-4 py-3 ring-1 ring-[var(--color-info)]/25">
      <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-info)]" />
      <div className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
        This run executed against{" "}
        <span className="font-medium text-[var(--color-text)]">
          {runTenant?.displayName ?? `tenant ${runTenantId}`}
        </span>
        . The active tenant is now{" "}
        <span className="font-medium text-[var(--color-text)]">
          {activeTenant?.displayName ?? "Synthetic data"}
        </span>
        , so results below reflect the original tenant, not the current one.
      </div>
    </div>
  );
}

function DiffConfirmPanel({
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
  const destructive = action.severity === "destructive";
  return (
    <div className="grid grid-cols-[40px_1fr_auto] items-center gap-4 px-5 py-3">
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
        <IconBolt size={9} /> {action.kind}
      </Pill>
    </div>
  );
}

function StepRow({ step }: { step: RunStepRecord }) {
  const isRunning = step.status === "running";

  return (
    <div
      className={`rounded-lg bg-[var(--color-bg-raised)] p-3 ring-1 ${
        isRunning
          ? "ring-[var(--color-warning)]/40"
          : "ring-[var(--color-border-soft)]"
      }`}
    >
      <div className="flex items-center gap-3">
        <Pill tone={stepTone(step.status)}>
          {isRunning && (
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />
          )}
          {step.status}
        </Pill>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-[var(--color-text)]">
            {step.label}
          </div>
          {step.detail && (
            <div className="mt-0.5 text-[11.5px] text-[var(--color-text-muted)]">
              {step.detail}
            </div>
          )}
        </div>
      </div>
      {step.thinking && step.thinking.text.length > 0 && (
        <div className="mt-3 rounded-md bg-[var(--color-think-soft)] p-3 ring-1 ring-[var(--color-think)]/25">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-think)]">
              Reasoning
            </span>
            <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
              {step.thinking.model}
            </span>
            {step.thinking.streaming && (
              <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-[var(--color-think)]" />
                streaming
              </span>
            )}
          </div>
          <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
            {step.thinking.text}
            {step.thinking.streaming && (
              <span className="ml-1 inline-block h-3.5 w-1.5 -translate-y-px animate-pulse-soft bg-[var(--color-think)]" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function SmallStat({
  label,
  value,
  caption,
  mono = false,
  valueClass = "text-[var(--color-text)]",
}: {
  label: string;
  value: string;
  caption?: string;
  mono?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col items-end leading-tight">
      <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <span
        className={`mt-0.5 text-[16px] font-semibold tabular-nums ${valueClass} ${
          mono ? "font-mono" : ""
        }`}
      >
        {value}
      </span>
      {caption && (
        <span className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
          {caption}
        </span>
      )}
    </div>
  );
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

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDuration(run: RunRecord, nowMs: number) {
  if (run.status === "queued") return "queued";
  if (run.status === "awaiting-confirmation") return "paused";
  if (!run.startedAt) return "-";

  const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : nowMs;
  const durationMs = endMs - new Date(run.startedAt).getTime();
  if (Number.isNaN(durationMs) || durationMs < 0) return "-";

  const suffix = run.status === "running" ? "… " : "";
  return `${suffix}${(durationMs / 1000).toFixed(1)}s`;
}

function statusLabel(status: RunStatus) {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "awaiting-confirmation") return "Awaiting confirmation";
  if (status === "completed") return "Completed";
  if (status === "rejected") return "Rejected";
  return "Failed";
}

function statusTone(status: RunStatus) {
  if (status === "failed") return "danger";
  if (status === "rejected") return "default";
  if (status === "completed") return "success";
  return "warning";
}

function stepTone(status: RunStepRecord["status"]) {
  if (status === "failed") return "danger";
  if (status === "running") return "warning";
  if (status === "completed") return "success";
  return "default";
}
