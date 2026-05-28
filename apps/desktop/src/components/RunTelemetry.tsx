import type { RunRecord } from "../shared/openAdminOS";

export function RunTelemetry({
  run,
  nowMs,
  isLive,
  providerIsLocal,
  providerName,
}: {
  run: RunRecord;
  nowMs: number;
  isLive: boolean;
  providerIsLocal?: boolean;
  providerName?: string;
}) {
  const completedSteps = run.steps.filter((step) => step.status === "completed").length;
  const failedSteps = run.steps.filter((step) => step.status === "failed").length;
  const totalSteps = run.steps.length;
  const stepLabel = totalSteps > 0 ? `${completedSteps}/${totalSteps}` : "—";
  const stepCaption =
    totalSteps === 0
      ? "no steps yet"
      : failedSteps > 0
        ? `${failedSteps} failed`
        : completedSteps === totalSteps
          ? "all complete"
          : isLive
            ? "in progress"
            : "incomplete";

  const elapsed = formatElapsed(run, nowMs);
  const tokens = run.tokens?.totalTokens
    ?? ((run.tokens?.promptTokens ?? 0) + (run.tokens?.completionTokens ?? 0));
  const tokensLabel = tokens && tokens > 0 ? tokens.toLocaleString() : "—";
  const tokensCaption = run.tokens
    ? `${run.tokens.promptTokens?.toLocaleString() ?? "0"} prompt · ${run.tokens.completionTokens?.toLocaleString() ?? "0"} out`
    : "no llm calls yet";

  return (
    <div className="grid grid-cols-2 gap-px border-b border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-4 lg:grid-cols-5">
      <TelemetryCell
        label="Elapsed"
        value={elapsed}
        valueClass={isLive ? "text-[var(--color-accent)]" : undefined}
        accent={isLive}
      />
      <TelemetryCell label="Steps" value={stepLabel} caption={stepCaption} />
      <TelemetryCell
        label="Tokens"
        value={tokensLabel}
        caption={tokensCaption}
      />
      <TelemetryCell label="Model" value={run.model ?? "—"} mono />
      <TelemetryCell
        label="Cost"
        value="—"
        caption={providerIsLocal ? "local · not billed" : `hosted · ${providerName ?? "provider"}`}
      />
    </div>
  );
}

function TelemetryCell({
  label,
  value,
  caption,
  valueClass,
  accent = false,
  mono = false,
}: {
  label: string;
  value: string;
  caption?: string;
  valueClass?: string;
  accent?: boolean;
  mono?: boolean;
}) {
  return (
    <div className="bg-[var(--color-bg)] px-5 py-2.5">
      <div className="text-[9.5px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-0.5 text-[14px] font-medium tabular-nums ${mono ? "font-mono text-[12.5px]" : ""} ${valueClass ?? "text-[var(--color-text)]"}`}
      >
        {value}
        {accent && (
          <span className="ml-2 inline-block h-1 w-12 align-middle">
            <span className="block h-full w-full overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
              <span className="block h-full w-1/3 animate-pulse-soft rounded-full bg-[var(--color-accent)]" />
            </span>
          </span>
        )}
      </div>
      {caption && (
        <div className="mt-0.5 truncate text-[10.5px] text-[var(--color-text-muted)]">
          {caption}
        </div>
      )}
    </div>
  );
}

function formatElapsed(run: RunRecord, nowMs: number): string {
  if (run.status === "queued") return "queued";
  if (run.status === "awaiting-confirmation") return "paused";
  if (!run.startedAt) return "—";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : nowMs;
  const ms = end - new Date(run.startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${mins}m ${remainder.toString().padStart(2, "0")}s`;
}
