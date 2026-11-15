import type { SandboxLogger } from "./log.js";

/** One line per peer and reason per window, and at most this many lines per window in total. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;
export const REFUSAL_LOG_MAX_LINES = 10;
/** Peers tracked at once; beyond this the oldest are forgotten, so the map cannot grow without bound. */
const MAX_TRACKED = 1_000;

/**
 * Logs refused requests without letting a client fill the log: one line
 * per peer address and reason per minute, carrying the count since the
 * last line, and at most 10 such lines a minute in total. Lines left out
 * by the total are counted and reported in one summary line when the
 * next minute starts.
 */
export class RefusalLog {
  private readonly peers = new Map<string, { loggedAt: number; count: number }>();
  private windowStart = Number.NEGATIVE_INFINITY;
  private linesInWindow = 0;
  private leftOut = 0;

  constructor(private readonly log: SandboxLogger, private readonly clock: () => number) {}

  note(reason: string, message: string, peer: string | undefined, fields: Record<string, string | number | undefined> = {}): void {
    const now = this.clock();
    if (now - this.windowStart >= REFUSAL_LOG_WINDOW_MS) {
      if (this.leftOut > 0) {
        this.log("warn", "Refused requests were not logged one by one: too many in a minute.", { reason: "refusals-left-out", count: this.leftOut });
      }
      this.windowStart = now;
      this.linesInWindow = 0;
      this.leftOut = 0;
    }
    const key = `${reason}\u0000${peer ?? "unknown"}`;
    const entry = this.peers.get(key) ?? { loggedAt: Number.NEGATIVE_INFINITY, count: 0 };
    entry.count += 1;
    this.peers.delete(key);
    this.peers.set(key, entry);
    if (this.peers.size > MAX_TRACKED) this.peers.delete(this.peers.keys().next().value as string);
    if (now - entry.loggedAt < REFUSAL_LOG_WINDOW_MS) return;
    if (this.linesInWindow >= REFUSAL_LOG_MAX_LINES) {
      this.leftOut += 1;
      return;
    }
    this.linesInWindow += 1;
    this.log("warn", message, { reason, peer: peer ?? "unknown", count: entry.count, ...fields });
    entry.loggedAt = now;
    entry.count = 0;
  }
}
