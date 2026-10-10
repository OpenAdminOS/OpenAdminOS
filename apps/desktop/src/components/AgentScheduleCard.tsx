import { useEffect, useMemo, useState } from "react";
import type { AgentSchedule } from "../shared/openAdminOS";
import {
  Badge,
  Button,
  SegmentedControl,
  StatusDot,
  Switch,
} from "./ui";

const PRESETS = [
  { id: "900", label: "15m", seconds: 15 * 60 },
  { id: "3600", label: "1h", seconds: 60 * 60 },
  { id: "14400", label: "4h", seconds: 4 * 60 * 60 },
  { id: "86400", label: "24h", seconds: 24 * 60 * 60 },
] as const;

export function AgentScheduleCard({
  schedule,
  onChange,
}: {
  schedule: AgentSchedule | undefined;
  onChange: (next: AgentSchedule | null) => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customValue, setCustomValue] = useState("30");
  const [customUnit, setCustomUnit] = useState<"minutes" | "hours">("minutes");
  const enabled = schedule?.enabled === true;
  const currentSeconds = schedule?.intervalSeconds ?? 60 * 60;
  const preset = PRESETS.find((option) => option.seconds === currentSeconds);
  const selectedInterval = preset?.id ?? "custom";
  const notificationPrefs = {
    notifyOnSuccess: schedule?.notifyOnSuccess ?? true,
    notifyOnFailure: schedule?.notifyOnFailure ?? true,
    notifyOnChangeOnly: schedule?.notifyOnChangeOnly ?? false,
  };

  useEffect(() => {
    if (preset) return;
    if (currentSeconds % 3600 === 0) {
      setCustomValue(String(currentSeconds / 3600));
      setCustomUnit("hours");
    } else {
      setCustomValue(String(Math.max(1, Math.round(currentSeconds / 60))));
      setCustomUnit("minutes");
    }
  }, [currentSeconds, preset]);

  const apply = async (next: AgentSchedule | null) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const buildSchedule = (intervalSeconds: number): AgentSchedule => ({
    enabled: true,
    intervalSeconds,
    ...notificationPrefs,
    ...(schedule?.lastScheduledRunAt
      ? { lastScheduledRunAt: schedule.lastScheduledRunAt }
      : {}),
  });

  const customSeconds = useMemo(() => {
    const parsed = Number.parseInt(customValue, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return parsed * (customUnit === "hours" ? 60 * 60 : 60);
  }, [customUnit, customValue]);

  const nextFireMs = schedule?.lastScheduledRunAt
    ? new Date(schedule.lastScheduledRunAt).getTime() + currentSeconds * 1000
    : Date.now() + currentSeconds * 1000;

  return (
    <div className="space-y-4">
      <Switch
        checked={enabled}
        disabled={busy}
        label="Automatic runs"
        description={
          enabled
            ? `Runs every ${formatInterval(currentSeconds)}.`
            : "Manual only. Enabling starts one full interval from now."
        }
        onCheckedChange={(checked) =>
          void apply(checked ? buildSchedule(currentSeconds) : null)
        }
      />

      <div>
        <div className="mb-2 text-sm font-medium text-[var(--color-text)]">Interval</div>
        <SegmentedControl
          ariaLabel="Schedule interval"
          value={selectedInterval}
          onValueChange={(value) => {
            if (value === "custom") return;
            const option = PRESETS.find((candidate) => candidate.id === value);
            if (option) void apply(buildSchedule(option.seconds));
          }}
          options={[
            ...PRESETS.map(({ id, label }) => ({ id, label })),
            { id: "custom", label: "Custom" },
          ]}
          className="max-w-full flex-wrap"
        />
      </div>

      {selectedInterval === "custom" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1 text-sm text-[var(--color-text-muted)]">
            Interval
            <input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={customValue}
              disabled={busy}
              onChange={(event) => setCustomValue(event.target.value)}
              className="h-9 w-24 rounded-md bg-[var(--color-surface)] px-3 font-mono text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </label>
          <label className="grid gap-1 text-sm text-[var(--color-text-muted)]">
            Unit
            <select
              value={customUnit}
              disabled={busy}
              onChange={(event) =>
                setCustomUnit(event.target.value === "hours" ? "hours" : "minutes")
              }
              className="h-9 rounded-md bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || customSeconds < 60}
            onClick={() => void apply(buildSchedule(customSeconds))}
          >
            Apply
          </Button>
        </div>
      ) : null}

      {enabled ? (
        <div className="border-t border-[var(--color-border-soft)] pt-3">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-[var(--color-text)]">Notifications</span>
            <Badge tone="success">
              <StatusDot tone="success" /> Enabled
            </Badge>
          </div>
          <ScheduleNotificationSwitch
            label="Notify on success"
            checked={notificationPrefs.notifyOnSuccess}
            disabled={busy}
            onChange={(checked) =>
              void apply({
                ...buildSchedule(currentSeconds),
                notifyOnSuccess: checked,
              })
            }
          />
          <ScheduleNotificationSwitch
            label="Notify on failure"
            checked={notificationPrefs.notifyOnFailure}
            disabled={busy}
            onChange={(checked) =>
              void apply({
                ...buildSchedule(currentSeconds),
                notifyOnFailure: checked,
              })
            }
          />
          <ScheduleNotificationSwitch
            label="Only when findings change"
            checked={notificationPrefs.notifyOnChangeOnly}
            disabled={busy}
            onChange={(checked) =>
              void apply({
                ...buildSchedule(currentSeconds),
                notifyOnChangeOnly: checked,
              })
            }
          />
          <div className="mt-3 text-xs text-[var(--color-text-muted)]">
            Next run <NextFireCountdown targetMs={nextFireMs} />
            {schedule?.lastScheduledRunAt
              ? `, last fired ${formatRelative(schedule.lastScheduledRunAt)}`
              : ""}
          </div>
        </div>
      ) : null}

      {error ? (
        <div role="alert" className="text-sm text-[var(--color-danger)]">
          {error} Review the interval and try again.
        </div>
      ) : null}
    </div>
  );
}

function ScheduleNotificationSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Switch
      label={label}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      className="py-1.5"
    />
  );
}

function NextFireCountdown({ targetMs }: { targetMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const remainingMs = targetMs - now;
  if (remainingMs <= 0) return <span>is due</span>;
  return <span>in {formatInterval(Math.floor(remainingMs / 1000))}</span>;
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  return `${Math.floor(hours / 24)}d`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 60 * 60 * 1000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 24 * 60 * 60 * 1000) return `${Math.floor(ms / (60 * 60_000))}h ago`;
  return new Date(iso).toLocaleDateString();
}
