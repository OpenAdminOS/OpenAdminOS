/**
 * Full local reset ("Reset OpenAdminOS" in Settings > Data).
 *
 * Two phases, so nothing is deleted while Chromium, SQLite or MSAL still
 * hold files in the data folder:
 *
 * 1. `requestLocalReset` (running app): checks the typed phrase, writes a
 *    pending-reset marker into the data folder, closes every organization
 *    to new work, turns off the OS scheduler and the login item. The caller
 *    then stops the stores and relaunches. It does not sign out first: that
 *    rewrites the token caches in place, which cannot be bound to the folder
 *    the reset was accepted for. The token files go with the data folder.
 * 2. `runPendingLocalReset` (next launch, at the top of the main script,
 *    after the single-instance lock and before `app.whenReady`): empties the
 *    data folder except the IT policy file, the marker and Chromium's lock
 *    files, then (installed builds only) removes the per-user leftovers
 *    outside it. The marker goes last, so an interrupted wipe resumes at the
 *    next launch.
 *
 * Synchronous on purpose: it runs before Chromium reads Local State (the
 * Windows safeStorage key) and before anything uses safeStorage, so the
 * macOS Keychain item can be removed without a new key being created first.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, type Dirent, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";

import type { LocalResetProblem, LocalResetReport } from "@openadminos/agent-sdk";

import { LOCAL_RESET_PHRASE } from "../src/shared/local-reset.js";
import { syncDirectory } from "./durable-file.js";

/** The marker file in the data folder. Its presence means a reset is pending. */
export const LOCAL_RESET_MARKER = "local-reset-pending.json";

/** The IT-managed policy file. Never removed. */
export const MANAGED_POLICY_FILE = "policy.json";

/**
 * Chromium's single-instance lock files. They belong to the process that
 * runs the wipe and go away when it quits.
 */
const CHROMIUM_LOCK_FILES = new Set(["SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"]);

/**
 * Audit log files that sit next to a database. A missing anchor beside
 * audit rows is an integrity failure, so these go only after every other
 * entry, the database included, is gone.
 */
const AUDIT_SIDE_FILE_SUFFIXES = ["-audit-anchor.json", "-audit-pending.json"];

/**
 * The Keychain item Electron's safeStorage uses for the app name
 * "OpenAdminOS": service "<name> Safe Storage", account "<name>".
 */
export const MACOS_SAFE_STORAGE_SERVICE = "OpenAdminOS Safe Storage";
export const MACOS_SAFE_STORAGE_ACCOUNT = "OpenAdminOS";
const MACOS_BUNDLE_ID = "com.openadminos.desktop";
/** electron-updater's cache folder: the package name "@openadminos/desktop", sanitized, plus "-updater". */
export const UPDATER_CACHE_DIR = "@openadminosdesktop-updater";

/**
 * Each command gets a short bound: the wipe blocks startup, and a second
 * launch waits about 20 seconds for this process before it treats it as
 * hung. An interrupted wipe resumes at the next launch.
 */
const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Which build asked for the reset. Development and installed builds can
 * share the default data folder, so the build that finishes a reset never
 * does more, or less, than the one that asked: only an installed build's
 * request removes the Keychain item, the scheduler and the caches, and only
 * an installed build carries that out.
 */
export type LocalResetBuild = "installed" | "development";

export interface LocalResetMarker {
  version: 1;
  requestedAt: string;
  /** Absent in a marker that could not be read: treated as development, the narrower cleanup. */
  build?: LocalResetBuild;
  /** Steps of the request that did not finish; shown with the report. */
  requestWarnings?: LocalResetProblem[];
  /** The cleanup outside the data folder ran; a resumed wipe never runs it again. */
  leftoversDone?: true;
  /**
   * The data folder the request was accepted for: device, inode and birth
   * time, written by writeLocalResetMarker and matched by
   * markerFolderMatches. A copy of the folder restored or roamed to another
   * device has another identity, so its marker is not trusted there.
   */
  folder?: LocalResetFolderIdentity;
  /** Set when reading, never written: the marker is not trusted, with the reason shown to the admin. */
  unusable?: string;
}

// ---------------------------------------------------------------------------
// Phase 1: the request.
// ---------------------------------------------------------------------------

/** A reset that did not start. Nothing was removed. */
export class LocalResetRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalResetRequestError";
  }
}

export interface LocalResetRequestSteps {
  /** Throws when the reset must wait, for example while a change is being applied. */
  checkReady(): Promise<void>;
  writeMarker(marker: LocalResetMarker): Promise<void>;
  /**
   * After the marker: no connector send is approved and no organization
   * starts new work. Writes nothing to the data folder.
   */
  stopTenantWork(): Promise<void>;
  disableScheduler(): Promise<void>;
  disableLoginItem(): Promise<void>;
  build: LocalResetBuild;
  now?: () => Date;
}

/**
 * Phase 1. The marker is written first: after that the reset happens at
 * the next launch whatever else fails, so the later steps only make it
 * cleaner and their failures are reported, not fatal.
 */
export async function requestLocalReset(
  confirmation: unknown,
  steps: LocalResetRequestSteps,
): Promise<{ marker: LocalResetMarker }> {
  if (confirmation !== LOCAL_RESET_PHRASE) {
    throw new LocalResetRequestError(`Type ${LOCAL_RESET_PHRASE} exactly to reset. Nothing was removed.`);
  }
  await steps.checkReady();
  const marker: LocalResetMarker = {
    version: 1,
    requestedAt: (steps.now?.() ?? new Date()).toISOString(),
    build: steps.build,
  };
  try {
    await steps.writeMarker(marker);
  } catch (cause) {
    throw new LocalResetRequestError(
      `The reset could not start: the data folder could not be written (${reasonOf(cause)}). Nothing was removed.`,
    );
  }
  try {
    await steps.stopTenantWork();
  } catch (cause) {
    // The shutdown before the restart stops the same work.
    console.warn(`[local-reset] could not close every organization's work: ${reasonOf(cause)}`);
  }
  const warnings: LocalResetProblem[] = [];
  for (const [item, step] of [
    ["Background scheduler", steps.disableScheduler],
    ["Menu bar login item", steps.disableLoginItem],
  ] as const) {
    try {
      await step();
    } catch (cause) {
      warnings.push({ item, reason: reasonOf(cause) });
    }
  }
  if (warnings.length > 0) {
    marker.requestWarnings = warnings;
    // The marker is already on disk; this only adds the warnings to it.
    await steps.writeMarker(marker).catch((cause: unknown) => {
      console.warn(`[local-reset] the request warnings could not be added to the marker: ${reasonOf(cause)}`);
    });
  }
  return { marker };
}

