import { useEffect, useState } from "react";
import { Button } from "./Button";
import { Card } from "./Card";
import { Pill } from "./Pill";
import { IconClock, IconWarning } from "./icons";
import type { AgentSchedule } from "../shared/openAgents";

const PRESETS: { label: string; seconds: number }[] = [
  { label: "Every 15m", seconds: 15 * 60 },
  { label: "Every 1h", seconds: 60 * 60 },
  { label: "Every 4h", seconds: 4 * 60 * 60 },
  { label: "Every 12h", seconds: 12 * 60 * 60 },
  { label: "Every 24h", seconds: 24 * 60 * 60 },
];

export function AgentScheduleCard({
  schedule,
  onChange,
}: {
  schedule: AgentSchedule | undefined;
  onChange: (next: AgentSchedule | null) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = async (next: AgentSchedule | null) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enabled = schedule?.enabled === true;
  const currentSeconds = schedule?.intervalSeconds ?? 60 * 60;
  const nextFireMs = schedule?.lastScheduledRunAt
    ? new Date(schedule.lastScheduledRunAt).getTime() +
      currentSeconds * 1000
    : Date.now() + currentSeconds * 1000;

  return (
    <Card>
      <div className="p-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <IconClock size={14} className="text-[var(--color-text-muted)]" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
              Schedule
            </span>
            {enabled ? (
              <Pill tone="success">
                <span className="h-1.5 w-1.5 animate-pulse-soft rounded-full bg-current" />
                On · {formatInterval(currentSeconds)}
              </Pill>
            ) : (
              <Pill>Manual only</Pill>
            )}
          </div>
          {enabled && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void apply(null)}
            >
              Disable schedule
            </Button>
          )}
        </div>

        <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--color-text-soft)]">
          Schedules only fire while Open Agents is running. Pick an interval
          and runs queue automatically against the agent's active tenant.
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {PRESETS.map((preset) => {
            const active = enabled && preset.seconds === currentSeconds;
            return (
              <button
                key={preset.seconds}
                disabled={busy}
                onClick={() =>
                  void apply({
                    enabled: true,
                    intervalSeconds: preset.seconds,
                    ...(schedule?.lastScheduledRunAt
                      ? { lastScheduledRunAt: schedule.lastScheduledRunAt }
                      : {}),
                  })
                }
                className={`rounded-full px-3 py-1 text-[11.5px] font-medium transition-colors ${
                  active
                    ? "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/30"
                    : "bg-[var(--color-surface)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
                } ${busy ? "cursor-not-allowed opacity-60" : ""}`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {enabled && (
          <div className="mt-3 font-mono text-[11px] text-[var(--color-text-muted)]">
            Next run:{" "}
            <span className="text-[var(--color-text-soft)]">
              <NextFireCountdown targetMs={nextFireMs} />
            </span>
            {schedule?.lastScheduledRunAt && (
              <>
                {" · last fired "}
                <span className="text-[var(--color-text-soft)]">
                  {formatRelative(schedule.lastScheduledRunAt)}
                </span>
              </>
            )}
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-md bg-[var(--color-danger-soft)] px-3 py-2 ring-1 ring-[var(--color-danger)]/30">
            <IconWarning size={12} className="mt-0.5 text-[var(--color-danger)]" />
            <span className="text-[11.5px] text-[var(--color-danger)]">{error}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function NextFireCountdown({ targetMs }: { targetMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const remainingMs = targetMs - now;
  if (remainingMs <= 0) return <span>any moment now</span>;
  return <span>in {formatInterval(Math.floor(remainingMs / 1000))}</span>;
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
