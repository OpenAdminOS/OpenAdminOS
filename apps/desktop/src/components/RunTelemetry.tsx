import type { RunRecord } from "../shared/openAdminOS";
import { KeyValue } from "./ui";

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
  const skippedSteps = run.steps.filter((step) => step.status === "skipped").length;
  const totalSteps = run.steps.length;
  const settledSteps = completedSteps + skippedSteps;
  const stepLabel = totalSteps > 0 ? `${settledSteps}/${totalSteps}` : "Not started";
  const stepCaption =
    totalSteps === 0
      ? "no steps yet"
      : failedSteps > 0
        ? `${failedSteps} failed`
        : skippedSteps > 0 && settledSteps === totalSteps
          ? `${skippedSteps} skipped`
          : settledSteps === totalSteps
          ? "all complete"
          : isLive
            ? "in progress"
            : "incomplete";

  const elapsed = formatElapsed(run, nowMs);
  const tokens = run.tokens?.totalTokens
    ?? ((run.tokens?.promptTokens ?? 0) + (run.tokens?.completionTokens ?? 0));
  const tokensLabel = tokens && tokens > 0 ? tokens.toLocaleString() : "Not recorded";
  const tokensCaption = run.tokens
    ? `${run.tokens.promptTokens?.toLocaleString() ?? "0"} prompt · ${run.tokens.completionTokens?.toLocaleString() ?? "0"} out`
    : "no llm calls yet";

  return (
    <div className="grid grid-cols-2 gap-px border-b border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-5">
      <TelemetryCell
        label="Elapsed"
        value={elapsed}
        valueClass={isLive ? "text-[var(--color-info)]" : undefined}
        accent={isLive}
      />
      <TelemetryCell label="Steps" value={stepLabel} caption={stepCaption} />
      <TelemetryCell
        label="Tokens"
        value={tokensLabel}
        caption={tokensCaption}
      />
      <TelemetryCell label="Model" value={run.model ?? "Not recorded"} mono />
      <TelemetryCell
        label="Cost"
        value="Not recorded"
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
      <div className="text-xs font-medium text-[var(--color-text-muted)]">
        {label}
      </div>
      <div
        className={`mt-0.5 text-base font-medium tabular-nums ${mono ? "font-mono text-sm" : ""} ${valueClass ?? "text-[var(--color-text)]"}`}
      >
        {value}
        {accent && (
          <span className="ml-2 inline-block h-1 w-12 align-middle">
            <span className="block h-full w-full overflow-hidden rounded-full bg-[var(--color-bg-raised)]">
              <span className="block h-full w-1/3 animate-pulse-soft rounded-full bg-[var(--color-info)]" />
            </span>
          </span>
        )}
      </div>
      {caption && (
        <div className="mt-0.5 truncate text-xs text-[var(--color-text-muted)]">
          {caption}
        </div>
      )}
    </div>
  );
}

export function CompactRunTelemetry({
  run,
  providerIsLocal,
  providerName,
}: {
  run: RunRecord;
  providerIsLocal?: boolean;
  providerName?: string;
}) {
  const completedSteps = run.steps.filter(
    (step) => step.status === "completed" || step.status === "skipped",
  ).length;
  const tokens =
    run.tokens?.totalTokens ??
    ((run.tokens?.promptTokens ?? 0) + (run.tokens?.completionTokens ?? 0));
  return (
    <section aria-labelledby="run-telemetry-title">
      <h3
        id="run-telemetry-title"
        className="border-b border-[var(--color-border-soft)] pb-2 text-base font-semibold text-[var(--color-text)]"
      >
        Telemetry
      </h3>
      <dl className="divide-y divide-[var(--color-border-soft)]">
        <KeyValue label="Duration" value={<span className="tabular-nums">{formatElapsed(run, Date.now())}</span>} />
        <KeyValue label="Steps" value={`${completedSteps} of ${run.steps.length}`} />
        <KeyValue label="Tokens" value={tokens > 0 ? tokens.toLocaleString() : "Not recorded"} />
        <KeyValue
          label="Provider"
          value={providerName ?? run.providerId ?? "Not recorded"}
        />
        <KeyValue
          label="Model"
          value={<span className="font-mono text-sm">{run.model ?? "Not recorded"}</span>}
        />
        <KeyValue
          label="Cost"
          value={providerIsLocal ? "Local, not billed" : "Hosted, not recorded"}
        />
      </dl>
    </section>
  );
}

function formatElapsed(run: RunRecord, nowMs: number): string {
  if (run.status === "queued") return "queued";
  if (run.status === "awaiting-confirmation") return "paused";
  if (!run.startedAt) return "Not started";
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : nowMs;
  const ms = end - new Date(run.startedAt).getTime();
  if (Number.isNaN(ms) || ms < 0) return "Not recorded";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${mins}m ${remainder.toString().padStart(2, "0")}s`;
}
