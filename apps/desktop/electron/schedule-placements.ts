// The last schedule placements a team features module reported, kept by
// the app across launches. They only loosen on confirmation: a gap in what
// the module reports never frees a schedule to run here as well. Until the
// module reports in a session, and while team features are off, a schedule
// that ran in another place does not run here. The admin can take one back
// with Run it here.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { EnterprisePlacement, EnterprisePlacements } from "@openadminos/enterprise";

export type SchedulePlacement = EnterprisePlacement & {
  /** Team features are off, so the step is Run it here on the schedule card. */
  readonly teamFeaturesOff?: boolean;
};

export interface SchedulePlacementsView {
  readonly placements: Readonly<Record<string, EnterprisePlacement & { readonly stale: boolean }>>;
  /** Why the kept placements cannot be trusted or saved, with the step; absent when they are fine. */
  readonly problem?: string;
}

const MAX_ENTRIES = 500;
const UNKNOWN_PLACE: EnterprisePlacement = { targetId: "unknown", label: "a place the app cannot read back", organizationId: "unknown", reason: "uncertain" };

interface FileShape {
  version: 1;
  placements: Record<string, EnterprisePlacement>;
  /** The place ids the module offered when it last reported, to tell a place no longer paired here. */
  offered?: string[];
}

export class SchedulePlacementMemory {
  private placements: Record<string, EnterprisePlacement> = {};
  private offered: string[] | undefined;
  private problem: string | undefined;
  /** The kept file existed but could not be read: every schedule is held until it is resolved. */
  private failClosed = false;
  /** Agents the admin took back with Run it here while the file could not be read. */
  private readonly released = new Set<string>();

  constructor(
    private readonly path: string,
    private readonly log: (message: string, detail: string) => void = (message, detail) => console.warn(`[placements] ${message}`, { detail }),
  ) {
    this.load();
  }

  /** Merges a report: set what it names; remove only agents it reports here for a place it still offers. */
  publish(update: { readonly placements: EnterprisePlacements; readonly offered: readonly string[]; readonly here: readonly string[] }): void {
    const next = { ...this.placements };
    for (const [agentId, placement] of Object.entries(update.placements)) next[agentId] = placement;
    for (const agentId of update.here) {
      const kept = next[agentId];
      if (kept && !(agentId in update.placements) && update.offered.includes(kept.targetId)) delete next[agentId];
    }
    this.placements = trim(next);
    this.offered = [...update.offered];
    // A report from the module in this session stands in for a file that could not be read.
    this.failClosed = false;
    this.write(false);
  }

  /** A move away starts: kept as not certain on disk before the module is asked. Throws when it cannot be kept. */
  begin(agentId: string, placement: EnterprisePlacement): void {
    this.placements = trim({ ...this.placements, [agentId]: placement });
    this.write(true);
  }

  /** After a move: where it is now, back here, or not known (kept as it is). */
  settle(agentId: string, outcome: EnterprisePlacement | "here" | "unknown"): void {
    if (outcome === "unknown") return;
    const next = { ...this.placements };
    if (outcome === "here") delete next[agentId];
    else next[agentId] = outcome;
    this.placements = next;
    this.write(false);
  }

  /** Forgets one agent's placement, after the admin chose Run it here. */
  clear(agentId: string): void {
    if (!(agentId in this.placements) && !this.failClosed) return;
    if (this.failClosed) this.released.add(agentId);
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
    return { placements, ...(this.problem ? { problem: this.problem } : {}) };
  }

  /** Where an agent's schedule runs instead of here, as far as the app knows; held for every agent when the file cannot be read. */
  placementFor(agentId: string): EnterprisePlacement | undefined {
    return this.placements[agentId] ?? (this.failClosed && !this.released.has(agentId) ? UNKNOWN_PLACE : undefined);
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
      this.problem = "The app cannot read where schedules last ran, so none of them runs here until this is resolved. Open Where it runs on each schedule card, or choose Run it here to take a schedule back.";
      this.log("the kept placements cannot be read; every schedule is held", primary.kind === "damaged" ? primary.detail : backup.kind === "damaged" ? backup.detail : "");
    }
  }

  private apply(file: FileShape): void {
    this.placements = trim(file.placements);
    this.offered = file.offered;
  }

  private readFile(path: string): { kind: "missing" } | { kind: "damaged"; detail: string } | { kind: "ok"; file: FileShape } {
    if (!existsSync(path)) return { kind: "missing" };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FileShape>;
      if (parsed.version !== 1 || typeof parsed.placements !== "object" || parsed.placements === null) throw new Error("unknown format");
      const placements: Record<string, EnterprisePlacement> = {};
      for (const [agentId, value] of Object.entries(parsed.placements).slice(0, MAX_ENTRIES)) {
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
      return { kind: "ok", file: { version: 1, placements, ...(offered ? { offered } : {}) } };
    } catch (error) {
      return { kind: "damaged", detail: (error as Error).message };
    }
  }

  /** Writes the file and its last good copy; `strict` throws when it cannot, otherwise the problem is kept for the card. */
  private write(strict: boolean): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const text = `${JSON.stringify({ version: 1, placements: this.placements, ...(this.offered ? { offered: this.offered } : {}) }, null, 2)}\n`;
      for (const path of [this.path, `${this.path}.bak`]) {
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, text, { mode: 0o600 });
        renameSync(temporary, path);
      }
      if (!this.failClosed) this.problem = undefined;
    } catch (error) {
      this.problem = "The app could not save where schedules last ran, so after a restart they may not be held. Check free disk space and the permissions of the OpenAdminOS data folder.";
      this.log("the kept placements could not be written", (error as Error).message);
      if (strict) throw error;
    }
  }
}

function trim(placements: Record<string, EnterprisePlacement>): Record<string, EnterprisePlacement> {
  return Object.fromEntries(Object.entries(placements).slice(0, MAX_ENTRIES));
}

/** Removes the kept files; for tests. */
export function removePlacementFiles(path: string): void {
  rmSync(path, { force: true });
  rmSync(`${path}.bak`, { force: true });
}