/**
 * Writes the marker atomically, so a crash never leaves half a marker. The
 * rename is the commit point: once it succeeded the next launch resets, so
 * a failed directory flush after it is logged, never reported as a reset
 * that did not start.
 */
export async function writeLocalResetMarker(
  userDataDir: string,
  marker: LocalResetMarker,
  options: {
    syncDirectory?: (path: string) => Promise<void>;
    /**
     * The folder this reset was accepted for, taken before the checks.
     * Every write goes only to that folder and records its identity, so a
     * folder restored or swapped in meanwhile never receives a reset request.
     */
    expectFolder?: LocalResetFolderIdentity;
    /**
     * Called right after the rename, before the folder flush is awaited:
     * the reset is committed from that moment, so the caller stops state
     * writes there and not only once the flush returns.
     */
    onCommitted?: () => void;
  } = {},
): Promise<LocalResetFolderIdentity> {
  const path = join(userDataDir, LOCAL_RESET_MARKER);
  const temp = markerTempPath(userDataDir);
  const current = localResetFolderIdentity(userDataDir);
  if (!current) throw new Error("the data folder could not be read");
  if (options.expectFolder && !sameSessionFolder(options.expectFolder, current)) {
    throw new Error("the data folder is no longer the one the reset was accepted for");
  }
  const folder = options.expectFolder ?? current;
  try {
    // "wx" creates a new file and fails on anything already there, a link
    // included, so a planted link can never redirect the write.
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ ...marker, folder }, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
  // The rename is the commit point: a failing callback is logged, never
  // reported as a reset that did not start.
  try {
    options.onCommitted?.();
  } catch (cause) {
    console.warn(`[local-reset] the reset is committed but its callback failed: ${reasonOf(cause)}`);
  }
  try {
    await (options.syncDirectory ?? syncDirectory)(userDataDir);
  } catch (cause) {
    console.warn(`[local-reset] the marker is in place but the data folder could not be flushed: ${reasonOf(cause)}`);
  }
  return folder;
}

/**
 * What the restart after a reset launches. A Linux AppImage runs from a
 * mount (or an extracted copy) that goes away when this process exits, so
 * it is relaunched through the AppImage file itself, which `APPIMAGE` names.
 */
export function relaunchTarget(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  argv: readonly string[];
  execPath: string;
  dropArgs: readonly string[];
  /** The Linux mount table, to tell a mounted AppImage from an extracted one. */
  mountInfo?: () => string;
}): { execPath?: string; args: string[]; extractAndRun?: boolean } {
  const args = input.argv.slice(1).filter((arg) => !input.dropArgs.includes(arg));
  // Only this app's own AppImage: the runtime sets APPDIR to the folder it
  // runs from, and APPIMAGE can be inherited from a parent that is another
  // AppImage (an installed package started from such a shell). APPDIR is
  // compared as written and as the system resolves it.
  const appImage = input.platform === "linux" ? input.env.APPIMAGE : undefined;
  const appDir = input.env.APPDIR?.replace(/\/+$/, "");
  if (!appImage || !appDir) return { args };
  const appDirs = [appDir];
  try {
    appDirs.push(realpathSync(appDir));
  } catch {
    // The lexical spelling is all there is.
  }
  if (!appDirs.some((dir) => input.execPath.startsWith(`${dir}/`))) return { args };
  // Extract-and-run (no working FUSE): the runtime unpacked the app instead
  // of mounting it, and strips its flag before the app starts, so the new
  // process is told again through the variable the runtime also reads.
  const extractAndRun = !appDirs.some((dir) => isMountPoint(dir, input.mountInfo));
  return { execPath: appImage, args, extractAndRun };
}

/**
 * The processes the AppImage restart waits for. A mounted AppImage's
 * runtime replaced itself with the app, so this process's parent is the
 * launcher (a terminal, a file manager) and is not waited for. In
 * extract-and-run the runtime stays as the parent and removes the extracted
 * folder once the app exits, so it is waited for too.
 */
export function appImageHandoffWaitPids(extractAndRun: boolean, pid: number, ppid: number): number[] {
  return extractAndRun && ppid > 1 ? [pid, ppid] : [pid];
}

/** True when the Linux mount table lists a mount exactly at `path`; an unreadable table counts as one. */
function isMountPoint(path: string, mountInfo: (() => string) | undefined): boolean {
  let table: string;
  try {
    table = (mountInfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8")))();
  } catch {
    return true;
  }
  return table.split("\n").some((line) => {
    const point = line.split(" ")[4];
    return point !== undefined && point.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8))) === path;
  });
}

/** The marker and the temporary files its writes go through, by name. */
export const LOCAL_RESET_MARKER_FILES = /^local-reset-pending\.json(\.[0-9a-f]{16}\.tmp)?$/i;

/** A fresh, unpredictable temporary name for a marker write in the data folder. */
function markerTempPath(userDataDir: string): string {
  return join(userDataDir, `${LOCAL_RESET_MARKER}.${randomBytes(8).toString("hex")}.tmp`);
}

function isMarkerTempName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(`${LOCAL_RESET_MARKER}.`) && lower.endsWith(".tmp");
}

const DATA_FOLDER_LINK_REASON =
  "the data folder is a link, holds another mount, or could not be read in full, so emptying it could reach files elsewhere and OpenAdminOS does not empty it. Remove its files by hand, as described in Uninstall and reset";

/**
 * True when a folder path does not lead straight to a plain folder of that
 * name, so emptying it could reach files that live somewhere else:
 * - a path with "." or ".." segments, which the system may resolve through
 *   a link differently than the path reads ("link/../name");
 * - a folder that is a link, or whose real location is not its real parent
 *   plus its own name ("link/");
 * - a folder on another device than its parent, or with a folder on
 *   another device anywhere inside (a mounted volume or disk image), and on
 *   Linux a mount point at or inside it (a bind mount of a shared folder
 *   looks like a plain folder otherwise).
 * A path whose details cannot be read counts as a link; a missing one does not.
 */
