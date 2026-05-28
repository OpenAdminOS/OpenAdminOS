import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { PageBody, PageHeader } from "../components/AppShell";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Pill } from "../components/Pill";
import { useToast } from "../components/Toast";
import {
  IconCheck,
  IconClock,
  IconHub,
  IconPlay,
  IconWarning,
} from "../components/icons";
import { useAppState } from "../state";
import type {
  AgentSchedule,
  AgentSummary,
  RunRecord,
} from "../shared/openAdminOS";

const QUICK_INTERVALS: { label: string; seconds: number }[] = [
  { label: "15m", seconds: 15 * 60 },
  { label: "1h", seconds: 60 * 60 },
  { label: "4h", seconds: 4 * 60 * 60 },
  { label: "24h", seconds: 24 * 60 * 60 },
];

export default function Schedules() {
  const navigate = useNavigate();
  const toast = useToast();
  const { state, updateAgentSchedule, startRun, refresh } = useAppState();
  const [bulkRunning, setBulkRunning] = useState<"due" | "all" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [schedulerRegistered, setSchedulerRegistered] = useState<boolean | null>(null);
  const scheduledAgents = state.installedAgents
    .filter((agent) => agent.schedule?.enabled === true)
    .sort((a, b) => nextRunTime(a) - nextRunTime(b));
  const unscheduledAgents = state.installedAgents
    .filter((agent) => agent.schedule?.enabled !== true)
    .sort((a, b) => a.name.localeCompare(b.name));
  const dueAgents = scheduledAgents.filter((agent) => nextRunTime(agent) <= Date.now());

  useEffect(() => {
    let cancelled = false;
    const loadScheduler = () => {
      window.openAdminOS
        ?.getSchedulerLaunchSettings()
        .then((settings) => {
          if (!cancelled) setSchedulerRegistered(settings.enabled === true);
        })
        .catch(() => {
          if (!cancelled) setSchedulerRegistered(null);
        });
    };
    loadScheduler();
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
      void refresh();
      loadScheduler();
    }, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [refresh]);

  const runScheduledBatch = async (agents: AgentSummary[], mode: "due" | "all") => {
    if (agents.length === 0) {
      toast.info(mode === "due" ? "No schedules are due." : "No schedules are enabled.");
      return;
    }
    setBulkRunning(mode);
    let started = 0;
    try {
      for (const agent of agents) {
        await startRun(agent.slug);
        started += 1;
      }
      toast.success(
        `${started} scheduled ${started === 1 ? "run" : "runs"} queued.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBulkRunning(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Agents"
        title="Schedules"
        subtitle={
          <span>
            {scheduledAgents.length} active {scheduledAgents.length === 1 ? "schedule" : "schedules"}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              leadingIcon={<IconPlay size={14} />}
              disabled={bulkRunning !== null || dueAgents.length === 0}
              onClick={() => {
                void runScheduledBatch(dueAgents, "due");
              }}
            >
              {bulkRunning === "due" ? "Queueing…" : `Run due (${dueAgents.length})`}
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<IconPlay size={14} />}
              disabled={bulkRunning !== null || scheduledAgents.length === 0}
              onClick={() => {
                void runScheduledBatch(scheduledAgents, "all");
              }}
            >
              {bulkRunning === "all" ? "Queueing…" : "Run all"}
            </Button>
            <Button
              variant="secondary"
              leadingIcon={<IconHub size={14} />}
              onClick={() => navigate("/hub")}
            >
              Browse hub
            </Button>
          </div>
        }
      />
      <PageBody>
        <div className="space-y-6">
        {scheduledAgents.length > 0 && schedulerRegistered === false && (
          <ScheduleNotice
            tone="warning"
            title="Background scheduler is off"
            body="Schedules run while OpenAdminOS is open. Enable the OS scheduler in Settings to run due agents while the UI is closed."
          />
        )}

        {state.schedulerStatus?.lastError && (
          <ScheduleNotice
            tone="danger"
            title="Latest scheduled run failed"
            body={state.schedulerStatus.lastError}
          />
        )}

        {scheduledAgents.length === 0 ? (
          <Card>
            <div className="flex min-h-[260px] flex-col items-center justify-center px-6 py-10 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                <IconClock size={18} />
              </div>
              <h2 className="mt-4 text-[15px] font-medium text-[var(--color-text)]">
                No schedules configured
              </h2>
              <p className="mt-2 max-w-[460px] text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
                Create a schedule here or open an installed agent and choose an
                interval from its Schedule card. Scheduled runs use the active
                tenant pinned at queue time.
              </p>
            </div>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {scheduledAgents.map((agent) => (
              <ScheduleRow
                key={agent.slug}
                agent={agent}
                nowMs={now}
                runs={state.runs}
                onOpen={() => navigate(`/agents/${agent.slug}`)}
                onRunNow={async () => {
                  try {
                    const run = await startRun(agent.slug);
                    navigate(`/runs/${run.id}`);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : String(error));
                  }
                }}
                onDisable={async () => {
                  try {
                    await updateAgentSchedule(agent.slug, null);
                    toast.success(`${agent.name} schedule disabled.`);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : String(error));
                  }
                }}
                onUpdateSchedule={async (schedule) => {
                  try {
                    await updateAgentSchedule(agent.slug, schedule);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : String(error));
                  }
                }}
              />
            ))}
          </div>
        )}

        {unscheduledAgents.length > 0 && (
          <Card>
            <div className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[13px] font-medium text-[var(--color-text)]">
                    Add schedule
                  </h2>
                  <p className="mt-1 text-[12px] text-[var(--color-text-soft)]">
                    Choose an interval for an installed agent.
                  </p>
                </div>
                <span className="font-mono text-[11px] text-[var(--color-text-muted)]">
                  {unscheduledAgents.length} manual
                </span>
              </div>
              <div className="mt-4 divide-y divide-[var(--color-border-soft)]">
                {unscheduledAgents.map((agent) => (
                  <UnscheduledRow
                    key={agent.slug}
                    agent={agent}
                    onOpen={() => navigate(`/agents/${agent.slug}`)}
                    onSchedule={async (schedule) => {
                      try {
                        await updateAgentSchedule(agent.slug, schedule);
                        toast.success(`${agent.name} scheduled.`);
                      } catch (error) {
                        toast.error(error instanceof Error ? error.message : String(error));
                      }
                    }}
                  />
                ))}
              </div>
            </div>
          </Card>
        )}

        <ScheduleActivityTimeline
          runs={state.runs}
          agents={state.installedAgents}
          onOpenRun={(id) => navigate(`/runs/${id}`)}
        />
        </div>
      </PageBody>
    </>
  );
}

function ScheduleRow({
  agent,
  nowMs,
  runs,
  onOpen,
  onRunNow,
  onDisable,
  onUpdateSchedule,
}: {
  agent: AgentSummary;
  nowMs: number;
  runs: RunRecord[];
  onOpen: () => void;
  onRunNow: () => Promise<void>;
  onDisable: () => Promise<void>;
  onUpdateSchedule: (schedule: AgentSchedule) => Promise<void>;
}) {
  const schedule = agent.schedule;
  const intervalSeconds = schedule?.intervalSeconds ?? 3600;
  const nextMs = nextRunTime(agent);
  const runState = getScheduleRunState(agent, runs, nextMs, nowMs);
  const latestScheduledRun = latestScheduledRunForAgent(agent, runs);
  const notificationPrefs = {
    notifyOnSuccess: schedule?.notifyOnSuccess ?? true,
    notifyOnFailure: schedule?.notifyOnFailure ?? true,
    notifyOnChangeOnly: schedule?.notifyOnChangeOnly ?? false,
  };

  return (
    <Card>
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-[14px] font-medium text-[var(--color-text)]">
                {agent.name}
              </h2>
              <Pill tone={agent.mode === "write" ? "warning" : "default"}>
                {agent.mode === "write" ? "Write" : "Read"}
              </Pill>
              <Pill tone="success">Every {formatInterval(intervalSeconds)}</Pill>
              {latestScheduledRun?.changeState && (
                <Pill tone={latestScheduledRun.changeState === "unchanged" ? "default" : "warning"}>
                  {changeLabel(latestScheduledRun.changeState)}
                </Pill>
              )}
              {latestScheduledRun && <ScheduleOutcomePill run={latestScheduledRun} />}
            </div>
            <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
              {agent.description}
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <ScheduleMetric
            label="Next run"
            value={formatNextRun(nextMs, nowMs)}
            state={runState}
          />
          <ScheduleMetric
            label="Last run"
            value={
              schedule?.lastScheduledRunAt
                ? formatRelative(schedule.lastScheduledRunAt)
                : "not yet"
            }
          />
        </div>

        {agent.mode === "write" && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-[var(--color-warning-soft)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25">
            <IconWarning size={12} className="mt-0.5 shrink-0" />
            <span>Scheduled write runs still pause for confirmation before changes.</span>
          </div>
        )}

        {schedule && (
          <div className="mt-3 rounded-md bg-[var(--color-bg-raised)] p-3 ring-1 ring-[var(--color-border-soft)]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
                Notifications
              </span>
              <span className="text-[10.5px] text-[var(--color-text-muted)]">
                OS notification
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <SchedulePreferenceToggle
                label="Success"
                active={notificationPrefs.notifyOnSuccess}
                onClick={() =>
                  void onUpdateSchedule({
                    ...schedule,
                    notifyOnSuccess: !notificationPrefs.notifyOnSuccess,
                  })
                }
              />
              <SchedulePreferenceToggle
                label="Failure"
                active={notificationPrefs.notifyOnFailure}
                onClick={() =>
                  void onUpdateSchedule({
                    ...schedule,
                    notifyOnFailure: !notificationPrefs.notifyOnFailure,
                  })
                }
              />
              <SchedulePreferenceToggle
                label="Changes only"
                active={notificationPrefs.notifyOnChangeOnly}
                onClick={() =>
                  void onUpdateSchedule({
                    ...schedule,
                    notifyOnChangeOnly: !notificationPrefs.notifyOnChangeOnly,
                  })
                }
              />
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onOpen}>
            Open
          </Button>
          <Button variant="secondary" size="sm" leadingIcon={<IconPlay size={12} />} onClick={() => void onRunNow()}>
            Run now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void onDisable()}>
            Disable
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ScheduleOutcomePill({ run }: { run: RunRecord }) {
  if (run.status === "completed") {
    return (
      <Pill tone="success">
        <IconCheck size={10} /> Success
      </Pill>
    );
  }
  if (run.status === "failed") return <Pill tone="danger">Failed</Pill>;
  if (run.status === "awaiting-confirmation") return <Pill tone="warning">Needs confirmation</Pill>;
  return <Pill>{run.status}</Pill>;
}

function SchedulePreferenceToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
        active
          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/25"
          : "bg-[var(--color-surface)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </button>
  );
}

function ScheduleNotice({
  tone,
  title,
  body,
}: {
  tone: "warning" | "danger";
  title: string;
  body: string;
}) {
  const toneClass =
    tone === "danger"
      ? "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/30"
      : "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning)]/25";
  return (
    <div className={`flex items-start gap-3 rounded-lg px-4 py-3 text-[12px] ring-1 ${toneClass}`}>
      <IconWarning size={14} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div className="mt-1 leading-relaxed opacity-85">
          {body}
        </div>
      </div>
    </div>
  );
}

function ScheduleActivityTimeline({
  runs,
  agents,
  onOpenRun,
}: {
  runs: RunRecord[];
  agents: AgentSummary[];
  onOpenRun: (id: string) => void;
}) {
  const scheduledRuns = runs.filter((run) => run.trigger === "schedule").slice(0, 6);
  if (scheduledRuns.length === 0) return null;
  return (
    <Card>
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[13px] font-medium text-[var(--color-text)]">
            Schedule activity
          </h2>
          <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
            latest {scheduledRuns.length}
          </span>
        </div>
        <div className="mt-4 divide-y divide-[var(--color-border-soft)]">
          {scheduledRuns.map((run) => (
            <button
              key={run.id}
              onClick={() => onOpenRun(run.id)}
              className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 py-3 text-left first:pt-0 last:pb-0 hover:text-[var(--color-accent)]"
            >
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-medium text-[var(--color-text)]">
                  {agents.find((agent) => agent.slug === run.agentSlug)?.name ?? run.agentSlug}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">
                  {run.summary ?? run.error ?? run.id}
                </div>
              </div>
              {run.changeState && (
                <Pill tone={run.changeState === "unchanged" ? "default" : "warning"}>
                  {changeLabel(run.changeState)}
                </Pill>
              )}
              <Pill tone={run.status === "completed" ? "success" : run.status === "failed" ? "danger" : "warning"}>
                {run.status}
              </Pill>
            </button>
          ))}
        </div>
      </div>
    </Card>
  );
}

function UnscheduledRow({
  agent,
  onOpen,
  onSchedule,
}: {
  agent: AgentSummary;
  onOpen: () => void;
  onSchedule: (schedule: AgentSchedule) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 md:flex-row md:items-center md:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={onOpen}
            className="truncate text-left text-[13px] font-medium text-[var(--color-text)] hover:text-[var(--color-accent)]"
          >
            {agent.name}
          </button>
          <Pill tone={agent.mode === "write" ? "warning" : "default"}>
            {agent.mode === "write" ? "Write" : "Read"}
          </Pill>
          <span className="font-mono text-[10.5px] text-[var(--color-text-muted)]">
            {agent.category}
          </span>
        </div>
        <p className="mt-1 line-clamp-1 text-[12px] text-[var(--color-text-muted)]">
          {agent.description}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {QUICK_INTERVALS.map((interval) => (
          <button
            key={interval.seconds}
            onClick={() =>
              void onSchedule({
                enabled: true,
                intervalSeconds: interval.seconds,
                notifyOnSuccess: true,
                notifyOnFailure: true,
                notifyOnChangeOnly: false,
              })
            }
            className="rounded-full bg-[var(--color-surface)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] transition-colors hover:bg-[var(--color-accent-soft)] hover:text-[var(--color-accent)] hover:ring-[var(--color-accent)]/30"
          >
            {interval.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScheduleMetric({
  label,
  value,
  state = "countdown",
}: {
  label: string;
  value: string;
  state?: ScheduleRunState;
}) {
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className="mt-1 flex min-h-4 items-center gap-1.5 font-mono text-[11.5px] text-[var(--color-text-soft)]">
        {state === "running" && (
          <span className="h-3 w-3 shrink-0 animate-spin rounded-full border border-[var(--color-border-strong)] border-t-[var(--color-accent)]" />
        )}
        {state === "completed" && (
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25">
            <IconCheck size={10} />
          </span>
        )}
        <span>{value}</span>
      </div>
    </div>
  );
}

type ScheduleRunState = "countdown" | "running" | "completed";

function getScheduleRunState(
  agent: AgentSummary,
  runs: RunRecord[],
  nextMs: number,
  nowMs: number,
): ScheduleRunState {
  const schedule = agent.schedule;
  const lastScheduledMs = schedule?.lastScheduledRunAt
    ? new Date(schedule.lastScheduledRunAt).getTime()
    : 0;
  const relevantRuns = runs
    .filter((run) => run.agentSlug === agent.slug)
    .sort((a, b) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime());
  const activeRun = relevantRuns.find((run) =>
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "awaiting-confirmation"
  );
  if (activeRun || nowMs >= nextMs) return "running";

  const latestScheduledRun = relevantRuns.find((run) => {
    if (run.trigger !== "schedule") return false;
    if (run.status !== "completed") return false;
    return new Date(run.queuedAt).getTime() >= lastScheduledMs - 5_000;
  });
  if (
    latestScheduledRun?.finishedAt &&
    nowMs - new Date(latestScheduledRun.finishedAt).getTime() < 30_000
  ) {
    return "completed";
  }

  return "countdown";
}

function latestScheduledRunForAgent(agent: AgentSummary, runs: RunRecord[]): RunRecord | undefined {
  return runs
    .filter((run) => run.agentSlug === agent.slug && run.trigger === "schedule")
    .sort((a, b) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime())[0];
}

function changeLabel(changeState: NonNullable<RunRecord["changeState"]>): string {
  if (changeState === "new") return "New finding";
  if (changeState === "changed") return "Changed";
  return "No change";
}

function nextRunTime(agent: AgentSummary): number {
  const schedule = agent.schedule;
  const intervalSeconds = schedule?.intervalSeconds ?? 3600;
  const anchor = schedule?.lastScheduledRunAt
    ? new Date(schedule.lastScheduledRunAt).getTime()
    : Date.now();
  return anchor + intervalSeconds * 1000;
}

function formatNextRun(targetMs: number, nowMs: number): string {
  const remainingMs = targetMs - nowMs;
  if (remainingMs <= 0) return "queueing";
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  if (remainingSeconds < 60) {
    return `${remainingSeconds}s`;
  }
  return `in ${formatInterval(remainingSeconds)}`;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.floor(ms / (60 * 60_000))}h ago`;
  return new Date(iso).toLocaleDateString();
}
