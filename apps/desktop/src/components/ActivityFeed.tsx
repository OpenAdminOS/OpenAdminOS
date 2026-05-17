import { useMemo, useState } from "react";
import { Card } from "./Card";
import {
  IconActivity,
  IconBolt,
  IconCheck,
  IconCopy,
  IconSparkle,
  IconWarning,
} from "./icons";
import type {
  RunLogLevel,
  RunLogRecord,
  RunRecord,
  RunStepRecord,
} from "../shared/openAgents";

type Tab = "pipeline" | "logs" | "reasoning";

export function ActivityFeed({ run }: { run: RunRecord }) {
  const reasoningSteps = useMemo(
    () => run.steps.filter((step) => step.thinking && step.thinking.text.length > 0),
    [run.steps],
  );

  const [tab, setTab] = useState<Tab>("pipeline");

  return (
    <Card className="mb-6">
      <div className="flex items-center gap-1 border-b border-[var(--color-border-soft)] px-3 py-1">
        <TabButton
          active={tab === "pipeline"}
          onClick={() => setTab("pipeline")}
          label="Pipeline"
          count={run.steps.length}
          icon={<IconActivity size={12} />}
        />
        <TabButton
          active={tab === "logs"}
          onClick={() => setTab("logs")}
          label="Logs"
          count={run.logs.length}
          icon={<IconBolt size={12} />}
        />
        <TabButton
          active={tab === "reasoning"}
          onClick={() => setTab("reasoning")}
          label="Reasoning"
          count={reasoningSteps.length}
          icon={<IconSparkle size={12} />}
        />
      </div>
      <div className="p-6">
        {tab === "pipeline" && <PipelineView steps={run.steps} />}
        {tab === "logs" && <LogsView logs={run.logs} />}
        {tab === "reasoning" && <ReasoningView steps={reasoningSteps} />}
      </div>
    </Card>
  );
}

function TabButton({
  active,
  onClick,
  label,
  count,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
        active
          ? "bg-[var(--color-surface-hover)] text-[var(--color-text)]"
          : "text-[var(--color-text-soft)] hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
      }`}
    >
      <span
        className={
          active ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"
        }
      >
        {icon}
      </span>
      <span>{label}</span>
      <span
        className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] tabular-nums ${
          active
            ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
            : "bg-[var(--color-bg-raised)] text-[var(--color-text-muted)]"
        }`}
      >
        {count}
      </span>
    </button>
  );
}

// ─── Pipeline tab ────────────────────────────────────────────────────────

function PipelineView({ steps }: { steps: RunStepRecord[] }) {
  if (steps.length === 0) {
    return (
      <div className="py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">
        No steps recorded yet.
      </div>
    );
  }
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => (
        <PipelineRow
          key={step.id}
          step={step}
          isLast={index === steps.length - 1}
        />
      ))}
    </ol>
  );
}

function PipelineRow({ step, isLast }: { step: RunStepRecord; isLast: boolean }) {
  const isRunning = step.status === "running";
  const isCompleted = step.status === "completed";
  const isFailed = step.status === "failed";
  const isPending = step.status === "pending";
  const duration = stepDuration(step);

  return (
    <li className="relative grid grid-cols-[24px_1fr_auto] gap-3 pb-6 last:pb-0">
      <div className="relative flex flex-col items-center">
        <span
          className={`relative z-10 flex h-6 w-6 items-center justify-center rounded-full ring-1 ${
            isCompleted
              ? "bg-[var(--color-success-soft)] ring-[var(--color-success)]/40 text-[var(--color-success)]"
              : isRunning
                ? "bg-[var(--color-warning-soft)] ring-[var(--color-warning)]/40 text-[var(--color-warning)]"
                : isFailed
                  ? "bg-[var(--color-danger-soft)] ring-[var(--color-danger)]/40 text-[var(--color-danger)]"
                  : "bg-[var(--color-surface)] ring-[var(--color-border)] text-[var(--color-text-muted)]"
          }`}
        >
          {isCompleted && <IconCheck size={11} />}
          {isFailed && <IconWarning size={11} />}
          {isRunning && (
            <span className="absolute inset-0 rounded-full border-2 border-transparent border-t-[var(--color-warning)] animate-spin" />
          )}
          {(isPending || (!isCompleted && !isRunning && !isFailed)) && (
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
          )}
        </span>
        {!isLast && (
          <span className="absolute top-6 bottom-0 w-px bg-[var(--color-border-soft)]" />
        )}
      </div>

      <div className="min-w-0">
        <div
          className={`text-[13.5px] font-medium ${
            isRunning
              ? "text-[var(--color-warning)]"
              : isFailed
                ? "text-[var(--color-danger)]"
                : isPending
                  ? "text-[var(--color-text-muted)]"
                  : "text-[var(--color-text)]"
          }`}
        >
          {step.label}
        </div>
        {step.detail && (
          <div className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-text-muted)]">
            {step.detail}
          </div>
        )}
        {step.thinking && step.thinking.text.length > 0 && (
          <ThinkingBlock thinking={step.thinking} />
        )}
      </div>

      <div className="shrink-0 self-start text-right font-mono text-[10.5px] text-[var(--color-text-muted)] tabular-nums">
        {duration ?? "—"}
      </div>
    </li>
  );
}

