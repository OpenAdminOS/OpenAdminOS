import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";

import { SandboxRefusal } from "./refusal.js";

/** When this process started, to tell it apart from an earlier process with the same pid. */
const PROCESS_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

/** A takeover guard older than this is left by a host that died while taking over. */
const GUARD_STALE_MS = 60_000;

interface LockContent {
  pid?: unknown;
  processStartedAt?: unknown;
}

/**
 * One host per data folder: the service and a `--once` setup check never
 * run at the same time.
 *
 * The lock file is written in full and then linked into place, so it is
 * never seen empty, and a link only succeeds while no lock exists. A lock
 * is stale when its process no longer exists, when it was written before
 * the machine booted, or when it carries this process's pid from an
 * earlier process (a container restart reuses pid 1).
 *
 * Replacing a stale lock is serialized by a takeover guard, a second file
 * created with O_EXCL: only the host holding the guard may remove the
 * lock, and it checks the lock again under the guard first. While the
 * stale lock is in place nobody else can link one, so no live lock is
 * ever removed. A guard left by a host that died is itself stale and is
 * cleared the same way.
 */
export class InstanceLock {
  private held = false;
  private readonly guardPath: string;

  constructor(private readonly path: string) {
    this.guardPath = `${path}.takeover`;
  }

  acquire(): void {
    const content = JSON.stringify({ pid: process.pid, processStartedAt: PROCESS_STARTED_AT, startedAt: new Date().toISOString() });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (this.link(content)) return;
      const owner = this.read(this.path);
      if (owner && this.isHeld(owner, this.path)) throw this.heldBy(owner);
      if (!this.takeGuard(content)) {
        throw new SandboxRefusal("already-running", "Another sandbox host is taking over this data folder right now. Wait for it to start, or stop it first.");
      }
      try {
        // Under the guard: look again, then remove only a lock that is still stale.
        const current = this.read(this.path);
        if (current && this.isHeld(current, this.path)) throw this.heldBy(current);
        rmSync(this.path, { force: true });
        if (this.link(content)) return;
        // A host that found no lock at all linked its own in between; it holds the folder.
        const winner = this.read(this.path);
        if (winner && this.isHeld(winner, this.path)) throw this.heldBy(winner);
      } finally {
        this.releaseGuard();
      }
    }
    throw new SandboxRefusal("already-running", `The lock file ${this.path} could not be taken. Remove it if no sandbox host is running.`);
  }

  release(): void {
    if (!this.held) return;
    this.held = false;
    if (this.isOurs(this.read(this.path))) rmSync(this.path, { force: true });
  }

  /** Links a fully written lock into place; false when one exists. */
  private link(content: string): boolean {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, { mode: 0o600 });
    try {
      linkSync(temporary, this.path);
      this.held = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  /** Creates the takeover guard, clearing one left by a dead host. False when a live host holds it. */
  private takeGuard(content: string): boolean {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const temporary = `${this.guardPath}.${randomUUID()}.tmp`;
      writeFileSync(temporary, content, { mode: 0o600 });
      try {
        linkSync(temporary, this.guardPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        rmSync(temporary, { force: true });
      }
      const guard = this.read(this.guardPath);
      if (guard && this.isHeld(guard, this.guardPath, GUARD_STALE_MS)) return false;
      // A dead host's guard: move it aside under a name of our own, so only one host clears it.
      const aside = `${this.guardPath}.stale-${randomUUID()}`;
      try {
        renameSync(this.guardPath, aside);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const moved = this.read(aside);
      if (moved && this.isHeld(moved, aside, GUARD_STALE_MS)) {
        // A live host's guard landed in between: give it back and step aside.
        // If yet another guard took its place, a takeover is in progress either way.
        try {
          linkSync(aside, this.guardPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        } finally {
          rmSync(aside, { force: true });
        }
        return false;
      }
      rmSync(aside, { force: true });
    }
    return false;
  }

  private releaseGuard(): void {
    if (this.isOurs(this.read(this.guardPath))) rmSync(this.guardPath, { force: true });
  }

  private isOurs(content: LockContent | undefined): boolean {
    return content?.pid === process.pid && content.processStartedAt === PROCESS_STARTED_AT;
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

  private isHeld(owner: LockContent, path: string, maxAgeMs?: number): boolean {
    if (typeof owner.pid !== "number") return false;
    let writtenAt: number;
    try {
      writtenAt = statSync(path).mtimeMs;
    } catch {
      return false;
    }
    const bootedAt = Date.now() - uptime() * 1000;
    if (writtenAt < bootedAt) return false;
    if (maxAgeMs !== undefined && Date.now() - writtenAt > maxAgeMs) return false;
    if (owner.pid === process.pid) return owner.processStartedAt === PROCESS_STARTED_AT;
    try {
      process.kill(owner.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
