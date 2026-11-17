// The last schedule placements a team features module reported, kept by
// the app across launches. They only loosen on confirmation: a gap in what
// the module reports never frees a schedule to run here as well. Until the
// module reports in a session, and while team features are off, a schedule
// that ran in another place does not run here. The admin can take one back
// with Run it here. When the kept file cannot be read, every schedule is
// held until it is taken back one by one, and that hold is kept on disk.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { EnterprisePlacementsFullError, type EnterprisePlacement, type EnterprisePlacements } from "@openadminos/enterprise";

export type SchedulePlacement = EnterprisePlacement & {
  /** Team features are off, so the step is Run it here on the schedule card. */
  readonly teamFeaturesOff?: boolean;
};

export interface SchedulePlacementsView {
  readonly placements: Readonly<Record<string, EnterprisePlacement & { readonly stale: boolean }>>;
  /** Why the kept placements cannot be read or saved; absent when they are fine. */
  readonly problem?: { readonly kind: "unreadable" | "full" | "unwritable"; readonly message: string };
  /** The kept file could not be read: every agent not released is held, wherever it last ran. */
  readonly held?: { readonly released: readonly string[]; readonly reason: HoldReason };
}

/** Why every schedule is held: the kept file could not be read, or more places were reported than the app keeps. */
export type HoldReason = "unreadable" | "full";

/**
 * Above what one report can name (current, alsoRunsOn and uncertain, 500 each), so a report always fits.
 * Past it, the oldest kept places go and every schedule is held, so none of them runs here as well.
 */
export const MAX_PLACEMENTS = 2000;
/**
 * Past this many taken back schedules, ids of agents no longer installed are pruned: only an installed
 * agent runs here, so the list never outgrows the installed agents, and a hold is never lost to it.
 */
export const MAX_RELEASED = 2000;
const UNKNOWN_PLACE: EnterprisePlacement = { targetId: "unknown", label: "a place the app cannot read back", organizationId: "unknown", reason: "uncertain" };

interface FileShape {
  version: 1;
  placements: Record<string, EnterprisePlacement>;
  /** The place ids the module offered when it last reported, to tell a place no longer paired here. */
  offered?: string[];
  /** Present once a kept file could not be read: every agent not released stays held across launches. */
  held?: { released: string[]; reason?: HoldReason };
}

const FULL = `The app keeps where at most ${MAX_PLACEMENTS} schedules last ran and was given more, so a schedule does not run here until it is taken back.`;
const UNREADABLE = "The app cannot read where schedules last ran, so a schedule does not run here until it is taken back.";
const UNWRITABLE = "The app could not save where schedules last ran, so after a restart they may not be held. Check free disk space and the permissions of the OpenAdminOS data folder.";

export class SchedulePlacementMemory {
  private placements: Record<string, EnterprisePlacement> = {};
  private offered: string[] | undefined;
  private unwritable = false;
  /** The kept file existed but could not be read: every schedule is held until it is taken back. */
  private failClosed = false;
  private holdReason: HoldReason = "unreadable";
  /** Agents taken back while held: by Run it here, or reported here by the module in this session. */
  private readonly released = new Set<string>();
  /** The damaged files, moved aside before the first write so they are never overwritten. */
  private damaged: string[] = [];

  constructor(
    private readonly path: string,
    private readonly log: (message: string, detail: string) => void = (message, detail) => console.warn(`[placements] ${message}`, { detail }),
    /** The installed agent ids, or undefined while they are not read yet. */
    private readonly installed: () => ReadonlySet<string> | undefined = () => undefined,
  ) {
    this.load();
  }

  /**
   * Merges a report: set what it names; remove only agents it reports here for a place it still offers.
   * While held, only an agent the report names here is released; a report never ends the hold as a whole.
   * Throws, after keeping the rest of the report, when an agent reported here could not be released.
   */
  publish(update: { readonly placements: EnterprisePlacements; readonly offered: readonly string[]; readonly here: readonly string[] }): void {
    const next = { ...this.placements };
    let failure: unknown;
    for (const [agentId, placement] of Object.entries(update.placements)) next[agentId] = placement;
    for (const agentId of update.here) {
      if (agentId in update.placements) continue;
      const kept = next[agentId];
      if (kept && update.offered.includes(kept.targetId)) delete next[agentId];
      if (this.failClosed) {
        try {
          this.release(agentId);
        } catch (error) {
          failure ??= error;
        }
      }
    }
    this.placements = this.fit(next, Object.keys(update.placements));
    this.offered = [...update.offered];
    this.write(false);
    if (failure !== undefined) throw failure;
  }

