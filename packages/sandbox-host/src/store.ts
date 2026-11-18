import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { RunRecord } from "@openadminos/agent-sdk";

/** Runs kept per agent; the oldest beyond this are removed after each write. */
export const RUN_RETENTION_PER_AGENT = 200;

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Writes to a temporary file in the same folder, flushes it, then renames it over `path`. */
export function writeFileAtomic(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = openSync(temporary, "w", 0o600);
    try {
      writeSync(file, content);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  if (process.platform === "win32") return;
  const folder = openSync(dirname(path), "r");
  try {
    fsyncSync(folder);
  } finally {
    closeSync(folder);
  }
}

/** Run records as JSON files under `<dataDir>/runs/<agent>/`, newest last by name. */
export class RunStore {
  constructor(private readonly root: string, private readonly retention = RUN_RETENTION_PER_AGENT) {}

  write(run: RunRecord): string {
    const folder = this.folderFor(run.agentSlug);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if (!SAFE_SEGMENT.test(run.id)) throw new Error(`Run id ${JSON.stringify(run.id)} cannot be used as a file name.`);
    const path = join(folder, `${fileStamp(run.queuedAt)}_${run.id}.json`);
    writeFileAtomic(path, `${JSON.stringify(run, null, 2)}\n`);
    this.prune(folder);
    return path;
  }

  /**
   * Runs of one agent, oldest first. A file that is not a run record is
   * left out here and named by `unreadableFiles`, which the host logs as
   * storage-corrupt at open.
   */
  list(agentSlug: string): RunRecord[] {
    const folder = this.folderFor(agentSlug);
    return this.files(folder).flatMap((name) => {
      const run = readRunFile(join(folder, name));
      return run ? [run] : [];
    });
  }

  /** Run files that are not valid JSON, as `agent/file` names, for the startup log. */
  unreadableFiles(): string[] {
    if (!existsSync(this.root)) return [];
    const names: string[] = [];
    for (const agent of readdirSync(this.root).sort()) {
      if (!SAFE_SEGMENT.test(agent)) continue;
      const folder = join(this.root, agent);
      for (const name of this.files(folder)) {
        if (!readRunFile(join(folder, name))) names.push(`${agent}/${name}`);
      }
    }
    return names;
  }

  latest(agentSlug: string): RunRecord | undefined {
    const runs = this.list(agentSlug);
    return runs[runs.length - 1];
  }

  /**
   * Marks runs left queued or running by a host that stopped as failed,
   * with the interruption as the reason. Returns how many were marked.
   */
  markInterrupted(now: Date): number {
    const runsRoot = this.root;
    if (!existsSync(runsRoot)) return 0;
    let marked = 0;
    for (const agent of readdirSync(runsRoot)) {
      if (!SAFE_SEGMENT.test(agent)) continue;
      for (const run of this.list(agent)) {
        if (run.status !== "running" && run.status !== "queued") continue;
        const finishedAt = now.toISOString();
        this.write({
          ...run,
          status: "failed",
          finishedAt,
          liveSummary: undefined,
          error: "Interrupted: the sandbox host stopped before this run finished.",
          summary: "Interrupted: the sandbox host stopped before this run finished.",
          logs: [...run.logs, { id: `${run.id}_interrupted`, runId: run.id, timestamp: finishedAt, level: "error", message: "Interrupted: the sandbox host stopped before this run finished." }],
        });
        marked += 1;
      }
    }
    return marked;
  }

  private folderFor(agentSlug: string): string {
    if (!SAFE_SEGMENT.test(agentSlug)) throw new Error(`Agent ${JSON.stringify(agentSlug)} cannot be used as a folder name.`);
    return join(this.root, agentSlug);
  }

  private files(folder: string): string[] {
    if (!existsSync(folder)) return [];
    return readdirSync(folder).filter((name) => name.endsWith(".json")).sort();
  }

  private prune(folder: string): void {
    const files = this.files(folder);
    for (const name of files.slice(0, Math.max(0, files.length - this.retention))) {
      rmSync(join(folder, name), { force: true });
    }
  }
}

/** A run record file, or undefined when it is not JSON or not shaped like a run record. */
function readRunFile(path: string): RunRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  return isRunRecord(parsed) ? parsed : undefined;
}

function isRunRecord(value: unknown): value is RunRecord {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.agentSlug === "string" &&
    typeof value.status === "string" &&
    typeof value.queuedAt === "string" &&
    Array.isArray(value.steps) &&
    Array.isArray(value.logs)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHealthFile(value: unknown): value is HealthFile {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.agents)) return false;
  return Object.values(value.agents).every((entry) => {
    if (!isPlainObject(entry)) return false;
    const { lastRun, lastRefusal, lastDelivery, lastNoticeReason } = entry;
    return (
      (lastRun === undefined || (isPlainObject(lastRun) && typeof lastRun.runId === "string" && typeof lastRun.status === "string")) &&
      (lastRefusal === undefined || (isPlainObject(lastRefusal) && typeof lastRefusal.reason === "string" && typeof lastRefusal.at === "string")) &&
      (lastDelivery === undefined || (isPlainObject(lastDelivery) && typeof lastDelivery.outcome === "string")) &&
      (lastNoticeReason === undefined || typeof lastNoticeReason === "string")
    );
  });
}

function fileStamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

export interface AgentHealth {
  lastRun?: { runId: string; status: string; reason?: string; finishedAt?: string };
  lastRefusal?: { reason: string; message: string; at: string };
  lastDelivery?: { runId: string; outcome: "sent" | "failed" | "skipped"; detail: string; at: string };
  /**
   * The reason of the last failure notice sent, cleared by the recovery
   * notice. A notice goes out only when the reason changes.
   */
  lastNoticeReason?: string;
}

export interface HealthFile {
  version: 1;
  sandboxId: string;
  updatedAt: string;
  agents: Record<string, AgentHealth>;
}

/** `<dataDir>/health.json`: the last run and the last refusal per agent. */
export class HealthStore {
  private state: HealthFile;
  /** Set when health.json existed but could not be read; the file is kept aside under this name. */
  readonly problem: string | undefined;

  constructor(private readonly path: string, sandboxId: string) {
    let loaded: HealthFile | undefined;
    if (existsSync(path)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (isHealthFile(parsed)) loaded = parsed;
      } catch {
        loaded = undefined;
      }
      if (!loaded) {
        const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
        renameSync(path, aside);
        this.problem = `health.json in the data folder could not be read. It was kept as ${basename(aside)} for review and a new one was started.`;
      }
    }
    this.state = loaded ?? { version: 1, sandboxId, updatedAt: new Date(0).toISOString(), agents: {} };
    this.state.sandboxId = sandboxId;
  }

  get(agentId: string): AgentHealth {
    return this.state.agents[agentId] ?? {};
  }

  update(agentId: string, change: Partial<AgentHealth>, now: Date): void {
    const next: AgentHealth = { ...this.get(agentId), ...change };
    for (const key of Object.keys(change) as Array<keyof AgentHealth>) {
      if (change[key] === undefined) delete next[key];
    }
    // Written first and kept in memory only once on disk, so what the host
    // acts on (such as the last notice reason) never runs ahead of the file.
    const state: HealthFile = { ...this.state, updatedAt: now.toISOString(), agents: { ...this.state.agents, [agentId]: next } };
    writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`);
    this.state = state;
  }
}