export function folderGoesThroughLink(
  path: string,
  options: { platform?: NodeJS.Platform; mountInfo?: () => string } = {},
): boolean {
  if (path.split(/[\\/]+/).some((segment) => segment === "." || segment === "..")) return true;
  try {
    const absolute = resolve(path);
    if (lstatSync(absolute).isSymbolicLink()) return true;
    // The same folder as its real parent plus its own name, compared by
    // device and inode, so a letter case difference on a case-insensitive
    // volume is not mistaken for a link.
    const here = statSync(path);
    const expected = statSync(join(realpathSync(dirname(absolute)), basename(absolute)));
    if (here.dev !== expected.dev || here.ino !== expected.ino) return true;
    // A folder on another device than its parent is a mount point, such as
    // a volume or disk image mounted at the data folder path.
    if (here.dev !== statSync(dirname(realpathSync(path))).dev) return true;
    // A volume mounted anywhere inside: rmSync would empty it. Only a folder
    // has an inside; a plain file (such as a cookie store) has none.
    if (here.isDirectory() && treeCrossesDevice(path, here.dev)) return true;
    if ((options.platform ?? process.platform) === "linux" && hasMountAtOrUnder(realpathSync(path), options.mountInfo)) return true;
    return false;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/**
 * Walks the folder tree without following links and reports a folder on
 * another device: a volume or disk image mounted inside it. A folder that
 * cannot be read counts too, since what is in it cannot be ruled out. Bind
 * mounts of the same file system keep the device, which is why Linux also
 * reads the mount table.
 */
function treeCrossesDevice(root: string, device: number): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const folder = pending.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = join(folder, entry.name);
      try {
        if (lstatSync(child).dev !== device) return true;
      } catch {
        return true;
      }
      pending.push(child);
    }
  }
  return false;
}

/**
 * Linux: something is mounted at the folder or anywhere inside it. Removing
 * the folder tree would otherwise delete files on that other mount.
 */
function hasMountAtOrUnder(folder: string, mountInfo: (() => string) | undefined): boolean {
  let table: string;
  try {
    table = (mountInfo ?? (() => readFileSync("/proc/self/mountinfo", "utf8")))();
  } catch {
    // Without the mount table nothing can be ruled out.
    return true;
  }
  for (const line of table.split("\n")) {
    const point = line.split(" ")[4];
    if (!point) continue;
    const decoded = point.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (decoded === folder || decoded.startsWith(`${folder}/`)) return true;
  }
  return false;
}

/**
 * The IT policy file is kept, so it must be a plain file of its own. A link
 * may depend on something in the data folder that the reset removes, and a
 * chain of links can always be built that a check cannot follow the way the
 * system does, so any link stops the reset. A folder at that name would be
 * kept whole with whatever is in it. Checked at the request, before anything
 * changes, and again before the wipe.
 */
export function localResetPolicyProblem(userDataDir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(userDataDir);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `the data folder could not be read to check the IT policy file (${reasonOf(cause)})`;
  }
  for (const name of entries) {
    if (name.toLowerCase() !== MANAGED_POLICY_FILE) continue;
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(join(userDataDir, name));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") continue;
      return `the IT policy file ${name} could not be checked (${reasonOf(cause)})`;
    }
    if (stat.isSymbolicLink()) {
      return `the IT policy file ${name} is a link, and the reset cannot be sure that what it points to survives. Ask whoever manages this device to place the policy file itself in the data folder, or use the machine-wide policy path, then reset`;
    }
    if (stat.isDirectory()) {
      return `${name} is a folder, not the IT policy file, and the reset would keep everything in it. Move it out of the data folder, then reset`;
    }
    if (!stat.isFile()) {
      return `${name} is not a plain file. Ask whoever manages this device to place the policy file itself in the data folder, then reset`;
    }
  }
  return undefined;
}

/** The request refuses a data folder that is a link; nothing is removed. */
export function localResetDataFolderLinkMessage(): string {
  return `The reset could not start: ${DATA_FOLDER_LINK_REASON}. Nothing was removed.`;
}

// ---------------------------------------------------------------------------
// Phase 2: the wipe at launch.
// ---------------------------------------------------------------------------

export interface CommandResult {
  status: number | null;
  error?: Error;
  stdout?: string;
  stderr?: string;
}

export interface LocalResetFileSystem {
  exists(path: string): boolean;
  readdir(path: string): string[];
  readFile(path: string): string;
  /** Removes a file or folder tree; throws when it cannot. */
  remove(path: string): void;
  /** Replaces the marker atomically. */
  writeMarker(path: string, content: string): void;
  /**
   * The folder path reaches its folder through a link: the folder itself is
   * a link, or the path takes a detour such as "link/." or "link/..".
   */
  isLink(path: string): boolean;
  /**
   * Something is at the path but it is not a plain file of its own: a
   * symbolic link, a file with more than one hard link, a folder or anything
   * else, or its details cannot be read. Writing it in place, or trusting
   * its content, could reach something that lives somewhere else too.
   * A missing path is not shared.
   */
  isShared(path: string): boolean;
}

export interface LocalResetWipeOptions {
  userDataDir: string;
  /** Installed build: also the Keychain item, scheduler, caches and preferences. */
  packaged: boolean;
  platform: NodeJS.Platform;
  home: string;
  env: NodeJS.ProcessEnv;
  fs?: LocalResetFileSystem;
  run?: (file: string, args: string[]) => CommandResult;
  /** Linux mount table, for tests. */
  mountInfo?: () => string;
  /**
   * Removes the OS scheduler registration (LaunchAgent or scheduled task).
   * Installed builds only. Calls `guard` right before each removal it makes;
   * the guard throws when the data folder was replaced meanwhile.
   */
  removeScheduler?: (guard: () => void) => void;
  /** The Windows hard-link check, for tests. */
  scanSharedFiles?: typeof sharedReadOnlyFile;
  now?: () => Date;
}

const nodeFileSystem: LocalResetFileSystem = {
  isLink: (path) => folderGoesThroughLink(path),
  isShared: (path) => {
    try {
      const stat = lstatSync(path);
      return !(stat.isFile() && stat.nlink === 1);
    } catch (cause) {
      // Missing is not shared; details that cannot be read count as shared.
      return (cause as NodeJS.ErrnoException).code !== "ENOENT";
    }
  },
  exists: existsSync,
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  // maxRetries covers EBUSY and EPERM on Windows while a scanner holds a file.
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  writeMarker: (path, content) => {
    const temp = markerTempPath(dirname(path));
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeSync(fd, content);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
    } catch (cause) {
      rmSync(temp, { force: true });
      throw cause;
    }
  },
};

