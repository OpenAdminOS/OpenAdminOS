import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * process (a container restart reuses pid 1).
 */
export class InstanceLock {
  private held = false;

  constructor(private readonly path: string) {}

  acquire(): void {
    const content = JSON.stringify({ pid: process.pid, processStartedAt: PROCESS_STARTED_AT, startedAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
      const owner = this.read();
      if (owner && this.isHeld(owner)) {
        throw new SandboxRefusal(
          "already-running",
          `Another sandbox host (process ${String(owner.pid)}) is using this data folder. Stop the service before a setup check, or wait for it to finish.`,
        );
      }
      rmSync(this.path, { force: true });
    }
    throw new SandboxRefusal("already-running", `The lock file ${this.path} could not be taken. Remove it if no sandbox host is running.`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    const owner = this.read();
    if (owner?.pid === process.pid && owner.processStartedAt === PROCESS_STARTED_AT) rmSync(this.path, { force: true });
  }

  private read(): LockContent | undefined {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as LockContent;
    } catch {
      return undefined;
    }
  }

  private isHeld(owner: LockContent): boolean {
    if (typeof owner.pid !== "number") return false;
    let writtenAt: number;
    try {
      writtenAt = statSync(this.path).mtimeMs;
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
