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
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

import type { LocalResetProblem, LocalResetReport } from "@openadminos/agent-sdk";

import { LOCAL_RESET_PHRASE } from "../src/shared/local-reset.js";
import { syncDirectory, writeFileDurably } from "./durable-file.js";

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
  const temp = `${path}.tmp`;
  await writeFileDurably(temp, `${JSON.stringify(marker, null, 2)}\n`, { durable: true });
  await rename(temp, path);
  try {
    await (options.syncDirectory ?? syncDirectory)(userDataDir);
  } catch (cause) {
    console.warn(`[local-reset] the marker is in place but the data folder could not be flushed: ${reasonOf(cause)}`);
  }
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
  /** Removes the OS scheduler registration (LaunchAgent or scheduled task). Installed builds only. */
  removeScheduler?: () => void;
  now?: () => Date;
}

const nodeFileSystem: LocalResetFileSystem = {
  exists: existsSync,
  readdir: (path) => readdirSync(path),
  readFile: (path) => readFileSync(path, "utf8"),
  // maxRetries covers EBUSY and EPERM on Windows while a scanner holds a file.
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  writeMarker: (path, content) => {
    writeFileSync(`${path}.tmp`, content, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
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
  if (!fs.exists(path)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFile(path)) as Partial<LocalResetMarker>;
    return {
      version: 1,
      requestedAt: typeof parsed.requestedAt === "string" ? parsed.requestedAt : "",
      ...(parsed.build === "installed" || parsed.build === "development" ? { build: parsed.build } : {}),
      ...(parsed.leftoversDone === true ? { leftoversDone: true as const } : {}),
      ...(Array.isArray(parsed.requestWarnings)
        ? { requestWarnings: parsed.requestWarnings.filter(isProblem) }
        : {}),
    };
  } catch {
    return { version: 1, requestedAt: "" };
  }
}

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
  const failed: LocalResetProblem[] = [];
  const warnings: LocalResetProblem[] = [...(marker.requestWarnings ?? [])];
  const finish = (status: LocalResetReport["status"]): LocalResetReport => ({
    status,
    ...(marker.requestedAt ? { requestedAt: marker.requestedAt } : {}),
    finishedAt: (options.now?.() ?? new Date()).toISOString(),
    dataFolder: userDataDir,
    failed,
    warnings,
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
  // files is left.
  try {
    for (const name of fs.readdir(userDataDir)) {
      if (!isKeptThroughReset(name)) failed.push({ item: name, reason: "it was created again during the reset" });
    }
  } catch (cause) {
    failed.push({ item: userDataDir, reason: reasonOf(cause) });
  }
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
      reason: marker.build === "development"
        ? "not removed, because the reset was requested in a development build"
        : "not removed, because the reset request could not be read",
    });
  }

  try {
    fs.remove(join(userDataDir, LOCAL_RESET_MARKER));
  } catch (cause) {
    failed.push({ item: LOCAL_RESET_MARKER, reason: reasonOf(cause) });
    return finish("incomplete");
  }
  return finish("completed");
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
  const next: LocalResetMarker = { ...marker, leftoversDone: true, ...(warnings.length > 0 ? { requestWarnings: [...warnings] } : {}) };
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
  warnings.push({ item, reason: "more items with this name are still in the Keychain" });
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