function runCommand(file: string, args: string[]): CommandResult {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, windowsHide: true });
  return { status: result.status, error: result.error, stdout: result.stdout, stderr: result.stderr };
}

/** True when this entry of the data folder stays through a reset. */
export function isKeptThroughReset(name: string): boolean {
  // macOS and Windows volumes usually match names without regard to case, so
  // the policy loader reads "Policy.json" through the path "policy.json".
  // Keeping every case spelling is safe on a case-sensitive volume too.
  const lower = name.toLowerCase();
  return lower === MANAGED_POLICY_FILE || lower === LOCAL_RESET_MARKER || CHROMIUM_LOCK_FILES.has(name);
}

function isAuditSideFile(name: string): boolean {
  return AUDIT_SIDE_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * The data folder entries a reset removes, in order: everything except the
 * kept files, with the audit side files last.
 */
export function localResetRemovalPlan(entries: readonly string[]): { first: string[]; last: string[] } {
  const removable = [...entries].filter((name) => !isKeptThroughReset(name)).sort();
  return {
    first: removable.filter((name) => !isAuditSideFile(name)),
    last: removable.filter(isAuditSideFile),
  };
}

/** Per-user files outside the data folder, by platform. Installed builds only. */
export function localResetLeftoverPaths(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === "darwin") {
    const library = posix.join(home, "Library");
    return [
      posix.join(library, "Caches", UPDATER_CACHE_DIR),
      posix.join(library, "Caches", MACOS_BUNDLE_ID),
      posix.join(library, "Caches", `${MACOS_BUNDLE_ID}.ShipIt`),
      posix.join(library, "HTTPStorages", MACOS_BUNDLE_ID),
      posix.join(library, "HTTPStorages", `${MACOS_BUNDLE_ID}.binarycookies`),
      posix.join(library, "Saved Application State", `${MACOS_BUNDLE_ID}.savedState`),
    ];
  }
  if (platform === "win32") {
    // The NSIS uninstaller (`nsis.deleteAppDataOnUninstall`) removes the
    // uninstalling account's %APPDATA%\OpenAdminOS, an IT policy.json there
    // included, but not this updater cache or the "OpenAdminOS Scheduler"
    // task; the reset removes both.
    const localAppData = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return [win32.join(localAppData, UPDATER_CACHE_DIR)];
  }
  const cache = env.XDG_CACHE_HOME || posix.join(home, ".cache");
  return [posix.join(cache, UPDATER_CACHE_DIR)];
}

/** Reads the marker; a marker that cannot be parsed still means a reset is pending. */
export function readLocalResetMarker(userDataDir: string, fs: LocalResetFileSystem = nodeFileSystem): LocalResetMarker | undefined {
  const path = join(userDataDir, LOCAL_RESET_MARKER);
  // Only a complete marker in a plain file OpenAdminOS wrote starts a wipe.
  // A link, a shared file or content that is not a whole reset request (for
  // example from a restored backup) stops the launch instead, with nothing
  // removed: the marker is written atomically, so it is never half written.
  if (fs.isShared(path)) return { version: 1, requestedAt: "", unusable: MARKER_SHARED_REASON };
  if (!fs.exists(path)) return undefined;
  let parsed: Partial<LocalResetMarker>;
  try {
    parsed = JSON.parse(fs.readFile(path)) as Partial<LocalResetMarker>;
  } catch {
    return { version: 1, requestedAt: "", unusable: MARKER_INVALID_REASON };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { version: 1, requestedAt: "", unusable: MARKER_INVALID_REASON };
  }
  const build = parsed.build === "installed" || parsed.build === "development" ? parsed.build : undefined;
  const folder = parsed.folder;
  if (
    !folder || typeof folder.dev !== "number" || typeof folder.ino !== "number" || typeof folder.birth !== "number"
    || parsed.version !== 1 || !build
    || typeof parsed.requestedAt !== "string" || Number.isNaN(Date.parse(parsed.requestedAt))
  ) {
    return { version: 1, requestedAt: "", unusable: MARKER_INVALID_REASON };
  }
  return {
    version: 1,
    requestedAt: parsed.requestedAt,
    build,
    folder: { dev: folder.dev, ino: folder.ino, birth: folder.birth },
    ...(parsed.leftoversDone === true ? { leftoversDone: true as const } : {}),
    ...(Array.isArray(parsed.requestWarnings)
      ? { requestWarnings: parsed.requestWarnings.filter(isProblem) }
      : {}),
  };
}

const MARKER_SHARED_REASON =
  "it is not a plain file OpenAdminOS wrote (it is a link, a shared file or a folder), so nothing was removed. Remove it from the data folder, then open OpenAdminOS again";
const MARKER_INVALID_REASON =
  "it is not a complete reset request, so nothing was removed. To keep this data, remove that file from the data folder and open OpenAdminOS again; to reset, remove it and choose Reset OpenAdminOS again";

function isProblem(value: unknown): value is LocalResetProblem {
  return typeof value === "object" && value !== null
    && typeof (value as LocalResetProblem).item === "string"
    && typeof (value as LocalResetProblem).reason === "string";
}

/**
 * Phase 2. Returns undefined when no reset is pending. Data folder entries
 * that cannot be removed leave the reset `incomplete` with the marker in
 * place; the leftovers outside the data folder are removed only once the
 * data folder is empty, and their failures are warnings that are not
 * retried, because a later retry could delete the new Keychain key.
 */
