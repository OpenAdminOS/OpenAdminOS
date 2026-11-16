import { useEffect, useId, useMemo, useState } from "react";
import type { AgentSchedule, AgentSummary } from "../shared/openAdminOS";
import { ScheduleUsageForecast } from "./ScheduleUsageForecast";
import {
  Badge,
  Button,
  SegmentedControl,
  StatusDot,
  Switch,
} from "./ui";
import { SchedulesPausedNotice } from "./SchedulesPausedNotice";
import { useAppState } from "../state";
import { SCHEDULE_ORGANIZATION_COPY, userFacingErrorReason } from "../copy";
import { resolveOrganizations } from "../shared/openAdminOS";
import { useToast } from "./Toast";
import { alsoRunsOnFor, currentTargetFor, uncertainFor } from "@openadminos/enterprise/ui";
import { EnterpriseNotice, invokeUiAction, ModuleUiBoundary } from "./EnterpriseUi";
import { useEnterpriseStatus } from "./useEnterpriseStatus";
import type { EnterpriseScheduleTargetView, EnterpriseUiNoticeView, SchedulePlacementsView } from "@openadminos/agent-sdk";
import { Modal, ModalHeader } from "./Modal";

const PRESETS = [
  { id: "900", label: "15m", seconds: 15 * 60 },
  { id: "3600", label: "1h", seconds: 60 * 60 },
  { id: "14400", label: "4h", seconds: 4 * 60 * 60 },
  { id: "86400", label: "24h", seconds: 24 * 60 * 60 },
] as const;

