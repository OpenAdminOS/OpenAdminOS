// The last schedule placements a team features module reported, kept by
// the app across launches. Until the module reports targets in a session,
// and while team features are off, a schedule that ran in another place
// does not run here as well. The admin can take one back with Run it here.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { placementSnapshot, type EnterprisePlacement, type EnterprisePlacements, type EnterpriseScheduleTargets } from "@openadminos/enterprise";

export type SchedulePlacement = EnterprisePlacement;

const MAX_ENTRIES = 500;

export class SchedulePlacementMemory {
  private placements: Record<string, SchedulePlacement> = {};

  constructor(
    private readonly path: string,
    private readonly log: (message: string, detail: string) => void = (message, detail) => console.warn(`[placements] ${message}`, { detail }),
  ) {
    this.placements = this.read();
  }

  /** Replaces the kept placements with the ones the module just reported. */
  save(placements: EnterprisePlacements): void {
    this.placements = Object.fromEntries(Object.entries(placements).slice(0, MAX_ENTRIES));
    this.write();
  }

  /** Forgets one agent's placement, after the admin chose to run it here. */
  clear(agentId: string): void {
    if (!(agentId in this.placements)) return;
    const { [agentId]: _removed, ...rest } = this.placements;
    this.placements = rest;
    this.write();
  }

  list(): Readonly<Record<string, SchedulePlacement>> {
    return { ...this.placements };
  }

  /**
   * Where an agent's schedule runs instead of here: from the module's live
   * targets once it reported them in this session, otherwise from the
   * placements kept from before.
   */
  placementFor(agentId: string, live: EnterpriseScheduleTargets | undefined): SchedulePlacement | undefined {
    if (live) return placementSnapshot(live)[agentId];
    return this.placements[agentId];
  }

  private read(): Record<string, SchedulePlacement> {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log("the kept placements could not be read", (error as Error).message);
      return {};
    }
    try {
      const parsed = JSON.parse(text) as { version?: unknown; placements?: unknown };
      if (parsed.version !== 1 || typeof parsed.placements !== "object" || parsed.placements === null) throw new Error("unknown format");
      const out: Record<string, SchedulePlacement> = {};
      for (const [agentId, value] of Object.entries(parsed.placements as Record<string, unknown>).slice(0, MAX_ENTRIES)) {
        const entry = value as Partial<SchedulePlacement>;
        if (
          typeof entry.targetId === "string" &&
          typeof entry.label === "string" &&
          typeof entry.organizationId === "string" &&
          (entry.reason === "runs" || entry.reason === "configuration" || entry.reason === "uncertain")
        ) {
          out[agentId] = { targetId: entry.targetId, label: entry.label, organizationId: entry.organizationId, reason: entry.reason };
        }
      }
      return out;
    } catch (error) {
      this.log("the kept placements file is not readable; it is treated as empty", (error as Error).message);
      return {};
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      if (Object.keys(this.placements).length === 0) {
        rmSync(this.path, { force: true });
        return;
      }
      const temporary = `${this.path}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify({ version: 1, placements: this.placements }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
    } catch (error) {
      this.log("the kept placements could not be written", (error as Error).message);
    }
  }
}
