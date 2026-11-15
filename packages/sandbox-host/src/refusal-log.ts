import type { SandboxLogger } from "./log.js";

/** One line per peer and reason per window, and at most this many lines per window for each group. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;
export const REFUSAL_LOG_MAX_LINES = 10;
/** Peers tracked at once; beyond this the oldest are forgotten, so the map cannot grow without bound. */
const MAX_TRACKED = 1_000;
const MAX_SAMPLES = 5;

/**
 * Reasons share a budget only with their own group, so a flood of access
 * refusals never hides a pairing line.
 */
export type RefusalGroup = "pairing" | "access";

const GROUP_OF: Record<string, RefusalGroup> = {
  "pairing-rate-limited": "pairing",
  "client-not-paired": "access",
};

export interface RefusalLogTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

/** Unreferenced: the summary timer alone never keeps the service up; close flushes it. */
const realTimers: RefusalLogTimers = {
  set: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return timer;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface LeftOut {
  count: number;
  samples: string[];
}

/**
 * Logs refused requests without letting a client fill the log: one line
 * per peer address and reason per minute, carrying the count since the
 * last line, and at most 10 such lines a minute for each group (pairing,
 * access). What a group's cap leaves out is reported when the minute
 * ends, in one summary line per group naming each reason, its count and
 * up to 5 sample peer addresses.
 */
export class RefusalLog {
  private readonly peers = new Map<string, { loggedAt: number; count: number }>();
  private windowStart: number | undefined;
  private timer: unknown;
  private readonly lines = new Map<RefusalGroup, number>();
  private readonly leftOut = new Map<RefusalGroup, Map<string, LeftOut>>();

  constructor(
    private readonly log: SandboxLogger,
    private readonly clock: () => number,
    private readonly timers: RefusalLogTimers = realTimers,
  ) {}

  note(reason: string, message: string, peer: string | undefined, fields: Record<string, string | number | undefined> = {}): void {
    const now = this.clock();
    if (this.windowStart !== undefined && now - this.windowStart >= REFUSAL_LOG_WINDOW_MS) this.flush();
    if (this.windowStart === undefined) {
      this.windowStart = now;
      this.timer = this.timers.set(() => this.flush(), REFUSAL_LOG_WINDOW_MS);
    }
    const address = peer ?? "unknown";
    const key = `${reason}\u0000${address}`;
    const entry = this.peers.get(key) ?? { loggedAt: Number.NEGATIVE_INFINITY, count: 0 };
    entry.count += 1;
    this.peers.delete(key);
    this.peers.set(key, entry);
    if (this.peers.size > MAX_TRACKED) this.peers.delete(this.peers.keys().next().value as string);
    if (now - entry.loggedAt < REFUSAL_LOG_WINDOW_MS) return;
    const group = GROUP_OF[reason] ?? "pairing";
    const written = this.lines.get(group) ?? 0;
    if (written >= REFUSAL_LOG_MAX_LINES) {
      const byReason = this.leftOut.get(group) ?? new Map<string, LeftOut>();
      const left = byReason.get(reason) ?? { count: 0, samples: [] };
      left.count += 1;
      if (left.samples.length < MAX_SAMPLES && !left.samples.includes(address)) left.samples.push(address);
      byReason.set(reason, left);
      this.leftOut.set(group, byReason);
      return;
    }
    this.lines.set(group, written + 1);
    this.log("warn", message, { reason, peer: address, count: entry.count, ...fields });
    entry.loggedAt = now;
    entry.count = 0;
  }

  /** Writes the summary of the window that is open, if any, and stops its timer. */
  close(): void {
    this.flush();
  }

  private flush(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
    this.windowStart = undefined;
    for (const [group, byReason] of this.leftOut) {
      const details = [...byReason].map(([reason, left]) => `${reason}=${left.count} (${left.samples.join(", ")}${left.count > left.samples.length ? ", ..." : ""})`).join("; ");
      const total = [...byReason.values()].reduce((sum, left) => sum + left.count, 0);
      this.log("warn", `Refused requests were not logged one by one in the last minute: ${details}.`, { reason: "refusals-left-out", group, count: total });
    }
    this.leftOut.clear();
    this.lines.clear();
  }
}