function ThinkingBlock({
  thinking,
}: {
  thinking: NonNullable<RunStepRecord["thinking"]>;
}) {
  return (
    <div className="mt-3 rounded-md bg-[var(--color-think-soft)] p-3 ring-1 ring-[var(--color-think)]/25">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-think)]">
          Reasoning
        </span>
        <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
          {thinking.model}
        </span>
        {thinking.streaming && (
          <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
            <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-[var(--color-think)]" />
            streaming
          </span>
        )}
      </div>
      <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
        {thinking.text}
        {thinking.streaming && (
          <span className="ml-1 inline-block h-3.5 w-1.5 -translate-y-px animate-pulse-soft bg-[var(--color-think)]" />
        )}
      </div>
    </div>
  );
}

function stepDuration(step: RunStepRecord): string | undefined {
  if (!step.startedAt) return undefined;
  const end = step.finishedAt
    ? new Date(step.finishedAt).getTime()
    : Date.now();
  const ms = end - new Date(step.startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ─── Logs tab ────────────────────────────────────────────────────────────

const LOG_LEVELS: RunLogLevel[] = ["error", "warn", "info", "debug"];

function LogsView({ logs }: { logs: RunLogRecord[] }) {
  const [enabled, setEnabled] = useState<ReadonlySet<RunLogLevel>>(
    new Set(LOG_LEVELS),
  );

  const counts = useMemo(() => {
    const acc: Record<RunLogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const log of logs) acc[log.level] += 1;
    return acc;
  }, [logs]);

  const visible = logs.filter((log) => enabled.has(log.level));

  if (logs.length === 0) {
    return (
      <div className="py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">
        No logs recorded yet.
      </div>
    );
  }

  const toggle = (level: RunLogLevel) => {
    setEnabled((current) => {
      const next = new Set(current);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      // Always keep at least one enabled.
      return next.size === 0 ? new Set(LOG_LEVELS) : next;
    });
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {LOG_LEVELS.map((level) => (
          <button
            key={level}
            onClick={() => toggle(level)}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors ${
              enabled.has(level)
                ? logLevelChipClass(level)
                : "bg-[var(--color-surface)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]"
            }`}
          >
            <span>{level}</span>
            <span className="font-mono text-[10px] tabular-nums opacity-70">
              {counts[level]}
            </span>
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <div className="py-4 text-center text-[12.5px] text-[var(--color-text-muted)]">
          No logs match the selected levels.
        </div>
      ) : (
        <div className="flex max-h-[420px] flex-col gap-1.5 overflow-auto">
          {visible.map((log) => (
            <LogRow key={log.id} log={log} />
          ))}
        </div>
      )}
    </div>
  );
}

function logLevelChipClass(level: RunLogLevel): string {
  switch (level) {
    case "error":
      return "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30";
    case "warn":
      return "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/30";
    case "info":
      return "bg-[var(--color-info-soft)] text-[var(--color-info)] ring-1 ring-[var(--color-info)]/30";
    case "debug":
      return "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]";
  }
}

function LogRow({ log }: { log: RunLogRecord }) {
  return (
    <div className="group relative grid grid-cols-[68px_50px_1fr_auto] items-start gap-3 rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
      <span className="font-mono text-[10.5px] text-[var(--color-text-muted)] tabular-nums">
        {formatLogTime(log.timestamp)}
      </span>
      <span
        className={`inline-flex items-center justify-center rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase ${logLevelChipClass(log.level)}`}
      >
        {log.level}
      </span>
      <span className="font-mono text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
        {log.message}
      </span>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(
            `${log.timestamp} ${log.level.toUpperCase()} ${log.message}`,
          );
        }}
        title="Copy log line"
        aria-label="Copy log line"
        className="rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-surface)] hover:text-[var(--color-text)] group-hover:opacity-100"
      >
        <IconCopy size={11} />
      </button>
    </div>
  );
}

function formatLogTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ─── Reasoning tab ───────────────────────────────────────────────────────

function ReasoningView({ steps }: { steps: RunStepRecord[] }) {
  if (steps.length === 0) {
    return (
      <div className="py-6 text-center text-[12.5px] text-[var(--color-text-muted)]">
        No LLM reasoning recorded for this run.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {steps.map((step) => (
        <div key={step.id}>
          <div className="mb-2 flex items-center gap-2 text-[11.5px] text-[var(--color-text-muted)]">
            <span className="font-medium text-[var(--color-text-soft)]">
              {step.label}
            </span>
            {step.thinking && (
              <>
                <span className="opacity-50">·</span>
                <span className="font-mono">{step.thinking.model}</span>
              </>
            )}
          </div>
          {step.thinking && <ThinkingBlock thinking={step.thinking} />}
        </div>
      ))}
    </div>
  );
}
