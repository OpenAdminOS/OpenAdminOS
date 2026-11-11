/** Why a watchdog ended a provider CLI run. */
export type CliWatchdogStop = "stalled" | "time-limit";

export interface CliWatchdogLimits {
  /** Ends the run after this long without output. Off when it is not below `maxMs`. */
  idleMs: number;
  /** Ends the run after this long in total, even while output keeps arriving. */
  maxMs: number;
}

export class CliWatchdogError extends Error {
  constructor(
    public readonly stop: CliWatchdogStop,
    message: string,
  ) {
    super(message);
    this.name = "CliWatchdogError";
  }
}

export interface CliWatchdog {
  /** Records output from the CLI and restarts the silence timer. */
  touch(): void;
  /** The designed error once the watchdog has ended the run, otherwise undefined. */
  error(): CliWatchdogError | undefined;
  /** Stops both timers. Call it in `finally`. */
  clear(): void;
}

/**
 * Bounds a provider CLI run by silence and by total time, so a long answer that
 * keeps streaming can finish while a CLI that went quiet is ended early.
 * `onStop` must end the process; the caller then throws `error()`.
 * Both timers stay referenced so a pending run keeps the process alive.
 */
export function startCliWatchdog(
  provider: string,
  limits: CliWatchdogLimits,
  onStop: () => void,
): CliWatchdog {
  let stopped: CliWatchdogStop | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const watchIdle = limits.idleMs < limits.maxMs;
  const stop = (reason: CliWatchdogStop) => {
    if (stopped) return;
    stopped = reason;
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    onStop();
  };
  const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("stalled"), limits.idleMs);
  };
  const maxTimer = setTimeout(() => stop("time-limit"), limits.maxMs);
  if (watchIdle) armIdle();

  return {
    touch() {
      if (!stopped && watchIdle) armIdle();
    },
    error() {
      if (stopped === "stalled") {
        return new CliWatchdogError(
          "stalled",
          `${provider} stopped sending output for ${formatDuration(limits.idleMs)}, so OpenAdminOS ended the request. Test the provider in Settings, then retry.`,
        );
      }
      if (stopped === "time-limit") {
        return new CliWatchdogError(
          "time-limit",
          `${provider} was still working after ${formatDuration(limits.maxMs)}, the limit for one request, so OpenAdminOS ended it. Narrow the request or split it into smaller steps, then retry.`,
        );
      }
      return undefined;
    },
    clear() {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
    },
  };
}

function formatDuration(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    const minutes = ms / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.max(1, Math.round(ms / 1000));
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}
