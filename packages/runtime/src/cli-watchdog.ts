/** Why a watchdog ended a provider CLI run. */
export type CliWatchdogStop = "stalled" | "time-limit";

export interface CliWatchdogLimits {
  /**
   * Ends the run after this long without output, counted from the start,
   * so it also bounds the wait for the first output. Off when it is not
   * below `maxMs`.
   */
  idleMs: number;
  /** Ends the run after this long in total, even while output keeps arriving. */
  maxMs: number;
  /** The environment variables that set each limit, named in the errors. */
  env?: { idleMs: string; maxMs: string };
}

/**
 * The longest delay a Node timer takes. A longer one fires after 1 ms,
 * which would end every request at once.
 */
export const CLI_WATCHDOG_MAX_LIMIT_MS = 2_147_483_647;

/**
 * The limits for one provider: an explicit option first, then the
 * environment, then the default. Each must be a positive whole number of
 * milliseconds up to `CLI_WATCHDOG_MAX_LIMIT_MS`; an option or variable
 * that is not one is ignored, so the next source applies.
 */
export function cliWatchdogLimits(input: {
  idleMs?: number;
  maxMs?: number;
  defaults: { idleMs: number; maxMs: number };
  env: { idleMs: string; maxMs: string };
  environment?: NodeJS.ProcessEnv;
}): CliWatchdogLimits {
  const environment = input.environment ?? process.env;
  const valid = (value: number | undefined): number | undefined =>
    value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= CLI_WATCHDOG_MAX_LIMIT_MS ? value : undefined;
  const fromEnv = (name: string): number | undefined => {
    const raw = environment[name]?.trim() ?? "";
    return /^\d+$/.test(raw) ? valid(Number(raw)) : undefined;
  };
  return {
    idleMs: valid(input.idleMs) ?? fromEnv(input.env.idleMs) ?? input.defaults.idleMs,
    maxMs: valid(input.maxMs) ?? fromEnv(input.env.maxMs) ?? input.defaults.maxMs,
    env: input.env,
  };
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
  /**
   * Stops the silence timer until the next `touch`, for a wait the CLI
   * does not cause: a consumer that has not asked for the next chunk
   * yet. Unread output backs up in the pipe and the CLI waits on it,
   * which is not silence. The hard cap keeps running.
   */
  pauseIdle(): void;
  /**
   * Stops the silence timer for good once the CLI's output has ended;
   * `touch` no longer restarts it. The hard cap keeps running until
   * `clear`, so a CLI that never exits after closing its output is
   * still ended.
   */
  endOutput(): void;
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
  let outputEnded = false;
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
      if (!stopped && watchIdle && !outputEnded) armIdle();
    },
    pauseIdle() {
      clearTimeout(idleTimer);
    },
    endOutput() {
      outputEnded = true;
      clearTimeout(idleTimer);
    },
    error() {
      if (stopped === "stalled") {
        return new CliWatchdogError(
          "stalled",
          `${provider} stopped sending output for ${formatDuration(limits.idleMs)}, so OpenAdminOS ended the request. Test the provider in Settings, then retry.${
            limits.env ? ` If the model works silently for longer, set ${limits.env.idleMs} to a higher limit in milliseconds and restart OpenAdminOS.` : ""
          }`,
        );
      }
      if (stopped === "time-limit") {
        return new CliWatchdogError(
          "time-limit",
          `${provider} was still working after ${formatDuration(limits.maxMs)}, the limit for one request, so OpenAdminOS ended it. Narrow the request or split it into smaller steps, then retry.${
            limits.env ? ` To allow longer requests, set ${limits.env.maxMs} in milliseconds and restart OpenAdminOS.` : ""
          }`,
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
