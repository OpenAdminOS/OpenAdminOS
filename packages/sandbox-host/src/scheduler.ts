/** setTimeout cannot wait longer than this; longer waits are re-armed. */
const MAX_TIMER_MS = 2_147_483_647;

export interface ScheduledJob {
  id: string;
  intervalMs: number;
  /** When the job last started, or undefined when it never ran. */
  lastStartedAt?: number;
  run(): Promise<void>;
}

export interface SchedulerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface JobState {
  job: ScheduledJob;
  dueAt: number;
  lastStartedAt?: number;
  timer?: unknown;
  running?: Promise<void>;
  /** Taken out by `replace`: a run in progress finishes, but the job is not armed again. */
  removed?: boolean;
}

/**
 * An in-process schedule. Each job runs one at a time. After downtime a
 * job that is overdue runs once, right away, and then goes back to its
 * interval: missed runs are not made up and never move anywhere else.
 * The timers are referenced, so the service stays up, and `stop` clears
 * every one of them.
 */
export class Scheduler {
  private readonly states = new Map<string, JobState>();
  private stopped = false;
  private started = false;
  /** Runs of removed jobs still in progress; `stop` waits for them too. */
  private readonly removedRunning = new Set<Promise<void>>();

  constructor(jobs: readonly ScheduledJob[], private readonly clock: SchedulerClock = realClock) {
    const now = clock.now();
    for (const job of jobs) this.states.set(job.id, this.newState(job, now));
  }

  start(): void {
    this.started = true;
    for (const state of this.states.values()) this.arm(state);
  }

  /**
   * Swaps the job list without a restart. A job that stays keeps its due
   * time, and a changed interval counts from its last start; a run in
   * progress is never started twice. A removed job's run in progress
   * finishes and is not armed again. New jobs are due as in the
   * constructor: once, when overdue, never once per missed interval.
   */
  replace(jobs: readonly ScheduledJob[]): void {
    if (this.stopped) return;
    const now = this.clock.now();
    const next = new Set(jobs.map((job) => job.id));
    for (const [id, state] of this.states) {
      if (next.has(id)) continue;
      if (state.timer !== undefined) this.clock.clearTimer(state.timer);
      state.timer = undefined;
      state.removed = true;
      this.states.delete(id);
      const running = state.running;
      if (running) {
        this.removedRunning.add(running);
        void running.finally(() => this.removedRunning.delete(running));
      }
    }
    for (const job of jobs) {
      const existing = this.states.get(job.id);
      if (!existing) {
        const state = this.newState(job, now);
        this.states.set(job.id, state);
        if (this.started) this.arm(state);
        continue;
      }
      const intervalChanged = existing.job.intervalMs !== job.intervalMs;
      existing.job = job;
      if (existing.running || !intervalChanged) continue;
      const lastStartedAt = existing.lastStartedAt ?? job.lastStartedAt;
      existing.dueAt = lastStartedAt === undefined ? existing.dueAt : Math.max(now, lastStartedAt + job.intervalMs);
      if (existing.timer !== undefined) this.clock.clearTimer(existing.timer);
      existing.timer = undefined;
      if (this.started) this.arm(existing);
    }
  }

  private newState(job: ScheduledJob, now: number): JobState {
    const dueAt = job.lastStartedAt === undefined ? now : Math.max(now, job.lastStartedAt + job.intervalMs);
    return { job, dueAt, ...(job.lastStartedAt !== undefined ? { lastStartedAt: job.lastStartedAt } : {}) };
  }

  /** When each job runs next, for the startup log. */
  nextRuns(): Array<{ id: string; dueAt: number }> {
    return [...this.states.values()].map((state) => ({ id: state.job.id, dueAt: state.dueAt }));
  }

  /** Clears every timer and waits for runs in progress to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    const running: Promise<void>[] = [...this.removedRunning];
    for (const state of this.states.values()) {
      if (state.timer !== undefined) this.clock.clearTimer(state.timer);
      state.timer = undefined;
      if (state.running) running.push(state.running);
    }
    await Promise.allSettled(running);
  }

  private arm(state: JobState): void {
    if (this.stopped || state.removed) return;
    const delay = Math.max(0, state.dueAt - this.clock.now());
    state.timer = this.clock.setTimer(() => {
      state.timer = undefined;
      if (this.stopped || state.removed) return;
      if (this.clock.now() < state.dueAt) {
        this.arm(state);
        return;
      }
      this.fire(state);
    }, Math.min(delay, MAX_TIMER_MS));
  }

  private fire(state: JobState): void {
    if (state.running) return;
    const startedAt = this.clock.now();
    state.lastStartedAt = startedAt;
    state.running = state.job
      .run()
      .catch(() => undefined)
      .finally(() => {
        state.running = undefined;
        // One run per due time: a run that took longer than the interval,
        // or a machine that slept, waits a whole interval from now.
        const next = startedAt + state.job.intervalMs;
        const now = this.clock.now();
        state.dueAt = next > now ? next : now + state.job.intervalMs;
        this.arm(state);
      });
  }
}