  /** A move away starts: kept as not certain on disk before the module is asked. Throws when it cannot be kept. */
  begin(agentId: string, placement: EnterprisePlacement): void {
    if (!(agentId in this.placements) && Object.keys(this.placements).length >= MAX_PLACEMENTS) {
      this.log("a move was refused: the kept placements are full", agentId);
      throw new EnterprisePlacementsFullError(`The app keeps where at most ${MAX_PLACEMENTS} schedules run and cannot keep another, so the move was not started.`);
    }
    this.placements = { ...this.placements, [agentId]: placement };
    this.write(true);
  }

  /**
   * After a move: where it is now, back here, or not known (kept as it is). A confirmed move back also
   * releases a held agent; throws when it cannot, so the move is not reported as done while it stays held.
   */
  settle(agentId: string, outcome: EnterprisePlacement | "here" | "unknown"): void {
    if (outcome === "unknown") return;
    const next = { ...this.placements };
    let failure: unknown;
    if (outcome === "here") {
      delete next[agentId];
      if (this.failClosed) {
        try {
          this.release(agentId);
        } catch (error) {
          failure = error;
        }
      }
    } else next[agentId] = outcome;
    this.placements = next;
    this.write(false);
    if (failure !== undefined) throw failure;
  }

  /** Forgets one agent's placement, after the admin chose Run it here. */
  clear(agentId: string): void {
    if (!(agentId in this.placements) && !this.failClosed) return;
    if (this.failClosed) this.release(agentId);
    const { [agentId]: _removed, ...rest } = this.placements;
    this.placements = rest;
    this.write(false);
  }

  get(agentId: string): EnterprisePlacement | undefined {
    return this.placements[agentId];
  }

  view(): SchedulePlacementsView {
    const placements: Record<string, EnterprisePlacement & { stale: boolean }> = {};
    for (const [agentId, placement] of Object.entries(this.placements)) {
      placements[agentId] = { ...placement, stale: this.offered !== undefined && !this.offered.includes(placement.targetId) };
    }
    const problem = this.unwritable
      ? { kind: "unwritable" as const, message: UNWRITABLE }
      : this.failClosed
        ? this.holdReason === "full"
          ? { kind: "full" as const, message: FULL }
          : { kind: "unreadable" as const, message: UNREADABLE }
        : undefined;
    return {
      placements,
      ...(problem ? { problem } : {}),
      ...(this.failClosed ? { held: { released: [...this.released], reason: this.holdReason } } : {}),
    };
  }

  /** Where an agent's schedule runs instead of here, as far as the app knows; held for every agent when the file cannot be read. */
  placementFor(agentId: string): EnterprisePlacement | undefined {
    return this.placements[agentId] ?? (this.failClosed && !this.released.has(agentId) ? UNKNOWN_PLACE : undefined);
  }

  /**
   * Takes one agent out of the hold. Past MAX_RELEASED, ids of agents no longer installed are pruned
   * (one installed again is held again, which is safe). Throws only while the installed agents are not read.
   */
  private release(agentId: string): void {
    if (this.released.has(agentId)) return;
    if (this.released.size >= MAX_RELEASED) {
      const installed = this.installed();
      if (!installed) {
        this.log("a schedule stays held: the installed agents are not read yet", agentId);
        throw new Error("The app has not finished reading its installed agents, so this schedule still does not run here. Try again in a moment.");
      }
      for (const id of this.released) if (!installed.has(id)) this.released.delete(id);
      // An agent that is not installed does not run here, so it needs no release.
      if (!installed.has(agentId)) return;
    }
    this.released.add(agentId);
  }

  /**
   * Keeps every place when they fit. Otherwise the places just reported are kept, then the most recent
   * of the rest, and every schedule is held, so one whose place was not kept never runs here as well.
   */
  private fit(next: Record<string, EnterprisePlacement>, reported: readonly string[]): Record<string, EnterprisePlacement> {
    const ids = Object.keys(next);
    if (ids.length <= MAX_PLACEMENTS) return next;
    const first = new Set(reported);
    const order = [...reported.filter((id) => id in next), ...ids.filter((id) => !first.has(id)).reverse()];
    const kept = Object.fromEntries(order.slice(0, MAX_PLACEMENTS).map((id) => [id, next[id]!]));
    const dropped = order.slice(MAX_PLACEMENTS);
    for (const id of dropped) this.released.delete(id);
    if (!this.failClosed) {
      this.failClosed = true;
      this.holdReason = "full";
      this.released.clear();
    }
    this.log("more placements were reported than the app keeps; every schedule is held", `${dropped.length} not kept`);
    return kept;
  }