export function runPendingLocalReset(options: LocalResetWipeOptions): LocalResetReport | undefined {
  const fs = options.fs ?? nodeFileSystem;
  const run = options.run ?? runCommand;
  const { userDataDir } = options;
  const marker = readLocalResetMarker(userDataDir, fs);
  if (!marker) return undefined;
  if (marker.unusable) {
    return {
      status: "incomplete",
      finishedAt: (options.now?.() ?? new Date()).toISOString(),
      dataFolder: userDataDir,
      failed: [{ item: LOCAL_RESET_MARKER, reason: marker.unusable }],
      warnings: [],
    };
  }
  const failed: LocalResetProblem[] = [];
  const warnings: LocalResetProblem[] = [...(marker.requestWarnings ?? [])];
  const finish = (status: LocalResetReport["status"]): LocalResetReport => ({
    status,
    ...(marker.requestedAt ? { requestedAt: marker.requestedAt } : {}),
    finishedAt: (options.now?.() ?? new Date()).toISOString(),
    dataFolder: userDataDir,
    failed,
    warnings: latestPerItem(warnings),
  });

  // A development build cannot carry out the Keychain, scheduler and cache
  // cleanup an installed build asked for, so it leaves the reset to it.
  if (marker.build === "installed" && !options.packaged) {
    failed.push({
      item: "Reset requested in the installed app",
      reason: "open the installed OpenAdminOS to finish it; a development build does not remove its Keychain item, scheduler or caches",
    });
    return finish("incomplete");
  }

  // A data folder that is a link may point at a folder other things share;
  // its entries are never listed or removed through it. Folders above it
  // are not checked: whatever they resolve to, the data folder at its real
  // location is the one the app has used, and only its contents go.
  if (fs.isLink(userDataDir)) {
    failed.push({ item: userDataDir, reason: DATA_FOLDER_LINK_REASON });
    return finish("incomplete");
  }
  // The request was accepted for this very folder: a copy restored or
  // roamed to another device carries the marker but not the identity.
  const identity = localResetFolderIdentity(userDataDir);
  if (!identity || !marker.folder || !markerFolderMatches(marker.folder, identity, options.platform)) {
    failed.push({ item: LOCAL_RESET_MARKER, reason: MARKER_OTHER_FOLDER_REASON });
    return finish("incomplete");
  }
  // The folder checked here is the one removed from and written to: if it
  // is swapped for another (a link to another profile) while the wipe runs,
  // the wipe stops before its next removal or write. A cheap check of the
  // folder itself; the full walk for mounts ran once above.
  const sameFolder = () => {
    const now = localResetFolderIdentity(userDataDir);
    return now !== undefined && sameSessionFolder(identity, now) && !isSymbolicLink(userDataDir);
  };
  // On Windows a hard link shares its attributes with every other link to
  // the file, and removing a read-only file clears the attribute first, so
  // a backup's copy would become writable too: such an entry stays.
  // The check can take seconds on redirected storage, so the data folder
  // and the entry itself are checked again right before the removal; if
  // either was replaced meanwhile, the wipe stops.
  const scanShared = options.scanSharedFiles ?? sharedReadOnlyFile;
  // On Linux a bind mount looks like a plain folder: the mount table is
  // read again before every removal, so a mount added under the data folder
  // while the wipe runs (by a mount service, for example) is never removed
  // through. The full walk ran once above.
  let realDataFolder = userDataDir;
  try {
    realDataFolder = realpathSync(userDataDir);
  } catch {
    // The identity checks stop the wipe if the folder is gone.
  }
  let folderChanged = false;
  const removeHere = (name: string): boolean => {
    if (options.platform === "linux" && hasMountAtOrUnder(realDataFolder, options.mountInfo)) {
      failed.push({ item: userDataDir, reason: MOUNT_APPEARED_REASON });
      folderChanged = true;
      return false;
    }
    if (options.platform === "win32") {
      const path = join(userDataDir, name);
      const before = entryIdentity(path);
      const shared = scanShared(path, name);
      if (shared !== undefined) {
        failed.push({ item: name, reason: sharedReadOnlyReason(shared, name) });
        return false;
      }
      if (!sameFolder() || !sameEntry(before, entryIdentity(path))) {
        failed.push({ item: userDataDir, reason: DATA_FOLDER_CHANGED_REASON });
        folderChanged = true;
        return false;
      }
    }
    return removeEntry(fs, userDataDir, name, failed);
  };
  const removeIfSameFolder = (name: string): boolean => {
    if (!sameFolder()) {
      failed.push({ item: userDataDir, reason: DATA_FOLDER_CHANGED_REASON });
      return false;
    }
    return removeHere(name);
  };
  const policyProblem = localResetPolicyProblem(userDataDir);
  if (policyProblem) {
    failed.push({ item: MANAGED_POLICY_FILE, reason: policyProblem });
    return finish("incomplete");
  }

  let entries: string[];
  try {
    entries = fs.readdir(userDataDir);
  } catch (cause) {
    failed.push({ item: userDataDir, reason: reasonOf(cause) });
    return finish("incomplete");
  }
  const plan = localResetRemovalPlan(entries);
  // An entry that could not be removed keeps the files that belong to it
  // (a locked openadminos.db its -wal and -shm), whatever sorts between
  // them, so the next try finds an intact database; everything else still
  // goes, the token files included. The audit side files stay while
  // anything else does, so a database left behind keeps its anchor too.
  const notRemoved: string[] = [];
  for (const name of plan.first) {
    const owner = notRemoved.find((kept) => name.startsWith(`${kept}-`));
    if (owner !== undefined) {
      failed.push({ item: name, reason: `kept with ${owner}, which could not be removed` });
      continue;
    }
    if (!sameFolder()) {
      failed.push({ item: userDataDir, reason: DATA_FOLDER_CHANGED_REASON });
      break;
    }
    if (removeHere(name)) continue;
    if (folderChanged) break;
    notRemoved.push(name);
  }
  if (failed.length > 0) return finish("incomplete");
  for (const name of plan.last) if (!removeIfSameFolder(name)) break;
  if (failed.length > 0) return finish("incomplete");
  if (!sameFolder()) {
    failed.push({ item: userDataDir, reason: DATA_FOLDER_CHANGED_REASON });
    return finish("incomplete");
  }
  // A process left from the last session could have written something since
  // the folder was listed; the reset is done only when nothing but the kept
  // files is left. Checked before the cleanup outside the folder and again
  // right before the marker goes.
  checkFolderEmpty(fs, userDataDir, failed, removeIfSameFolder);
  if (failed.length > 0) return finish("incomplete");

  if (options.packaged && marker.build === "installed") {
    if (!marker.leftoversDone) {
      // Checked before every step outside the folder, each Keychain
      // deletion included: a profile restored while one runs, whether it
      // replaces the folder or puts files back into it, keeps its Keychain
      // key and its caches. Files that came back are listed; the next try
      // removes them first, then the key.
      const guard = () => {
        if (!sameFolder()) throw new FolderChangedDuringReset([{ item: userDataDir, reason: DATA_FOLDER_CHANGED_REASON }]);
        const appeared: LocalResetProblem[] = [];
        checkFolderEmpty(fs, userDataDir, appeared, () => true);
        if (appeared.length > 0) throw new FolderChangedDuringReset(appeared);
        // Again after the listing: a folder swapped in while it ran would
        // otherwise pass with the old folder's contents.
        if (!sameFolder()) throw new FolderChangedDuringReset([{ item: userDataDir, reason: DATA_FOLDER_CHANGED_REASON }]);
      };
      try {
        removeLeftovers(options, fs, run, warnings, guard);
        // Once more after the last step: files that came back during it
        // leave the cleanup unrecorded, so the next try repeats all of it.
        guard();
      } catch (cause) {
        if (!(cause instanceof FolderChangedDuringReset)) throw cause;
        failed.push(...cause.problems);
        return finish("incomplete");
      }
      // Recorded before the marker goes, so a marker that cannot be removed
      // never makes a later launch remove a Keychain item made since.
      recordLeftoversDone(fs, userDataDir, marker, warnings);
    }
  } else if (options.packaged) {
    warnings.push({
      item: "Keychain item, background scheduler and cached updates",
      reason: "not removed, because the reset was requested in a development build",
    });
  }

  checkFolderEmpty(fs, userDataDir, failed, removeIfSameFolder);
  if (failed.length > 0) return finish("incomplete");
  if (!sameFolder()) {
    failed.push({ item: userDataDir, reason: DATA_FOLDER_CHANGED_REASON });
    return finish("incomplete");
  }
  try {
    fs.remove(join(userDataDir, LOCAL_RESET_MARKER));
  } catch (cause) {
    failed.push({ item: LOCAL_RESET_MARKER, reason: reasonOf(cause) });
    return finish("incomplete");
  }
  return finish("completed");
}

