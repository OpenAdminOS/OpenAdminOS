/**
 * Full local reset ("Reset OpenAdminOS" in Settings > Data).
 *
 * Two phases, so nothing is deleted while Chromium, SQLite or MSAL still
 * hold files in the data folder:
 *
 * 1. `requestLocalReset` (running app): checks the typed phrase, writes a
 *    pending-reset marker into the data folder, signs out of every tenant,
 *    turns off the OS scheduler and the login item. The caller then stops
 *    the stores and relaunches.
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
  /** Removes the Microsoft sign-in of every tenant; returns what could not be removed. */
  forgetSignIns(): Promise<LocalResetProblem[]>;
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
  const warnings: LocalResetProblem[] = [];
  try {
    warnings.push(...(await steps.forgetSignIns()));
  } catch (cause) {
    warnings.push({ item: "Microsoft sign-ins", reason: `${reasonOf(cause)}. The token files are deleted with the data folder.` });
  }
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
  options: { syncDirectory?: (path: string) => Promise<void> } = {},
): Promise<void> {
  const path = join(userDataDir, LOCAL_RESET_MARKER);
  const temp = markerTempPath(userDataDir);
  try {
    // "wx" creates a new file and fails on anything already there, a link
    // included, so a planted link can never redirect the write.
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw cause;
  }
  try {
    await (options.syncDirectory ?? syncDirectory)(userDataDir);
  } catch (cause) {
    console.warn(`[local-reset] the marker is in place but the data folder could not be flushed: ${reasonOf(cause)}`);
  }
}

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
 * Links in the data folder the reset must not write or delete through: the
 * folder itself, and token cache files, which sign-out would rewrite.
 */
