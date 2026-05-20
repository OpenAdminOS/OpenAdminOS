import { useMemo, useState } from "react";
import { Card } from "./Card";
import { MarkdownPreview } from "./MarkdownPreview";
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
  const isCancelled = step.status === "cancelled";
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
          {isCancelled && (
            <span className="block h-px w-2.5 bg-current" />
          )}
          {(isPending ||
            (!isCompleted && !isRunning && !isFailed && !isCancelled)) && (
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
                : isPending || isCancelled
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
      {thinking.streaming ? (
        // Mid-stream, partial markdown like "**Clus" would render
        // half-formatted; show raw text with a blinking caret instead
        // and let the markdown renderer take over once streaming ends.
        <div className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
          {thinking.text}
          <span className="ml-1 inline-block h-3.5 w-1.5 -translate-y-px animate-pulse-soft bg-[var(--color-think)]" />
        </div>
      ) : (
        <MarkdownPreview
          source={thinking.text}
          className="text-[12.5px] leading-relaxed text-[var(--color-text-soft)]"
        />
      )}
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
  const [expanded, setExpanded] = useState(false);
  const graphCall = extractGraphCall(log.metadata);
  const hasExpandableDetail =
    graphCall !== undefined ||
    (log.metadata !== undefined && Object.keys(log.metadata).length > 0);

  return (
    <div className="group rounded-md bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)]">
      <div className="relative grid grid-cols-[68px_50px_1fr_auto] items-start gap-3 px-3 py-2">
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
        <div className="flex items-center gap-1">
          {hasExpandableDetail && (
            <button
              onClick={() => setExpanded((current) => !current)}
              title={expanded ? "Hide details" : "Show details"}
              aria-label={expanded ? "Hide log details" : "Show log details"}
              aria-expanded={expanded}
              className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
            >
              <span
                className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}
              >
                <Chevron />
              </span>
            </button>
          )}
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
      </div>
      {expanded && hasExpandableDetail && (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-2.5">
          {graphCall ? (
            <GraphCallDetails call={graphCall} />
          ) : (
            <pre className="overflow-auto rounded bg-[var(--color-surface)] p-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
              {safeJson(log.metadata)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path
        d="M3.5 2L6.5 5L3.5 8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type GraphCallMetadata = {
  phase?: "start" | "end";
  method?: string;
  path?: string;
  query?: Record<string, string>;
  ok?: boolean;
  status?: number | string;
  durationMs?: number;
  attempts?: number;
  bytes?: number;
  itemCount?: number;
  shape?: string;
  sample?: unknown;
  sampleTruncated?: boolean;
  errorBody?: string;
  error?: string;
};

function extractGraphCall(
  metadata: Record<string, unknown> | undefined,
): GraphCallMetadata | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as { graphCall?: unknown }).graphCall;
  if (!value || typeof value !== "object") return undefined;
  return value as GraphCallMetadata;
}

function GraphCallDetails({ call }: { call: GraphCallMetadata }) {
  const queryEntries = call.query ? Object.entries(call.query) : [];
  return (
    <div className="flex flex-col gap-2.5 text-[11px] text-[var(--color-text-soft)]">
      <div className="flex flex-wrap items-center gap-1.5">
        {call.method && (
          <span
            className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[9.5px] font-medium uppercase ring-1 ${methodChipClass(call.method)}`}
          >
            {call.method}
          </span>
        )}
        {call.path && (
          <span className="font-mono text-[11px] text-[var(--color-text)]">
            {call.path}
          </span>
        )}
        {call.status !== undefined && (
          <span
            className={`ml-auto inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[9.5px] ring-1 ${statusChipClass(call.ok, call.status)}`}
          >
            {String(call.status)}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[10.5px] text-[var(--color-text-muted)]">
        {call.durationMs !== undefined && (
          <>
            <dt>duration</dt>
            <dd className="text-[var(--color-text-soft)] tabular-nums">
              {formatDurationMs(call.durationMs)}
            </dd>
          </>
        )}
        {call.attempts !== undefined && call.attempts > 1 && (
          <>
            <dt>attempts</dt>
            <dd className="text-[var(--color-text-soft)] tabular-nums">{call.attempts}</dd>
          </>
        )}
        {call.bytes !== undefined && (
          <>
            <dt>bytes</dt>
            <dd className="text-[var(--color-text-soft)] tabular-nums">
              {formatBytes(call.bytes)}
            </dd>
          </>
        )}
        {call.itemCount !== undefined && (
          <>
            <dt>items</dt>
            <dd className="text-[var(--color-text-soft)] tabular-nums">{call.itemCount}</dd>
          </>
        )}
        {queryEntries.length > 0 && (
          <>
            <dt className="self-start">query</dt>
            <dd className="text-[var(--color-text-soft)]">
              <div className="flex flex-col gap-0.5">
                {queryEntries.map(([key, value]) => (
                  <div key={key} className="break-all">
                    <span className="text-[var(--color-text-muted)]">{key}=</span>
                    {value}
                  </div>
                ))}
              </div>
            </dd>
          </>
        )}
      </dl>
      {call.shape && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            shape
          </div>
          <pre className="overflow-auto rounded bg-[var(--color-surface)] p-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            {call.shape}
          </pre>
        </div>
      )}
      {call.sample !== undefined && (
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <span>response sample</span>
            {(call.sampleTruncated ||
              (typeof call.itemCount === "number" &&
                Array.isArray(call.sample) &&
                call.itemCount > call.sample.length)) && (
              <span className="font-mono normal-case tracking-normal text-[var(--color-text-muted)]">
                {Array.isArray(call.sample) && typeof call.itemCount === "number"
                  ? `showing ${call.sample.length} of ${call.itemCount}`
                  : "truncated"}
              </span>
            )}
          </div>
          <pre className="max-h-[260px] overflow-auto rounded bg-[var(--color-surface)] p-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            {safeJson(call.sample)}
          </pre>
        </div>
      )}
      {call.errorBody && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--color-danger)]">
            error response
          </div>
          <pre className="overflow-auto rounded bg-[var(--color-danger-soft)] p-2 font-mono text-[10.5px] leading-relaxed text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
            {call.errorBody}
          </pre>
        </div>
      )}
      {call.error && !call.errorBody && (
        <div className="rounded bg-[var(--color-danger-soft)] p-2 font-mono text-[10.5px] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/30">
          {call.error}
        </div>
      )}
    </div>
  );
}

function methodChipClass(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "bg-[var(--color-info-soft)] text-[var(--color-info)] ring-[var(--color-info)]/30";
    case "POST":
      return "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/30";
    case "PATCH":
    case "PUT":
      return "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning)]/30";
    case "DELETE":
      return "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/30";
    default:
      return "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-[var(--color-border-soft)]";
  }
}

function statusChipClass(ok: boolean | undefined, status: number | string): string {
  if (ok === false) {
    return "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/30";
  }
  if (typeof status === "number" && status >= 200 && status < 300) {
    return "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/30";
  }
  return "bg-[var(--color-bg-raised)] text-[var(--color-text-soft)] ring-[var(--color-border-soft)]";
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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