const MARKER_OTHER_FOLDER_REASON =
  "it was written for this data folder on another device, or before the folder was copied or restored here, so nothing was removed. To keep this data, remove that file from the data folder and open OpenAdminOS again; to reset here, remove it and choose Reset OpenAdminOS again";

const MOUNT_APPEARED_REASON =
  "a mount appeared at or inside the data folder while the reset ran, so nothing more was removed there. Unmount it, then open OpenAdminOS again";

const DATA_FOLDER_CHANGED_REASON =
  "the data folder was replaced by another folder or a link while the reset ran, so nothing more was written or removed there. Check the folder, then open OpenAdminOS again";

/** Which folder this is: device, inode and birth time from lstat. */
export interface LocalResetFolderIdentity {
  dev: number;
  ino: number;
  birth: number;
}

/**
 * The folder's identity, or undefined when it cannot be read or the file
 * system gives no way to tell folders apart (no inode and no birth time),
 * which fails safe: no marker is written and none is trusted.
 */
export function localResetFolderIdentity(path: string): LocalResetFolderIdentity | undefined {
  try {
    return identityFromStat(lstatSync(path));
  } catch {
    return undefined;
  }
}

/**
 * Where statx is blocked, Node reports the change time as the birth time,
 * and that changes when the marker is written: a birth time equal to the
 * change time counts as unknown. A data folder in use has been changed
 * since it was created, so a real birth time differs from it.
 */
export function identityFromStat(stat: { dev: number; ino: number; birthtimeMs: number; ctimeMs: number }): LocalResetFolderIdentity | undefined {
  const birth = stat.birthtimeMs === stat.ctimeMs ? 0 : stat.birthtimeMs;
  if (stat.ino === 0 && birth === 0) return undefined;
  return { dev: stat.dev, ino: stat.ino, birth };
}

/** Within one session: the same device and inode (and birth time where known). */
export function sameSessionFolder(a: LocalResetFolderIdentity, b: LocalResetFolderIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino && (a.birth === 0 || b.birth === 0 || a.birth === b.birth);
}

/**
 * Across a restart: the device number can change with a reboot or a
 * remount (network homes, autofs), so on macOS and Windows it is compared
 * only where no birth time is known. A copy restored or roamed elsewhere
 * gets a new inode and a new birth time. On Linux the device must always
 * match: a Btrfs snapshot restored as the home keeps the inode and birth
 * time of every folder in it, and only the device number tells it apart.
 * A mismatch stops the reset with nothing removed.
 */
export function markerFolderMatches(
  stored: LocalResetFolderIdentity,
  now: LocalResetFolderIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "linux" && stored.dev !== now.dev) return false;
  const birthKnown = stored.birth !== 0 && now.birth !== 0;
  if (stored.ino === 0 || now.ino === 0) return birthKnown && stored.birth === now.birth;
  if (stored.ino !== now.ino) return false;
  // Without a birth time the inode alone could match a copy elsewhere, so
  // the device must match too; after a remount that stops the reset with
  // nothing removed, which is the safe side.
  return birthKnown ? stored.birth === now.birth : stored.dev === now.dev;
}

function isSymbolicLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
}

function checkFolderEmpty(
  fs: LocalResetFileSystem,
  dir: string,
  failed: LocalResetProblem[],
  removeChecked: (name: string) => boolean,
): void {
  try {
    for (const name of fs.readdir(dir)) {
      // The marker's own temporary file is part of the reset, not left data.
      if (isMarkerTempName(name)) {
        if (!removeChecked(name)) return;
        continue;
      }
      if (!isKeptThroughReset(name)) failed.push({ item: name, reason: "it was created again during the reset" });
    }
  } catch (cause) {
    failed.push({ item: dir, reason: reasonOf(cause) });
  }
}

/** A step tried in the request and again at launch is reported once, with its latest reason. */
function latestPerItem(problems: readonly LocalResetProblem[]): LocalResetProblem[] {
  const byItem = new Map<string, LocalResetProblem>();
  for (const problem of problems) {
    byItem.delete(problem.item);
    byItem.set(problem.item, problem);
  }
  return [...byItem.values()];
}

/**
 * Windows only. The first read-only file with more than one hard link at or
 * inside a path (named from `label`, with Windows separators), without
 * following links; undefined when there is none or the path is gone. A
 * folder that cannot be listed is returned as well: what is inside is
 * unknown, and the removal would make its files writable to delete them.
 */