export function AgentScheduleCard({
  agent,
  onChange,
}: {
  agent: AgentSummary;
  onChange: (next: AgentSchedule | null) => Promise<void> | void;
}) {
  const schedule = agent.schedule;
  const where = useScheduleTarget(agent);
  // While the schedule runs elsewhere, this card does not run or change it here.
  const elsewhere = where && where.current !== "this-computer" ? where.currentLabel : undefined;
  // While a move runs, nothing here changes the schedule: the main process is moving it.
  const [moving, setMoving] = useState(false);
  const locked = elsewhere !== undefined || moving;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customValue, setCustomValue] = useState("30");
  const [customUnit, setCustomUnit] = useState<"minutes" | "hours">("minutes");
  const enabled = schedule?.enabled === true;
  const currentSeconds = schedule?.intervalSeconds ?? 60 * 60;
  const preset = PRESETS.find((option) => option.seconds === currentSeconds);
  const [selectedInterval, setSelectedInterval] = useState<string>(preset?.id ?? "custom");
  const notificationPrefs = {
    notifyOnSuccess: schedule?.notifyOnSuccess ?? true,
    notifyOnFailure: schedule?.notifyOnFailure ?? true,
    notifyOnChangeOnly: schedule?.notifyOnChangeOnly ?? false,
  };

  useEffect(() => {
    setSelectedInterval(preset?.id ?? "custom");
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
    const parsed = Number(customValue);
    const seconds = parsed * (customUnit === "hours" ? 60 * 60 : 60);
    return Number.isSafeInteger(parsed) && parsed > 0 && Number.isSafeInteger(seconds) ? seconds : 0;
  }, [customUnit, customValue]);
  const draftSeconds = selectedInterval === "custom" ? customSeconds : Number(selectedInterval);

  const nextFireMs = schedule?.lastScheduledRunAt
    ? new Date(schedule.lastScheduledRunAt).getTime() + currentSeconds * 1000
    : Date.now() + currentSeconds * 1000;

  return (
    <div className="space-y-4">
      <SchedulesPausedNotice />
      {schedule ? <ScheduleOrganizationRow agent={agent} /> : null}
      <LastKnownPlacement agent={agent} live={where !== undefined} />
      {where ? (
        <ModuleUiBoundary resetKey={JSON.stringify([where.targets, where.current])}>
          {/* The move and the schedule here change in the main process; this draws what they report. */}
          <ScheduleTargetRow
            agent={agent}
            where={where}
            // The saved interval when a schedule exists here, not an unsaved draft.
            intervalSeconds={schedule?.intervalSeconds ?? draftSeconds}
            hasSchedule={schedule !== undefined}
            onMoving={setMoving}
          />
        </ModuleUiBoundary>
      ) : null}
      {elsewhere && enabled && schedule ? (
        <div role="alert" className="rounded-[10px] bg-[var(--color-danger-soft)] px-3 py-2.5 text-sm text-[var(--color-danger)]">
          <p className="font-medium">{SCHEDULE_TARGET_COPY.bothTitle(elsewhere)}</p>
          <p className="mt-0.5 text-[var(--color-text-soft)]">{SCHEDULE_TARGET_COPY.bothMessage}</p>
          <Button size="sm" variant="danger" className="mt-2" disabled={busy || moving} onClick={() => void apply({ ...schedule, enabled: false })}>
            {SCHEDULE_TARGET_COPY.turnOffHere}
          </Button>
        </div>
      ) : null}
      <Switch
        checked={enabled}
        disabled={busy || locked || (!enabled && draftSeconds < 60)}
        label="Automatic runs"
        description={
          elsewhere
            ? SCHEDULE_TARGET_COPY.runsElsewhere(elsewhere)
            : enabled
              ? `Runs every ${formatInterval(currentSeconds)}.`
              : "Manual only. Enabling starts one full interval from now."
        }
        onCheckedChange={(checked) =>
          void apply(checked ? buildSchedule(draftSeconds) : null)
        }
      />

      <div>
        <div className="mb-2 text-sm font-medium text-[var(--color-text)]">Interval</div>
        <SegmentedControl
          ariaLabel="Schedule interval"
          value={selectedInterval}
          onValueChange={setSelectedInterval}
          options={[
            ...PRESETS.map(({ id, label }) => ({ id, label, disabled: busy || locked })),
            { id: "custom", label: "Custom", disabled: busy || locked },
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
              name="schedule-interval"
              autoComplete="off"
              min={1}
              step={1}
              inputMode="numeric"
              value={customValue}
              disabled={busy || locked}
              onChange={(event) => setCustomValue(event.target.value)}
              className="h-9 w-24 rounded-md bg-[var(--color-surface)] px-3 text-base tabular-nums text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </label>
          <label className="grid gap-1 text-sm text-[var(--color-text-muted)]">
            Unit
            <select
              name="schedule-interval-unit"
              value={customUnit}
              disabled={busy || locked}
              onChange={(event) =>
                setCustomUnit(event.target.value === "hours" ? "hours" : "minutes")
              }
              className="h-9 rounded-md bg-[var(--color-surface)] px-3 text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            >
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
            </select>
          </label>
        </div>
      ) : null}

      {draftSeconds >= 60 ? (
        <ScheduleUsageForecast agent={agent} intervalSeconds={draftSeconds} />
      ) : (
        <p className="text-xs text-[var(--color-text-muted)]">Enter an interval of at least one minute to see expected usage.</p>
      )}
      {enabled && !elsewhere && draftSeconds !== currentSeconds && (
        <Button size="sm" variant="secondary" disabled={busy || locked || draftSeconds < 60}
          onClick={() => void apply(buildSchedule(draftSeconds))}>
          Save interval
        </Button>
      )}

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
            disabled={busy || locked}
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
            disabled={busy || locked}
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
            disabled={busy || locked}
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
          {/* An error that already carries its own recovery step (such as a schedule held by a move) gets no interval hint. */}
          {/try again\.?$/i.test(error.trim()) ? error : `${error} Review the interval and try again.`}
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

/** Which organization the schedule runs in, with Assign for an unassigned one. */
function ScheduleOrganizationRow({ agent }: { agent: AgentSummary }) {
  const { state, assignAgentSchedule } = useAppState();
  const toast = useToast();
  // Only organizations this version can make active: not the sample, and with Microsoft 365.
  const choices = resolveOrganizations(state).filter(
    (organization) => organization.connections.microsoft365 !== undefined,
  );
  const current = choices.find((organization) => organization.id === agent.schedule?.organizationId);
  const [selected, setSelected] = useState(choices[0]?.id ?? "");
  // Organizations can be connected or removed while the card stays open:
  // keep a selection that is still offered, otherwise take the first.
  const choiceIds = choices.map((organization) => organization.id).join("\n");
  useEffect(() => {
    const ids = choiceIds ? choiceIds.split("\n") : [];
    setSelected((current) => (ids.includes(current) ? current : ids[0] ?? ""));
  }, [choiceIds]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-sm font-medium text-[var(--color-text)]">{SCHEDULE_ORGANIZATION_COPY.rowLabel}</div>
      {current ? (
        <p className="mt-0.5 text-sm text-[var(--color-text-soft)]">
          {current.name}. {SCHEDULE_ORGANIZATION_COPY.runsIn(current.name)}
        </p>
      ) : (
        <>
          <p className="mt-0.5 text-sm text-[var(--color-warning)]">{SCHEDULE_ORGANIZATION_COPY.unassigned}</p>
          {choices.length === 0 ? (
            <p className="mt-1 text-sm text-[var(--color-text-muted)]">{SCHEDULE_ORGANIZATION_COPY.noOrganizations}</p>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                aria-label={`${SCHEDULE_ORGANIZATION_COPY.assignLabel} for ${agent.name}`}
                name="schedule-organization"
                value={selected}
                disabled={busy}
                onChange={(event) => setSelected(event.target.value)}
                className="h-8 rounded-md bg-[var(--color-surface)] px-2.5 text-sm text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              >
                {choices.map((organization) => (
                  <option key={organization.id} value={organization.id}>{organization.name}</option>
                ))}
              </select>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !selected}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  const name = choices.find((organization) => organization.id === selected)?.name ?? "";
                  void assignAgentSchedule(agent.slug, selected)
                    .then(() => toast.success(SCHEDULE_ORGANIZATION_COPY.assigned(name)))
                    .catch((caught) =>
                      setError(
                        SCHEDULE_ORGANIZATION_COPY.failed(
                          userFacingErrorReason(caught instanceof Error ? caught.message : String(caught)) ?? "",
                        ),
                      ),
                    )
                    .finally(() => setBusy(false));
                }}
              >
                {SCHEDULE_ORGANIZATION_COPY.assignAction}
              </Button>
            </div>
          )}
        </>
      )}
      {error ? <p role="alert" className="mt-1 text-sm text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}

export const SCHEDULE_TARGET_COPY = {
  legend: "Where it runs",
  thisComputer: "This computer",
  thisComputerDetail: "Runs here while OpenAdminOS is open.",
  needsInterval: "Choose an interval of at least one minute first.",
  provenance: "Places other than this computer are provided by the team features module.",
  moduleBadge: "Team features",
  bothTitle: (label: string) => `Turned on here and on ${label}`,
  bothMessage: "The team features module reports this schedule running in another place, and the schedule on this computer is on too. It does not run here until this is resolved.",
  needsSchedule: "Turn on Automatic runs first; a schedule can move only once it exists here.",
  needsOrganization: "Assign this schedule to an organization first; a place is paired for one organization.",
  alsoRunsOn: (label: string) => `The schedule here does not run while ${label}'s own configuration runs it. Remove it from ${label}'s own configuration to run it here or move it.`,
  notOffered: "Not offered for this agent.",
  lastKnown: (label: string) => `Last known to run on ${label}`,
  lastKnownUnpaired: (label: string) => `Last known to run on ${label}, which is no longer paired here.`,
  lastKnownUnpairedStep: "It does not run here until you choose Run it here, or remove it there.",
  placementsProblemTitle: "Where schedules last ran cannot be read",
  lastKnownOff: "Team features are off, so it does not run here until you bring it back or remove it there.",
  lastKnownWaiting: "Team features have not said where it runs yet, so it does not run here meanwhile.",
  runItHere: "Run it here",
  runItHerePhrase: "RUN IT HERE",
  runItHereTitle: (label: string) => `Run it here instead of ${label}`,
  runItHereMessage: (label: string) => `The app forgets that this schedule ran on ${label}, and it can run here again. Remove it on ${label} too, or it may run in both places.`,
  cancel: "Cancel",
  typeToConfirm: (phrase: string) => `Type ${phrase} to confirm`,
  removeFromConfiguration: (label: string) => `Remove it from ${label}'s own configuration first.`,
  uncertainTitle: (label: string) => `Not certain it runs on ${label}`,
  turnOffHere: "Turn off here",
  working: "Working",
  runsElsewhere: (label: string) => `This schedule runs on ${label}. Its interval is set there.`,
} as const;

interface ScheduleTargetChoice {
  action: string;
  targets: readonly EnterpriseScheduleTargetView[];
  /** Where the schedule runs now, as the module reports it. */
  current: string;
  currentLabel: string;
  /** Why no place can be chosen now, such as a schedule without an organization. */
  blockedReason?: string;
  /** A place that also runs the agent from its own configuration. */
  alsoRunsOnLabel?: string;
  /** The module is not certain where it runs: shown with its recovery, and nothing moves. */
  uncertain?: { label: string; message: string; recovery: string };
}

/** Where an agent's schedule runs, when a team features module offers places for it or reports one. */
function useScheduleTarget(agent: AgentSummary): ScheduleTargetChoice | undefined {
  const status = useEnterpriseStatus();
  const contribution = status.active ? status.scheduleTargets : undefined;
  if (!contribution) return undefined;
  // The shared resolution, against every place the module reports: a place elsewhere is never shown as this computer.
  const current = currentTargetFor(contribution, agent.id);
  const labelOf = (targetId: string) => contribution.targets.find((target) => target.id === targetId)?.label ?? targetId;
  // A place is offered only for a schedule of the organization it is paired for.
  const organizationId = agent.schedule?.organizationId;
  const eligible = contribution.targets.filter(
    (target) => (!target.agentIds || target.agentIds.includes(agent.id)) && (organizationId === undefined || target.organizationId === organizationId),
  );
  const also = alsoRunsOnFor(contribution, agent.id);
  const unsure = uncertainFor(contribution, agent.id);
  // Every place the module names for this agent is shown, offered or not: the current one, one whose own
  // configuration runs it, and one it is not certain about.
  const named = [current, also, unsure?.targetId].filter((id): id is string => id !== undefined && id !== "this-computer");
  const targets = [
    ...eligible,
    ...contribution.targets
      .filter((target) => named.includes(target.id) && !eligible.some((offered) => offered.id === target.id))
      // Shown so the card says where the schedule is, but not offered for a choice.
      .map((target) => ({ ...target, disabledReason: target.disabledReason ?? SCHEDULE_TARGET_COPY.notOffered })),
  ];
  if (targets.length === 0) return undefined;
  const currentLabel = current === "this-computer" ? SCHEDULE_TARGET_COPY.thisComputer : labelOf(current);
  return {
    action: contribution.action,
    targets,
    current,
    currentLabel,
    ...(agent.schedule && organizationId === undefined ? { blockedReason: SCHEDULE_TARGET_COPY.needsOrganization } : {}),
    ...(also ? { alsoRunsOnLabel: labelOf(also) } : {}),
    ...(unsure ? { uncertain: { label: labelOf(unsure.targetId), message: unsure.message, recovery: unsure.recovery } } : {}),
  };
}

/**
 * Where the schedule runs: this computer, or a place a team features
 * module offers for this agent. The checked place is always the one the
 * module reports, never a local guess: a choice changes it only after the
 * module took it and reported it back.
 */
function ScheduleTargetRow({
  agent,
  where,
  intervalSeconds,
  hasSchedule,
  onMoving,
}: {
  agent: AgentSummary;
  where: ScheduleTargetChoice;
  intervalSeconds: number;
  /** Module places are offered only once the agent has a schedule here. */
  hasSchedule: boolean;
  /** Tells the card a move runs, so its own controls wait. */
  onMoving: (moving: boolean) => void;
}) {
  const [notice, setNotice] = useState<EnterpriseUiNoticeView | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const reasonPrefix = useId();
  const tooShort = intervalSeconds < 60;

  const choose = async (targetId: string) => {
    if (targetId === where.current) return;
    setNotice(undefined);
    setBusy(targetId);
    onMoving(true);
    const reply = await invokeUiAction(where.action, { kind: "schedule", agentId: agent.id, targetId, intervalSeconds });
    setBusy(undefined);
    onMoving(false);
    // The main process moved the schedule here or not, and says which; this shows what it says.
    setNotice(reply.notice);
  };

  const options = [
    {
      id: "this-computer",
      label: SCHEDULE_TARGET_COPY.thisComputer,
      detail: SCHEDULE_TARGET_COPY.thisComputerDetail,
      disabledReason:
        where.current === "this-computer"
          ? undefined
          : where.alsoRunsOnLabel
            ? SCHEDULE_TARGET_COPY.removeFromConfiguration(where.alsoRunsOnLabel)
            : tooShort
              ? SCHEDULE_TARGET_COPY.needsInterval
              : undefined,
    },
    ...where.targets.map((target) => ({
      id: target.id,
      label: target.label,
      detail: target.detail,
      disabledReason:
        where.current === target.id
          ? undefined
          : !hasSchedule
            ? SCHEDULE_TARGET_COPY.needsSchedule
            : where.blockedReason ?? target.disabledReason ?? (tooShort ? SCHEDULE_TARGET_COPY.needsInterval : undefined),
    })),
  ];
  return (
    <fieldset className="rounded-lg bg-[var(--color-bg-raised)] px-3 py-2.5 ring-1 ring-[var(--color-border-soft)]" aria-busy={busy !== undefined}>
      <legend className="float-left w-full text-sm font-medium text-[var(--color-text)]">{SCHEDULE_TARGET_COPY.legend}</legend>
      <div className="clear-both grid gap-1.5 pt-1.5">
        {options.map((option) => (
          <label key={option.id} className={`flex items-start gap-2 text-sm ${option.disabledReason ? "opacity-60" : ""}`}>
            <input
              type="radio"
              name={`schedule-target-${agent.id}`}
              aria-describedby={option.disabledReason ? `${reasonPrefix}-${option.id}` : undefined}
              value={option.id}
              checked={where.current === option.id}
              disabled={busy !== undefined || where.uncertain !== undefined || (option.disabledReason !== undefined && where.current !== option.id)}
              onChange={() => void choose(option.id)}
              className="mt-0.5"
            />
            <span>
              <span className="text-[var(--color-text)]">{option.label}</span>
              {option.id !== "this-computer" ? (
                <Badge tone="neutral" className="ml-1.5 align-middle">{SCHEDULE_TARGET_COPY.moduleBadge}</Badge>
              ) : null}
              {busy === option.id ? <span className="ml-1.5 text-xs text-[var(--color-text-muted)]">{SCHEDULE_TARGET_COPY.working}</span> : null}
              {option.detail ? <span className="block text-xs text-[var(--color-text-muted)]">{option.detail}</span> : null}
              {option.disabledReason ? <span id={`${reasonPrefix}-${option.id}`} className="block text-xs text-[var(--color-warning)]">{option.disabledReason}</span> : null}
            </span>
          </label>
        ))}
      </div>
      {where.alsoRunsOnLabel ? (
        <p className="mt-2 text-sm text-[var(--color-warning)]">{SCHEDULE_TARGET_COPY.alsoRunsOn(where.alsoRunsOnLabel)}</p>
      ) : null}
      {where.uncertain ? (
        <div className="mt-2">
          <EnterpriseNotice notice={{ type: "notice", tone: "warning", title: SCHEDULE_TARGET_COPY.uncertainTitle(where.uncertain.label), message: where.uncertain.message, recovery: where.uncertain.recovery }} />
        </div>
      ) : null}
      <p className="mt-2 text-xs text-[var(--color-text-muted)]">{SCHEDULE_TARGET_COPY.provenance}</p>
      {notice ? (
        <div className="mt-2">
          <EnterpriseNotice notice={notice} live />
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * Where a schedule was last known to run, when no module reports places in
 * this session: kept by the app, so the schedule does not run here as well.
 * With team features off, Run it here forgets the place after typed
 * confirmation.
 */
function LastKnownPlacement({ agent, live }: { agent: AgentSummary; live: boolean }) {
  const status = useEnterpriseStatus();
  const [view, setView] = useState<SchedulePlacementsView>({ placements: {} });
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | undefined>();
  const inputId = useId();
  useEffect(() => {
    const bridge = window.openAdminOS;
    if (!bridge?.getSchedulePlacements) return;
    let current = true;
    bridge.getSchedulePlacements().then(
      (next) => {
        if (current) setView(next);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [status]);
  const placement = view.placements[agent.id];
  if (view.problem && !placement) {
    return (
      <div role="status" className="rounded-[10px] bg-[var(--color-danger-soft)] px-3 py-2.5 text-sm text-[var(--color-danger)]">
        <p className="font-medium">{SCHEDULE_TARGET_COPY.placementsProblemTitle}</p>
        <p className="mt-0.5 text-[var(--color-text-soft)]">{view.problem}</p>
      </div>
    );
  }
  // A live row already says where it runs, unless the kept place is no longer paired here.
  if (!placement || (live && !placement.stale)) return null;
  const off = !status.active;
  const canTakeBack = off || placement.stale === true;
  const clear = async () => {
    setConfirming(false);
    setTyped("");
    try {
      const next = await window.openAdminOS?.clearSchedulePlacement?.(agent.id);
      if (next) setView(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <div role="status" className="rounded-[10px] bg-[var(--color-warning-soft)] px-3 py-2.5 text-sm text-[var(--color-warning)]">
      <p className="font-medium">{placement.stale ? SCHEDULE_TARGET_COPY.lastKnownUnpaired(placement.label) : SCHEDULE_TARGET_COPY.lastKnown(placement.label)}</p>
      <p className="mt-0.5 text-[var(--color-text-soft)]">
        {placement.stale ? SCHEDULE_TARGET_COPY.lastKnownUnpairedStep : off ? SCHEDULE_TARGET_COPY.lastKnownOff : SCHEDULE_TARGET_COPY.lastKnownWaiting}
      </p>
      {canTakeBack ? (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setConfirming(true)}>
          {SCHEDULE_TARGET_COPY.runItHere}
        </Button>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-[var(--color-danger)]">{error}</p> : null}
      {confirming ? (
        <Modal open onClose={() => setConfirming(false)} size="md">
          <ModalHeader title={SCHEDULE_TARGET_COPY.runItHereTitle(placement.label)} onClose={() => setConfirming(false)} />
          <div className="space-y-4 p-6">
            <p className="text-sm leading-relaxed text-[var(--color-text-soft)]">{SCHEDULE_TARGET_COPY.runItHereMessage(placement.label)}</p>
            <div className="grid gap-1">
              <label htmlFor={inputId} className="text-sm text-[var(--color-text-muted)]">{SCHEDULE_TARGET_COPY.typeToConfirm(SCHEDULE_TARGET_COPY.runItHerePhrase)}</label>
              <input
                id={inputId}
                data-autofocus
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                className="h-9 rounded-md bg-[var(--color-surface)] px-3 font-mono text-base text-[var(--color-text)] ring-1 ring-[var(--color-border)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirming(false)}>{SCHEDULE_TARGET_COPY.cancel}</Button>
              <Button variant="primary" disabled={typed !== SCHEDULE_TARGET_COPY.runItHerePhrase} onClick={() => void clear()}>
                {SCHEDULE_TARGET_COPY.runItHere}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