  private load(): void {
    const primary = this.readFile(this.path);
    if (primary.kind === "ok") {
      this.apply(primary.file);
      return;
    }
    const backup = this.readFile(`${this.path}.bak`);
    if (backup.kind === "ok") {
      this.apply(backup.file);
      if (primary.kind === "damaged") this.log("the kept placements were damaged; the last good copy is used", primary.detail);
      return;
    }
    if (primary.kind === "damaged" || backup.kind === "damaged") {
      this.failClosed = true;
      this.damaged = [primary.kind === "damaged" ? this.path : undefined, backup.kind === "damaged" ? `${this.path}.bak` : undefined].filter(
        (path): path is string => path !== undefined,
      );
      this.log("the kept placements cannot be read; every schedule is held", primary.kind === "damaged" ? primary.detail : backup.kind === "damaged" ? backup.detail : "");
    }
  }

  private apply(file: FileShape): void {
    this.placements = file.placements;
    this.offered = file.offered;
    if (file.held) {
      this.failClosed = true;
      this.holdReason = file.held.reason ?? "unreadable";
      for (const agentId of file.held.released) this.released.add(agentId);
    }
  }

  private readFile(path: string): { kind: "missing" } | { kind: "damaged"; detail: string } | { kind: "ok"; file: FileShape } {
    if (!existsSync(path)) return { kind: "missing" };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FileShape>;
      if (parsed.version !== 1 || typeof parsed.placements !== "object" || parsed.placements === null) throw new Error("unknown format");
      const placements: Record<string, EnterprisePlacement> = {};
      const entries = Object.entries(parsed.placements);
      // Never cut short: a file with more than the app writes is damaged, and holds every schedule.
      if (entries.length > MAX_PLACEMENTS) throw new Error("too many placements");
      for (const [agentId, value] of entries) {
        const entry = value as Partial<EnterprisePlacement>;
        if (
          typeof entry.targetId !== "string" ||
          typeof entry.label !== "string" ||
          typeof entry.organizationId !== "string" ||
          (entry.reason !== "runs" && entry.reason !== "configuration" && entry.reason !== "uncertain")
        ) {
          throw new Error(`the entry for ${agentId} is not a placement`);
        }
        placements[agentId] = { targetId: entry.targetId, label: entry.label, organizationId: entry.organizationId, reason: entry.reason };
      }
      const offered = Array.isArray(parsed.offered) && parsed.offered.every((id) => typeof id === "string") ? parsed.offered : undefined;
      let held: FileShape["held"];
      if (parsed.held !== undefined) {
        const released = (parsed.held as Partial<NonNullable<FileShape["held"]>> | null)?.released;
        // A hold that cannot be read is a damaged file: it fails closed rather than freeing anything.
        const reason = (parsed.held as { reason?: unknown }).reason;
        if (!Array.isArray(released) || !released.every((id) => typeof id === "string") || (reason !== undefined && reason !== "unreadable" && reason !== "full")) {
          throw new Error("the hold is not readable");
        }
        held = { released, ...(reason ? { reason } : {}) };
      }
      return { kind: "ok", file: { version: 1, placements, ...(offered ? { offered } : {}), ...(held ? { held } : {}) } };
    } catch (error) {
      return { kind: "damaged", detail: (error as Error).message };
    }
  }

  /** Writes the file and its last good copy; `strict` throws when it cannot, otherwise the problem is kept for the card. */
  private write(strict: boolean): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Kept aside for whoever looks into them; the hold written below stands in for them.
      for (const path of this.damaged) if (existsSync(path)) renameSync(path, `${path}.damaged`);
      this.damaged = [];
      const file: FileShape = {
        version: 1,
        placements: this.placements,
        ...(this.offered ? { offered: this.offered } : {}),
        ...(this.failClosed ? { held: { released: [...this.released], reason: this.holdReason } } : {}),
      };
      const text = `${JSON.stringify(file, null, 2)}\n`;
      for (const path of [this.path, `${this.path}.bak`]) {
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, path);
      }
      this.unwritable = false;
    } catch (error) {
      this.unwritable = true;
      this.log("the kept placements could not be written", (error as Error).message);
      if (strict) throw error;
    }
  }
}

/** Removes the kept files; for tests. */
export function removePlacementFiles(path: string): void {
  for (const suffix of ["", ".bak", ".damaged", ".bak.damaged"]) rmSync(`${path}${suffix}`, { force: true });
}