export function sharedReadOnlyFile(path: string, label: string): { item: string; unlisted?: true } | undefined {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (stat.isFile()) return stat.nlink > 1 && (stat.mode & 0o200) === 0 ? { item: label } : undefined;
  if (!stat.isDirectory()) return undefined;
  let children: string[];
  try {
    children = readdirSync(path);
  } catch {
    return { item: label, unlisted: true };
  }
  for (const child of children) {
    const found = sharedReadOnlyFile(join(path, child), `${label}\\${child}`);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The identity of a path itself (a link is not followed), with its birth
 * time where known: "gone" when nothing is there, "unknown" when it has
 * neither inode nor birth time, which never counts as unchanged.
 */
function entryIdentity(path: string): LocalResetFolderIdentity | "gone" | "unknown" {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown";
  }
  return identityFromStat(stat) ?? "unknown";
}

function sameEntry(a: ReturnType<typeof entryIdentity>, b: ReturnType<typeof entryIdentity>): boolean {
  if (a === "unknown" || b === "unknown") return false;
  if (a === "gone" || b === "gone") return a === b;
  return sameSessionFolder(a, b);
}

function sharedReadOnlyReason(shared: { item: string; unlisted?: true }, name: string): string {
  const what = shared.item === name ? "it" : shared.item;
  if (shared.unlisted) {
    return `${what} could not be listed, so it could not be checked for files also linked from another place. Make it readable, or remove it by hand`;
  }
  return `${what} is read-only and also linked from another place, such as a backup; removing it would make that copy writable too. Remove the other link first, or remove it by hand`;
}

function removeEntry(fs: LocalResetFileSystem, dir: string, name: string, failed: LocalResetProblem[]): boolean {
  try {
    fs.remove(join(dir, name));
    return true;
  } catch (cause) {
    failed.push({ item: name, reason: reasonOf(cause) });
    return false;
  }
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The data folder was replaced, or files came back into it, while the cleanup outside it ran. */
class FolderChangedDuringReset extends Error {
  constructor(readonly problems: LocalResetProblem[]) {
    super("the data folder changed during the reset");
  }
}

function removeLeftovers(
  options: LocalResetWipeOptions,
  fs: LocalResetFileSystem,
  run: (file: string, args: string[]) => CommandResult,
  warnings: LocalResetProblem[],
  /** Throws FolderChangedDuringReset when the data folder is no longer the one being reset. */
  guard: () => void,
): void {
  guard();
  try {
    options.removeScheduler?.(guard);
    // Removed now: a warning from the request about it no longer holds.
    if (options.removeScheduler) {
      for (let index = warnings.length - 1; index >= 0; index -= 1) {
        if (warnings[index]!.item === "Background scheduler") warnings.splice(index, 1);
      }
    }
  } catch (cause) {
    if (cause instanceof FolderChangedDuringReset) throw cause;
    warnings.push({ item: "Background scheduler", reason: reasonOf(cause) });
  }
  if (options.platform === "darwin") {
    removeMacosKeychainItem(run, macosLoginKeychain(options.home), warnings, guard);
    // Preferences go through cfprefsd, which caches the plist; deleting the
    // file alone could be written back. A missing domain exits 1.
    guard();
    const prefs = run("/usr/bin/defaults", ["delete", MACOS_BUNDLE_ID]);
    if (prefs.error) {
      warnings.push({ item: `Preferences (${MACOS_BUNDLE_ID})`, reason: reasonOf(prefs.error) });
    } else if (prefs.status !== 0) {
      // A missing domain also exits non-zero; only a domain still readable
      // is a failure.
      const left = run("/usr/bin/defaults", ["read", MACOS_BUNDLE_ID]);
      if (left.status === 0) warnings.push({ item: `Preferences (${MACOS_BUNDLE_ID})`, reason: "they are still there after defaults delete" });
      else if (left.error || left.status === null) warnings.push({ item: `Preferences (${MACOS_BUNDLE_ID})`, reason: "their removal could not be confirmed" });
    }
  }
  for (const path of localResetLeftoverPaths(options.platform, options.home, options.env)) {
    // A cache folder that is a link or holds a mount is left alone. Folders
    // above it resolve to wherever the app keeps its cache, so they are not
    // checked: only this OpenAdminOS folder goes. Its identity is taken
    // before every check and compared after the last one, right before the
    // removal, so a folder swapped in during a check is never removed.
    const before = entryIdentity(path);
    const linkReason = "it is a link or holds another mount, so it was left in place";
    if (folderGoesThroughLink(path, { platform: options.platform, mountInfo: options.mountInfo })) {
      if (fs.exists(path)) warnings.push({ item: path, reason: linkReason });
      continue;
    }
    if (options.platform === "win32") {
      const shared = (options.scanSharedFiles ?? sharedReadOnlyFile)(path, basename(path));
      if (shared !== undefined) {
        warnings.push({ item: path, reason: sharedReadOnlyReason(shared, basename(path)) });
        continue;
      }
      // The scan can take seconds: the link and mount walk runs again.
      if (folderGoesThroughLink(path, { platform: options.platform, mountInfo: options.mountInfo })) {
        warnings.push({ item: path, reason: linkReason });
        continue;
      }
    }
    guard();
    // On Linux a bind mount added inside the cache since its walk is never
    // removed through, as in the data folder.
    if (options.platform === "linux" && hasMountAtOrUnder(realpathOr(path), options.mountInfo)) {
      warnings.push({ item: path, reason: linkReason });
      continue;
    }
    // The last check before the removal: the guard lists the data folder,
    // which can take a while on redirected storage.
    const after = entryIdentity(path);
    if (!sameEntry(before, after)) {
      warnings.push({
        item: path,
        reason: before === "unknown" || after === "unknown"
          ? "it cannot be told apart from another item on this disk, so it was left in place"
          : "it was replaced while it was being checked, so it was left in place",
      });
      continue;
    }
    try {
      fs.remove(path);
    } catch (cause) {
      warnings.push({ item: path, reason: reasonOf(cause) });
    }
  }
}

/**
 * Records that the cleanup outside the data folder ran, with its warnings,
 * so a resumed wipe neither repeats it nor loses what it could not remove.
 */
function recordLeftoversDone(
  fs: LocalResetFileSystem,
  userDataDir: string,
  marker: LocalResetMarker,
  warnings: LocalResetProblem[],
): void {
  // The list is written even when empty, so a warning that cleared at launch
  // does not come back with a resumed wipe.
  const next: LocalResetMarker = { ...marker, leftoversDone: true, requestWarnings: [...warnings] };
  try {
    fs.writeMarker(join(userDataDir, LOCAL_RESET_MARKER), `${JSON.stringify(next, null, 2)}\n`);
  } catch (cause) {
    console.warn(`[local-reset] could not record that the cleanup outside the data folder ran: ${reasonOf(cause)}`);
    warnings.push({
      item: "Reset progress",
      reason: `could not be recorded (${reasonOf(cause)}). If the reset has to resume, it removes the Keychain item and caches again`,
    });
  }
}

/**
 * The Windows task name is the same for every account on the machine, so an
 * elevated reset must not remove another account's task. The default
 * install is per user, under the profile, so only a task whose program lies
 * under this account's profile counts as this account's. A copy installed
 * for all users (Program Files) or elsewhere could be shared, so its task is
 * left in place with a warning, even when it runs this same program.
 */
export function windowsTaskBelongsToThisAccount(
  taskBinary: string | undefined,
  home: string,
  principal?: { taskUserId: string | undefined; account: { name: string; sid: string } | undefined },
): boolean {
  if (!taskBinary) return false;
  // The task must also run as this account: a task of a service account can
  // point at a program in anyone's profile. Unknown on either side: not ours.
  if (principal) {
    const { taskUserId, account } = principal;
    if (!taskUserId || !account) return false;
    const id = taskUserId.trim().toLowerCase();
    const name = account.name.toLowerCase();
    const bareName = name.includes("\\") ? name.slice(name.lastIndexOf("\\") + 1) : name;
    if (id !== account.sid.toLowerCase() && id !== name && id !== bareName) return false;
  }
  const binary = win32.normalize(taskBinary).toLowerCase();
  const homePrefix = `${win32.normalize(home).toLowerCase().replace(/\\+$/, "")}\\`;
  return binary.startsWith(homePrefix);
}

/** Whether `schtasks /Query /FO CSV /NH` lists a task of this name in the root folder. */
export function windowsTaskListHas(csv: string, taskName: string): boolean {
  const wanted = `"\\${taskName}"`.toLowerCase();
  return csv.split(/\r?\n/).some((line) => line.trim().toLowerCase().startsWith(wanted + ","));
}

/** The account a Windows task runs as, from its XML definition (`<Principal><UserId>`). */
export function windowsTaskUserId(xml: string | undefined): string | undefined {
  if (!xml) return undefined;
  const match = /<Principal\b[^>]*>[\s\S]*?<UserId>([^<]+)<\/UserId>/i.exec(xml);
  return match?.[1]?.trim() || undefined;
}

/** Parses `whoami /user /fo csv /nh`: "domain\\name","S-1-5-...". */
export function parseWhoamiUser(output: string): { name: string; sid: string } | undefined {
  const match = /^"([^"]+)","(S-[0-9-]+)"/m.exec(output.trim());
  return match ? { name: match[1]!, sid: match[2]! } : undefined;
}

