import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";

import { SandboxRefusal } from "./refusal.js";

/** When this process started, to tell it apart from an earlier process with the same pid. */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

interface LockContent {
  pid?: unknown;
  processStartedAt?: unknown;
}

/**
 * One host per data folder: the service and a `--once` setup check never
 * run at the same time. The lock file is written in full and then linked
 * into place, so it is never seen empty. A lock is stale, and taken over,
 * when its process no longer exists, when it was written before the
 * machine booted, or when it carries this process's pid from an earlier
 * process (a container restart reuses pid 1). A stale lock is claimed by
 * renaming it to a name of its own: only one rename of the file can win,
 * so two hosts taking over at once cannot both succeed.
 */
export class InstanceLock {
  private held = false;

  constructor(private readonly path: string) {}

  acquire(): void {
    const content = JSON.stringify({ pid: process.pid, processStartedAt: PROCESS_STARTED_AT, startedAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, content, { mode: 0o600 });
      try {
        linkSync(temporary, this.path);
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        rmSync(temporary, { force: true });
      }
      const owner = this.read(this.path);
      if (owner && this.isHeld(owner, this.path)) throw this.heldBy(owner);
      const claim = `${this.path}.stale-${randomUUID()}`;
      try {
        renameSync(this.path, claim);
      } catch (error) {
        // Another host claimed or replaced it first; look again.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const claimed = this.read(claim);
      if (claimed && this.isHeld(claimed, claim)) {
        // Between the check and the rename a live host wrote its lock: put it back.
        try {
          linkSync(claim, this.path);
        } catch {
          // A third host holds the path now; either way the lock is not ours.
        }
        rmSync(claim, { force: true });
        throw this.heldBy(claimed);
      }
      rmSync(claim, { force: true });
    }
    throw new SandboxRefusal("already-running", `The lock file ${this.path} could not be taken. Remove it if no sandbox host is running.`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    const owner = this.read(this.path);
    if (owner?.pid === process.pid && owner.processStartedAt === PROCESS_STARTED_AT) rmSync(this.path, { force: true });
  }

  private heldBy(owner: LockContent): SandboxRefusal {
    return new SandboxRefusal(
      "already-running",
      `Another sandbox host (process ${String(owner.pid)}) is using this data folder. Stop the service before a setup check, or wait for it to finish.`,
    );
  }

  private read(path: string): LockContent | undefined {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as LockContent;
    } catch {
      return undefined;
    }
  }

  private isHeld(owner: LockContent, path: string): boolean {
    if (typeof owner.pid !== "number") return false;
    let writtenAt: number;
    try {
      writtenAt = statSync(path).mtimeMs;
    } catch {
      return false;
    }
    const bootedAt = Date.now() - uptime() * 1000;
    if (writtenAt < bootedAt) return false;
    if (owner.pid === process.pid) return owner.processStartedAt === PROCESS_STARTED_AT;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
