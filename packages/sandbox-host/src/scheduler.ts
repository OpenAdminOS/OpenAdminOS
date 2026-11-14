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
  timer?: unknown;
  running?: Promise<void>;
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

  constructor(jobs: readonly ScheduledJob[], private readonly clock: SchedulerClock = realClock) {
    const now = clock.now();
    for (const job of jobs) {
      const dueAt = job.lastStartedAt === undefined ? now : Math.max(now, job.lastStartedAt + job.intervalMs);
      this.states.set(job.id, { job, dueAt });
    }
  }

  start(): void {
    for (const state of this.states.values()) this.arm(state);
  }

  /** When each job runs next, for the startup log. */
  nextRuns(): Array<{ id: string; dueAt: number }> {
    return [...this.states.values()].map((state) => ({ id: state.job.id, dueAt: state.dueAt }));
  }

  /** Clears every timer and waits for runs in progress to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    const running: Promise<void>[] = [];
    for (const state of this.states.values()) {
      if (state.timer !== undefined) this.clock.clearTimer(state.timer);
      state.timer = undefined;
      if (state.running) running.push(state.running);
    }
    await Promise.allSettled(running);
  }

  private arm(state: JobState): void {
    if (this.stopped) return;
    const delay = Math.max(0, state.dueAt - this.clock.now());
    state.timer = this.clock.setTimer(() => {
      state.timer = undefined;
      if (this.stopped) return;
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
