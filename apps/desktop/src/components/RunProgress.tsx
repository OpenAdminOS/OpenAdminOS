import { useEffect, useState, type ReactNode } from "react";
import type { RunRecord, RunStatus, RunStepRecord } from "../shared/openAdminOS";
import { IconCheck, IconWarning } from "./icons";

/**
 * Segmented progress bar for a run: one segment per pipeline step, so
 * the bar doubles as a compact picture of the pipeline once the run
 * has settled. Runs without steps get an indeterminate bar while live.
 */
export function RunProgressBar({ run }: { run: RunRecord }) {
  const live = run.status === "queued" || run.status === "running";
  const steps = run.steps;
  const settled = steps.filter(
    (step) => step.status === "completed" || step.status === "skipped",
  ).length;

  if (steps.length === 0) {
    return (
      <div
        role="progressbar"
        aria-label="Run progress"
        aria-busy={live || undefined}
        className="relative h-1.5 overflow-hidden rounded-full bg-[var(--color-border)]"
      >
        {live ? (
          <span className="run-progress-indeterminate" />
        ) : (
          <span className={`absolute inset-0 rounded-full ${terminalFill(run.status)}`} />
        )}
      </div>
    );
  }

  return (
    <div
      role="progressbar"
      aria-label="Run progress"
      aria-valuemin={0}
      aria-valuemax={steps.length}
      aria-valuenow={settled}
      aria-valuetext={`${settled} of ${steps.length} steps finished`}
      className="flex h-1.5 gap-1"
    >
      {steps.map((step) => (
        <span
          key={step.id}
          title={step.label}
          className={`relative h-full min-w-[6px] flex-1 overflow-hidden rounded-full transition-colors duration-500 ${segmentFill(step.status)}`}
        >
          {step.status === "running" ? <span className="run-progress-sweep" /> : null}
        </span>
      ))}
    </div>
  );
}

function segmentFill(status: RunStepRecord["status"]): string {
  switch (status) {
    case "completed":
      return "bg-[var(--color-success)]/80";
    case "running":
      return "bg-[var(--color-info)]/25";
    case "failed":
      return "bg-[var(--color-danger)]";
    case "skipped":
    case "cancelled":
      return "bg-[var(--color-border-strong)]";
    default:
      return "bg-[var(--color-border)]";
  }
}

function terminalFill(status: RunStatus): string {
  if (status === "completed") return "bg-[var(--color-success)]/80";
  if (status === "failed") return "bg-[var(--color-danger)]";
  if (status === "awaiting-confirmation") return "bg-[var(--color-warning)]/70";
  return "bg-[var(--color-border-strong)]";
}

/**
 * Vertical step timeline. The running step is highlighted and shows
 * the tail of the model's reasoning as it streams, so a live run reads
 * as progress rather than a spinner.
 */
export function RunStepTimeline({
  steps,
  live,
}: {
  steps: RunStepRecord[];
  /** Ticks running-step durations; the clock stops once the run settles. */
  live: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNowMs(Date.now());
    const interval = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [live]);
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => (
        <TimelineRow
          key={step.id}
          step={step}
          index={index}
          isLast={index === steps.length - 1}
          nowMs={nowMs}
        />
      ))}
    </ol>
  );
}

function TimelineRow({
  step,
  index,
  isLast,
  nowMs,
}: {
  step: RunStepRecord;
  index: number;
  isLast: boolean;
  nowMs: number;
}) {
  const running = step.status === "running";
  const failed = step.status === "failed";
  const completed = step.status === "completed";
  const dim = step.status === "pending" || step.status === "skipped" || step.status === "cancelled";
  const duration = formatStepDuration(step, nowMs);
  const thinkingTail = running && step.thinking?.text ? tail(step.thinking.text, 260) : null;

  return (
    <li className="relative grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3">
      <div className="relative flex justify-center">
        <StepMarker status={step.status} index={index} />
        {!isLast ? (
          <span
            aria-hidden="true"
            className={`absolute top-[26px] bottom-0 w-px ${
              completed ? "bg-[var(--color-success)]/35" : "bg-[var(--color-border)]"
            }`}
          />
        ) : null}
      </div>
      <div
        className={`mb-2 min-w-0 rounded-lg px-3 py-2 transition-colors ${
          running
            ? "bg-[var(--color-info-soft)]"
            : failed
              ? "bg-[var(--color-danger-soft)]"
              : ""
        }`}
      >
        <div
          className={`text-base font-medium leading-snug ${
            failed
              ? "text-[var(--color-danger)]"
              : dim
                ? "text-[var(--color-text-muted)]"
                : "text-[var(--color-text)]"
          }`}
        >
          {step.label}
        </div>
        {step.detail ? (
          <div className="mt-0.5 text-sm leading-relaxed text-[var(--color-text-muted)]">
            {step.detail}
          </div>
        ) : null}
        {thinkingTail ? (
          <div className="mt-2 border-l-2 border-[var(--color-think)]/50 pl-2.5 text-sm italic leading-relaxed text-[var(--color-text-soft)]">
            {thinkingTail}
          </div>
        ) : null}
      </div>
      <div
        className={`pt-2 text-right font-mono text-xs tabular-nums ${
          running ? "text-[var(--color-info)]" : "text-[var(--color-text-muted)]"
        }`}
      >
        {duration ?? (step.status === "pending" ? "waiting" : "")}
      </div>
    </li>
  );
}

function StepMarker({ status, index }: { status: RunStepRecord["status"]; index: number }) {
  let content: ReactNode;
  let className: string;
  switch (status) {
    case "completed":
      className = "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/40";
      content = <IconCheck size={11} aria-hidden="true" />;
      break;
    case "failed":
      className = "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/45";
      content = <IconWarning size={11} aria-hidden="true" />;
      break;
    case "running":
      className = "run-live-ring bg-[var(--color-surface)] text-[var(--color-info)] ring-[var(--color-info)]/60";
      content = (
        <span
          aria-hidden="true"
          className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-[var(--color-info)]/25 border-t-[var(--color-info)]"
        />
      );
      break;
    case "skipped":
    case "cancelled":
      className = "bg-[var(--color-surface)] text-[var(--color-text-muted)] ring-[var(--color-border)]";
      content = <span aria-hidden="true" className="block h-px w-2.5 bg-current" />;
      break;
    default:
      className = "bg-[var(--color-surface)] text-[var(--color-text-muted)] ring-[var(--color-border)]";
      content = (
        <span aria-hidden="true" className="font-mono text-[10px] tabular-nums">
          {index + 1}
        </span>
      );
  }
  return (
    <span
      className={`relative z-10 mt-1.5 flex h-[22px] w-[22px] items-center justify-center rounded-full ring-1 ${className}`}
    >
      {content}
      <span className="sr-only">{stepStatusLabel(status)}</span>
    </span>
  );
}

function stepStatusLabel(status: RunStepRecord["status"]): string {
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "running") return "Running";
  if (status === "skipped") return "Skipped";
  if (status === "cancelled") return "Cancelled";
  return "Waiting";
}

function tail(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(-max);
  const firstSpace = cut.indexOf(" ");
  return `…${firstSpace > 0 ? cut.slice(firstSpace + 1) : cut}`;
}

export function formatStepDuration(step: RunStepRecord, nowMs: number): string | undefined {
  if (!step.startedAt) return undefined;
  const end = step.finishedAt ? new Date(step.finishedAt).getTime() : nowMs;
  return formatMs(end - new Date(step.startedAt).getTime());
}

function formatMs(ms: number): string | undefined {
  if (Number.isNaN(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${mins}m ${remainder.toString().padStart(2, "0")}s`;
}
