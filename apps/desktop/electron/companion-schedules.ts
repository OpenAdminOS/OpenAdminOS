import {
  scheduleRunsInActiveOrganization,
  type AgentSchedule,
  type AgentSummary,
  type AppState,
  type CompanionRunDueReadSchedulesResult,
  type CompanionScheduleItem,
  type RunRecord,
} from "@openadminos/agent-sdk";

/** When an enabled schedule is next due; a schedule that never fired is due now. */
export function nextRunTimeForSchedule(
  schedule: AgentSchedule | undefined,
  nowMs = Date.now(),
): number {
  if (!schedule?.enabled) return Number.POSITIVE_INFINITY;
  const lastFired = schedule.lastScheduledRunAt
    ? new Date(schedule.lastScheduledRunAt).getTime()
    : 0;
  if (lastFired <= 0) return nowMs;
  return lastFired + schedule.intervalSeconds * 1000;
}

export function latestScheduledRunForAgent(
  runs: RunRecord[],
  agentSlug: string,
): RunRecord | undefined {
  return runs
    .filter((run) => run.agentSlug === agentSlug && run.trigger === "schedule")
    .sort((a, b) => Date.parse(b.queuedAt) - Date.parse(a.queuedAt))[0];
}

/**
 * The menu bar's next schedules. Only the active organization's schedules
 * can fire, so only they are listed and counted as due; another
 * organization's or an unassigned schedule never shows a next-run time.
 */
export function companionUpcomingSchedules(
  state: Pick<AppState, "installedAgents" | "runs" | "activeOrganizationId">,
  nowMs = Date.now(),
): CompanionScheduleItem[] {
  return state.installedAgents
    .filter(
      (agent) =>
        agent.schedule?.enabled === true &&
        scheduleRunsInActiveOrganization(agent.schedule, state.activeOrganizationId),
    )
    .map((agent) => {
      const latest = latestScheduledRunForAgent(state.runs, agent.slug);
      return {
        agentSlug: agent.slug,
        agentName: agent.name,
        mode: agent.mode,
        nextRunAt: new Date(nextRunTimeForSchedule(agent.schedule, nowMs)).toISOString(),
        intervalSeconds: agent.schedule?.intervalSeconds ?? 3600,
        ...(latest?.status ? { lastStatus: latest.status } : {}),
        ...(latest?.changeState ? { changeState: latest.changeState } : {}),
        route: `/agents/${agent.slug}`,
      };
    })
    .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))
    .slice(0, 5);
}

/**
 * Menu bar Run due: start every due read schedule of the active
 * organization. Another organization's schedule, or an unassigned one,
 * waits and is counted as waiting, never as an error.
 */
export async function runDueCompanionSchedules(
  state: Pick<AppState, "installedAgents" | "runs" | "activeOrganizationId">,
  nowMs: number,
  host: { startScheduledRun(agent: AgentSummary): Promise<void> },
): Promise<CompanionRunDueReadSchedulesResult> {
  const result: CompanionRunDueReadSchedulesResult = {
    queued: 0,
    skippedWrite: 0,
    skippedInFlight: 0,
    skippedNotDue: 0,
    waitingOtherOrganization: 0,
    errors: [],
  };
  for (const agent of state.installedAgents) {
    const schedule = agent.schedule;
    if (!schedule?.enabled) continue;
    if (!scheduleRunsInActiveOrganization(schedule, state.activeOrganizationId)) {
      result.waitingOtherOrganization += 1;
      continue;
    }
    if (agent.mode === "write") {
      result.skippedWrite += 1;
      continue;
    }
    if (nextRunTimeForSchedule(schedule, nowMs) > nowMs) {
      result.skippedNotDue += 1;
      continue;
    }
    const inFlight = state.runs.some(
      (run) =>
        run.agentSlug === agent.slug &&
        (run.status === "queued" || run.status === "running" || run.status === "awaiting-confirmation"),
    );
    if (inFlight) {
      result.skippedInFlight += 1;
      continue;
    }
    try {
      await host.startScheduledRun(agent);
      result.queued += 1;
    } catch (error) {
      result.errors.push({
        agentSlug: agent.slug,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