export function localResetLinkCheck(userDataDir: string, fs: Pick<LocalResetFileSystem, "isLink" | "isShared" | "readdir"> = nodeFileSystem): {
  dataFolderIsLink: boolean;
  linkedTokenCaches: string[];
  /** The folder could not be listed, so its token caches could not be checked. */
  scanFailed: boolean;
} {
  if (fs.isLink(userDataDir)) return { dataFolderIsLink: true, linkedTokenCaches: [], scanFailed: false };
  let entries: string[];
  try {
    entries = fs.readdir(userDataDir);
  } catch {
    return { dataFolderIsLink: false, linkedTokenCaches: [], scanFailed: true };
  }
  return {
    dataFolderIsLink: false,
    linkedTokenCaches: entries.filter((name) => /^tokens.*\.bin$/i.test(name) && fs.isShared(join(userDataDir, name))),
    scanFailed: false,
  };
}

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
    // A volume mounted anywhere inside: rmSync would empty it.
    if (treeCrossesDevice(path, here.dev)) return true;
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
  /** Removes the OS scheduler registration (LaunchAgent or scheduled task). Installed builds only. */
  removeScheduler?: () => void;
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
  return { status: result.status, error: result.error, stderr: result.stderr };
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
    // TODO(ugur): should the Windows uninstaller remove local data? The
    // package.json `nsis.deleteAppDataOnUninstall` stays false. In
    // electron-builder 26.15 it applies to the assisted installer too
    // (uninstaller.nsh checks it outside any one-click guard) and never on an
    // update (the installer runs the old uninstaller with --updated). But it
    // deletes the whole %APPDATA%\OpenAdminOS folder, including an IT
    // policy.json, also on a silent /S uninstall by IT, and leaves this
    // updater cache and the "OpenAdminOS Scheduler" task. Options: keep it
    // off and point to Reset OpenAdminOS (current), or turn it on with a
    // customUnInit include that keeps policy.json and removes the task.
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
  if (
    parsed.version !== 1 || !build
    || typeof parsed.requestedAt !== "string" || Number.isNaN(Date.parse(parsed.requestedAt))
  ) {
    return { version: 1, requestedAt: "", unusable: MARKER_INVALID_REASON };
  }
  return {
    version: 1,
    requestedAt: parsed.requestedAt,
    build,
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
  // its entries are never listed or removed through it.
  if (fs.isLink(userDataDir)) {
    failed.push({ item: userDataDir, reason: DATA_FOLDER_LINK_REASON });
    return finish("incomplete");
  }
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
  for (const name of plan.first) removeEntry(fs, userDataDir, name, failed);
  // The audit side files stay while anything else does, so a database that
  // could not be removed keeps its anchor and reads as intact next time.
  if (failed.length > 0) return finish("incomplete");
  for (const name of plan.last) removeEntry(fs, userDataDir, name, failed);
  if (failed.length > 0) return finish("incomplete");
  // A process left from the last session could have written something since
  // the folder was listed; the reset is done only when nothing but the kept
  // files is left. Checked before the cleanup outside the folder and again
  // right before the marker goes.
  checkFolderEmpty(fs, userDataDir, failed);
  if (failed.length > 0) return finish("incomplete");

  if (options.packaged && marker.build === "installed") {
    if (!marker.leftoversDone) {
      removeLeftovers(options, fs, run, warnings);
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

  checkFolderEmpty(fs, userDataDir, failed);
  if (failed.length > 0) return finish("incomplete");
  try {
    fs.remove(join(userDataDir, LOCAL_RESET_MARKER));
  } catch (cause) {
    failed.push({ item: LOCAL_RESET_MARKER, reason: reasonOf(cause) });
    return finish("incomplete");
  }
  return finish("completed");
}

function checkFolderEmpty(fs: LocalResetFileSystem, dir: string, failed: LocalResetProblem[]): void {
  try {
    for (const name of fs.readdir(dir)) {
      // The marker's own temporary file is part of the reset, not left data.
      if (isMarkerTempName(name)) {
        removeEntry(fs, dir, name, failed);
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

function removeEntry(fs: LocalResetFileSystem, dir: string, name: string, failed: LocalResetProblem[]): void {
  try {
    fs.remove(join(dir, name));
  } catch (cause) {
    failed.push({ item: name, reason: reasonOf(cause) });
  }
}

function removeLeftovers(
  options: LocalResetWipeOptions,
  fs: LocalResetFileSystem,
  run: (file: string, args: string[]) => CommandResult,
  warnings: LocalResetProblem[],
): void {
  try {
    options.removeScheduler?.();
    // Removed now: a warning from the request about it no longer holds.
    if (options.removeScheduler) {
      for (let index = warnings.length - 1; index >= 0; index -= 1) {
        if (warnings[index]!.item === "Background scheduler") warnings.splice(index, 1);
      }
    }
  } catch (cause) {
    warnings.push({ item: "Background scheduler", reason: reasonOf(cause) });
  }
  if (options.platform === "darwin") {
    removeMacosKeychainItem(run, warnings);
    // Preferences go through cfprefsd, which caches the plist; deleting the
    // file alone could be written back. A missing domain exits 1.
    const prefs = run("/usr/bin/defaults", ["delete", MACOS_BUNDLE_ID]);
    if (prefs.error) warnings.push({ item: `Preferences (${MACOS_BUNDLE_ID})`, reason: reasonOf(prefs.error) });
  }
  for (const path of localResetLeftoverPaths(options.platform, options.home, options.env)) {
    // A cache folder that is a link or holds a mount is left alone.
    if (folderGoesThroughLink(path, { platform: options.platform, mountInfo: options.mountInfo })) {
      if (fs.exists(path)) warnings.push({ item: path, reason: "it is a link or holds another mount, so it was left in place" });
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
export function windowsTaskBelongsToThisAccount(taskBinary: string | undefined, home: string): boolean {
  if (!taskBinary) return false;
  const binary = win32.normalize(taskBinary).toLowerCase();
  const homePrefix = `${win32.normalize(home).toLowerCase().replace(/\\+$/, "")}\\`;
  return binary.startsWith(homePrefix);
}

/** `security` exits 44 when no item matches. */
const SECURITY_ITEM_NOT_FOUND = 44;

/**
 * Deletes the safeStorage Keychain item, matched by its exact service and
 * account, so an item of another app or account is never touched. Each
 * call deletes one match.
 */
function removeMacosKeychainItem(run: (file: string, args: string[]) => CommandResult, warnings: LocalResetProblem[]): void {
  const item = `Keychain item "${MACOS_SAFE_STORAGE_SERVICE}"`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = run("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      MACOS_SAFE_STORAGE_SERVICE,
      "-a",
      MACOS_SAFE_STORAGE_ACCOUNT,
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
  const lookup = run("/usr/bin/security", ["find-generic-password", "-s", MACOS_SAFE_STORAGE_SERVICE, "-a", MACOS_SAFE_STORAGE_ACCOUNT]);
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