/** `security` exits 44 when no item matches. */
const SECURITY_ITEM_NOT_FOUND = 44;

/** The keychain Electron's safeStorage writes its key to: the user's login keychain. */
export function macosLoginKeychain(home: string): string {
  return posix.join(home, "Library", "Keychains", "login.keychain-db");
}

/**
 * Deletes the safeStorage Keychain item, matched by its exact service and
 * account and only in the login keychain, so an item of another app or
 * account, or one in a keychain imported from another Mac, is never
 * touched. Then every other keychain in the user's search list is looked up
 * on its own (attributes only, never the secret), and each one that holds
 * an item of that name gets its own warning: safeStorage creates its key in
 * the default keychain, which an admin may have set to another one, and
 * only the admin can tell whether it is this install's key.
 */
function removeMacosKeychainItem(
  run: (file: string, args: string[]) => CommandResult,
  keychain: string,
  warnings: LocalResetProblem[],
  guard: () => void = () => undefined,
): void {
  const item = `Keychain item "${MACOS_SAFE_STORAGE_SERVICE}"`;
  removeFromLoginKeychain(run, keychain, item, warnings, guard);
  const list = run("/usr/bin/security", ["list-keychains", "-d", "user"]);
  if (list.error || list.status !== 0) {
    warnings.push({ item: `${item} in other keychains`, reason: "not checked, because the keychain search list could not be read" });
    return;
  }
  for (const other of parseKeychainList(list.stdout ?? "")) {
    if (sameKeychainFile(other, keychain)) continue;
    const lookup = run("/usr/bin/security", ["find-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, other]);
    if (lookup.status === SECURITY_ITEM_NOT_FOUND) continue;
    warnings.push({
      item: `${item} in ${other}`,
      reason: lookup.status === 0
        ? "not removed: the reset removes it from the login keychain only. If OpenAdminOS used this keychain, remove the item there with Keychain Access"
        : "this keychain could not be checked for it",
    });
  }
}

/**
 * The same keychain file however its path is spelled (a linked home, letter
 * case on a case-insensitive volume); by name, ignoring case, when either
 * cannot be read.
 */
function sameKeychainFile(a: string, b: string): boolean {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** Parses `security list-keychains`: one quoted path per line. */
export function parseKeychainList(output: string): string[] {
  return [...output.matchAll(/^\s*"(.+)"\s*$/gm)].map((match) => match[1]!);
}

function removeFromLoginKeychain(
  run: (file: string, args: string[]) => CommandResult,
  keychain: string,
  item: string,
  warnings: LocalResetProblem[],
  guard: () => void,
): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    guard();
    const result = run("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      MACOS_SAFE_STORAGE_SERVICE,
      "-a",
      MACOS_SAFE_STORAGE_ACCOUNT,
      keychain,
    ]);
    if (result.error) {
      warnings.push({ item, reason: reasonOf(result.error) });
      return;
    }
    if (result.status === SECURITY_ITEM_NOT_FOUND) return;
    if (result.status !== 0) {
      warnings.push({ item, reason: `security exited with code ${result.status ?? "unknown"}` });
      return;
    }
  }
  // Five removed: a lookup (attributes only, never the secret) says whether more are left.
  const lookup = run("/usr/bin/security", ["find-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT, keychain]);
  if (lookup.status !== SECURITY_ITEM_NOT_FOUND) {
    warnings.push({ item, reason: lookup.status === 0 ? "more items with this name are still in the Keychain" : "the Keychain did not confirm that none are left" });
  }
}

/** File system codes in plain words. The item already names the path, so reasons never repeat it. */
const FILE_ERROR_REASONS: Record<string, string> = {
  EBUSY: "the file is in use by another program or cannot be changed",
  EPERM: "the file is in use by another program or cannot be changed",
  EACCES: "this account is not allowed to remove it",
  ENOTEMPTY: "something inside it could not be removed",
  EROFS: "the disk is read-only",
};

function reasonOf(cause: unknown): string {
  const code = cause && typeof cause === "object" && "code" in cause ? (cause as NodeJS.ErrnoException).code : undefined;
  if (code) return FILE_ERROR_REASONS[code] ?? `it could not be removed (${code})`;
  return cause instanceof Error ? cause.message : String(cause);
}
