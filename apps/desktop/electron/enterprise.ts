// Loads the optional team features module in the main process.
//
// Resolution: with a valid licence, the loader resolves
// `ENTERPRISE_MODULE_SPECIFIER` from the app's own node_modules. Builds
// from this repository never contain that package, so they use the no-op
// default module from `@openadminos/enterprise`. Only the official release
// job adds the package (see packages/enterprise/README.md).
//
// Without a valid licence the loader stops before resolving or importing
// anything: no module code runs, and no IPC handler, listener, timer or
// socket is created. A module built for another interface version is not
// activated (`EnterpriseInterfaceVersionError`, logged) and the app keeps
// working without team features. The version is read from the export, so
// the module has been imported and its top-level code has run by then.

import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ENTERPRISE_INTERFACE_VERSION,
  ENTERPRISE_LIMITS,
  EnterpriseInterfaceVersionError,
  createEnterpriseHost,
  defaultEnterpriseModule,
  entitlementAt,
  isEnterpriseModule,
  LICENCE_LIMITS,
  verifyLicence,
  type EnterpriseHandle,
  type EnterpriseHostController,
  type EnterpriseIpcRegistrar,
  type EnterpriseLogSink,
  type EnterpriseModule,
  type EnterpriseStorageBackend,
  type LicenceFailureReason,
} from "@openadminos/enterprise";

import type { EnterpriseProblem, EnterpriseProblemReason, EnterpriseStatus } from "@openadminos/agent-sdk";

import { atomicRename } from "./atomic-rename.js";
import { writeFileDurably } from "./durable-file.js";

// TODO(ugur): confirm the package name the release job installs for the
// private module.
export const ENTERPRISE_MODULE_SPECIFIER = "@openadminos/enterprise-module";

// TODO(ugur): how a licence reaches this file (pasted in Settings, written
// at team join, or deployed by MDM) is not decided; today the app only reads it.
export const ENTERPRISE_DIRECTORY = "enterprise";
export const ENTERPRISE_LICENCE_FILE = "licence.token";
export const ENTERPRISE_STORAGE_FILE = "storage.json";
/** Room for a token of the longest allowed length plus line breaks around it. */
export const ENTERPRISE_LICENCE_FILE_MAX_BYTES = LICENCE_LIMITS.maxTokenLength * 2;
/** The host never writes more than this to the storage file. */
export const ENTERPRISE_STORAGE_FILE_MAX_BYTES = ENTERPRISE_LIMITS.maxStorageBytes;

/** The module storage file is too large, or the path is not a file. */
export class EnterpriseStorageFileError extends Error {
  readonly code: "too-large" | "not-a-file";
  constructor(code: "too-large" | "not-a-file", message: string) {
    super(message);
    this.name = "EnterpriseStorageFileError";
    this.code = code;
  }
}

/** The licence file is there but cannot be a licence: too large, or not a file. */
export class EnterpriseLicenceFileError extends Error {
  readonly code: "too-large" | "not-a-file";
  constructor(code: "too-large" | "not-a-file", message: string) {
    super(message);
    this.name = "EnterpriseLicenceFileError";
    this.code = code;
  }
}

// TODO(ugur): settings sections reach the renderer in the status, but no
// Settings page renders them yet; where and in what form is not decided.
// TODO(ugur): the module runs in the main process, so the frozen host is
// the boundary by contract and review. Decide whether it should run in a
// utilityProcess so module code cannot import app internals at all.

/** Shown in the status strip when an active module sets no label of its own. */
export const DEFAULT_TEAM_STATUS_LABEL = "Team features on";

export type EnterpriseStatusView = EnterpriseStatus;

export type EnterpriseOutcome =
  | { readonly kind: "no-licence" }
  | {
      readonly kind: "licence-refused";
      readonly reason: Exclude<LicenceFailureReason, "missing"> | "unreadable";
      readonly message: string;
    }
  | { readonly kind: "module-off"; readonly source: "stub" | "module" }
  | { readonly kind: "active" }
  | { readonly kind: "failed"; readonly error: Error };

export interface EnterpriseRuntime {
  /** What happened at launch. `status()` reflects later changes, such as the end of the grace period. */
  readonly outcome: EnterpriseOutcome;
  status(): EnterpriseStatusView;
  deactivate(): Promise<void>;
}

/** The module could be resolved but not imported, or it failed while activating. */
export class EnterpriseModuleLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EnterpriseModuleLoadError";
  }
}

export interface LoadEnterpriseOptions {
  readonly readLicenceToken: () => Promise<string | undefined>;
  /** SPKI PEM; defaults to the key built into `@openadminos/enterprise`. */
  readonly publicKey?: string;
  readonly now: () => number;
  /** Returns a URL to import, or undefined when the module is not installed. */
  readonly resolveModule: (specifier: string) => string | undefined;
  readonly importModule: (url: string) => Promise<unknown>;
  readonly ipc: EnterpriseIpcRegistrar;
  readonly storage: EnterpriseStorageBackend;
  readonly log: EnterpriseLogSink;
  readonly onChange?: () => void;
  /** Starts a timer and returns its cancel function; defaults to an unref'd setTimeout. */
  readonly setTimer?: (callback: () => void, delayMs: number) => () => void;
}

const INACTIVE: EnterpriseStatusView = Object.freeze({ active: false });

const RESTART = "then restart OpenAdminOS.";
const REINSTALL_LICENCE = `Install the licence file you received again, ${RESTART}`;
const OFFICIAL_BUILD = "Install the official build from openadminos.com";

function problem(reason: EnterpriseProblemReason, message: string): EnterpriseProblem {
  return Object.freeze({ reason, message });
}

function inactiveStatus(issue: EnterpriseProblem | undefined): EnterpriseStatusView {
  return issue ? Object.freeze({ active: false, problem: issue }) : INACTIVE;
}

function inactive(outcome: EnterpriseOutcome, issue?: EnterpriseProblem): EnterpriseRuntime {
  const status = inactiveStatus(issue);
  return Object.freeze({ outcome, status: () => status, deactivate: async () => undefined });
}

/** The problem shown for a licence that was refused, with the step that fixes it. */
function licenceProblem(reason: Exclude<LicenceFailureReason, "missing">, message: string): EnterpriseProblem {
  switch (reason) {
    case "expired":
      return problem("licence-expired", `${message} Install a renewed licence, ${RESTART}`);
    case "not-yet-valid":
      return problem("licence-not-yet-valid", `${message} Check the date and time on this device, ${RESTART}`);
    case "signature":
      return problem("licence-signature", `${message} ${REINSTALL_LICENCE}`);
    case "malformed":
      return problem("licence-malformed", `${message} ${REINSTALL_LICENCE}`);
  }
}

/**
 * The problem for a verified licence that no longer covers `now`: the
 * clock moved back before `notBefore`, or the grace period ended.
 */
function lapsedLicenceProblem(entitlement: { notBefore: number; graceEndsAt: number }, now: number): EnterpriseProblem {
  if (now < entitlement.notBefore) {
    return licenceProblem("not-yet-valid", `The licence is not valid before ${new Date(entitlement.notBefore).toISOString()}.`);
  }
  return licenceProblem("expired", `The licence expired and its grace period ended ${new Date(entitlement.graceEndsAt).toISOString()}.`);
}

/** The problem shown for a module that could not be used. */
function moduleProblem(error: Error, stage: "load" | "activate"): EnterpriseProblem {
  if (error instanceof EnterpriseInterfaceVersionError) {
    return problem(
      "module-version",
      `The team features in this build do not match this version of OpenAdminOS. ${OFFICIAL_BUILD}, ${RESTART}`,
    );
  }
  if (stage === "activate") {
    return problem(
      "module-activate",
      `${error.message} Restart OpenAdminOS. If it fails again, report it with Report an issue.`,
    );
  }
  return problem("module-load", `${error.message} ${OFFICIAL_BUILD} again, ${RESTART}`);
}

export async function loadEnterprise(options: LoadEnterpriseOptions): Promise<EnterpriseRuntime> {
  let token: string | undefined;
  try {
    token = await options.readLicenceToken();
  } catch (error) {
    options.log("warn", "enterprise: the licence file could not be read, team features stay off", {
      error: errorMessage(error),
    });
    if (error instanceof EnterpriseLicenceFileError && error.code === "too-large") {
      return inactive(
        { kind: "licence-refused", reason: "malformed", message: error.message },
        licenceProblem("malformed", error.message),
      );
    }
    const message = `The licence file could not be read (${errorMessage(error)}).`;
    return inactive(
      { kind: "licence-refused", reason: "unreadable", message },
      problem("licence-unreadable", `${message} Check that the file is readable by your account, ${RESTART}`),
    );
  }

  const licence = verifyLicence(token, {
    now: options.now(),
    ...(options.publicKey === undefined ? {} : { publicKey: options.publicKey }),
  });
  if (!licence.ok) {
    if (licence.reason === "missing") return inactive({ kind: "no-licence" });
    options.log("warn", "enterprise: the licence was refused, team features stay off", {
      reason: licence.reason,
      message: licence.message,
    });
    return inactive(
      { kind: "licence-refused", reason: licence.reason, message: licence.message },
      licenceProblem(licence.reason, licence.message),
    );
  }

  let module: EnterpriseModule;
  let source: "stub" | "module";
  try {
    const url = options.resolveModule(ENTERPRISE_MODULE_SPECIFIER);
    if (url === undefined) {
      module = defaultEnterpriseModule;
      source = "stub";
    } else {
      const imported = await options.importModule(url).catch((error: unknown) => {
        throw new EnterpriseModuleLoadError(
          `The team features module could not be loaded: ${errorMessage(error)}.`,
          { cause: error },
        );
      });
      const candidate = (imported as { default?: unknown } | null)?.default ?? imported;
      if (!isEnterpriseModule(candidate)) {
        throw new EnterpriseModuleLoadError("The team features module does not export an interfaceVersion and an activate function.");
      }
      if (candidate.interfaceVersion !== ENTERPRISE_INTERFACE_VERSION) {
        throw new EnterpriseInterfaceVersionError(candidate.interfaceVersion);
      }
      module = candidate;
      source = "module";
    }
  } catch (error) {
    return failed(options, error, "load");
  }

  const verified = licence.entitlement;
  const controller: EnterpriseHostController = createEnterpriseHost({
    entitlement: () => entitlementAt(verified, options.now()),
    ipc: options.ipc,
    storage: options.storage,
    log: options.log,
    ...(options.onChange ? { onChange: options.onChange } : {}),
  });

  let handle: EnterpriseHandle | undefined;
  try {
    handle = module.activate(controller.host);
  } catch (error) {
    controller.dispose();
    return failed(
      options,
      new EnterpriseModuleLoadError(`The team features module failed to start: ${errorMessage(error)}.`, { cause: error }),
      "activate",
    );
  }
  if (isThenable(handle)) {
    // `activate` is synchronous in interface version 1. A promise means the
    // module kept running in the background, so it is turned off and its
    // eventual failure is logged instead of going unhandled.
    controller.dispose();
    handle.then(undefined, (error: unknown) => {
      options.log("error", "enterprise: the team features module failed after an async activate", { error: errorMessage(error) });
    });
    return failed(options, new EnterpriseModuleLoadError("The team features module returned a promise from activate; interface version 1 needs a handle or undefined."), "activate");
  }
  if (handle === undefined || handle === null) {
    controller.dispose();
    // A licence with no team features in the build is worth saying; a module
    // that chose to stay off is not.
    return inactive(
      { kind: "module-off", source },
      source === "stub"
        ? problem(
            "module-missing",
            `A team features licence is installed, but this build of OpenAdminOS does not include team features. ${OFFICIAL_BUILD}, ${RESTART}`,
          )
        : undefined,
    );
  }
  if (typeof handle.deactivate !== "function") {
    controller.dispose();
    return failed(options, new EnterpriseModuleLoadError("The team features module returned a handle without deactivate."), "activate");
  }

  options.log("info", "enterprise: team features are on", {
    licensee: verified.licenseeId,
    licence: verified.state,
    features: verified.features.length,
  });
  const active = handle;
  let stopped = false;
  let cancelTimer: (() => void) | undefined;
  let stoppedProblem: EnterpriseProblem | undefined;

  const setTimer = options.setTimer ?? defaultSetTimer;

  // Runs the module's deactivate, waiting at most ENTERPRISE_STOP_TIMEOUT_MS.
  const runDeactivate = async () => {
    let cancelBound: (() => void) | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      cancelBound = setTimer(() => resolve("timeout"), ENTERPRISE_STOP_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => active.deactivate()).then(() => "stopped" as const),
        bound,
      ]);
      if (result === "timeout") {
        options.log("warn", "enterprise: the team features module did not stop in time", { timeoutMs: ENTERPRISE_STOP_TIMEOUT_MS });
      }
    } catch (error) {
      options.log("error", "enterprise: the team features module failed to stop", { error: errorMessage(error) });
    } finally {
      cancelBound?.();
    }
  };

  // Quit: the module stops first, while it can still use the host, then
  // its capabilities are removed.
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    cancelTimer?.();
    cancelTimer = undefined;
    try {
      await runDeactivate();
    } finally {
      // Removes the module's IPC handlers and calls onChange.
      controller.dispose();
    }
  };

  const expired = () => entitlementAt(verified, options.now()).state === "expired";
  const expire = () => {
    if (stopped) return;
    stoppedProblem = lapsedLicenceProblem(verified, options.now());
    options.log("warn", "enterprise: the licence no longer covers this time, team features are off", {
      reason: stoppedProblem.reason,
    });
    // The licence no longer covers the module: its capabilities go first,
    // and the renderer hears at once (dispose calls onChange). deactivate
    // runs afterwards and cannot hold any of that up.
    stopped = true;
    cancelTimer?.();
    cancelTimer = undefined;
    controller.dispose();
    void runDeactivate();
  };

  // The grace period can end while the app runs. One timer, unref'd so it
  // never keeps the app alive, waits in steps no longer than setTimeout
  // allows and checks the clock again at each step.
  const scheduleExpiry = () => {
    if (stopped) return;
    const remaining = verified.graceEndsAt - options.now();
    if (remaining <= 0) {
      expire();
      return;
    }
    cancelTimer = setTimer(scheduleExpiry, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  scheduleExpiry();

  return Object.freeze({
    outcome: Object.freeze({ kind: "active" }),
    status: (): EnterpriseStatusView => {
      if (!stopped && expired()) expire();
      if (stopped) return inactiveStatus(stoppedProblem);
      const snapshot = controller.snapshot();
      return Object.freeze({
        active: true,
        label: snapshot.status?.label ?? DEFAULT_TEAM_STATUS_LABEL,
        ...(snapshot.status?.detail === undefined ? {} : { detail: snapshot.status.detail }),
        settingsSections: snapshot.settingsSections,
      });
    },
    deactivate: stop,
  });
}

/** How long a module's deactivate may take before the host moves on. */
export const ENTERPRISE_STOP_TIMEOUT_MS = 2000;

/** The longest delay setTimeout accepts (2^31 - 1 ms). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function defaultSetTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function failed(options: LoadEnterpriseOptions, error: unknown, stage: "load" | "activate"): EnterpriseRuntime {
  const named = error instanceof Error ? error : new EnterpriseModuleLoadError(String(error));
  options.log("error", `enterprise: ${named.name}: ${named.message}`);
  return inactive({ kind: "failed", error: named }, moduleProblem(named, stage));
}

/**
 * Reads a small file whole, or returns undefined when it does not exist.
 * The size is checked on the open handle before reading, so the file read
 * is the file checked, and at most `maxBytes + 1` bytes are ever read.
 */
async function readBoundedFile(
  path: string,
  maxBytes: number,
  refuse: (code: "too-large" | "not-a-file", size: number) => Error,
): Promise<string | undefined> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw refuse("not-a-file", info.size);
    if (info.size > maxBytes) throw refuse("too-large", info.size);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    // The file grew between the check and the read.
    if (bytesRead > maxBytes) throw refuse("too-large", bytesRead);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Reads the licence and keeps module storage in the app's user data folder. */
export function enterpriseFiles(userDataDir: string): {
  readLicenceToken: () => Promise<string | undefined>;
  storage: EnterpriseStorageBackend;
} {
  const directory = join(userDataDir, ENTERPRISE_DIRECTORY);
  const storagePath = join(directory, ENTERPRISE_STORAGE_FILE);
  return {
    readLicenceToken: () =>
      readBoundedFile(
        join(directory, ENTERPRISE_LICENCE_FILE),
        ENTERPRISE_LICENCE_FILE_MAX_BYTES,
        (code, size) =>
          new EnterpriseLicenceFileError(
            code,
            code === "not-a-file"
              ? "The licence path is not a file."
              : `The licence file is ${size} bytes or more; a licence is at most ${ENTERPRISE_LICENCE_FILE_MAX_BYTES} bytes.`,
          ),
      ),
    storage: {
      read: () =>
        readBoundedFile(
          storagePath,
          ENTERPRISE_STORAGE_FILE_MAX_BYTES,
          (code, size) =>
            new EnterpriseStorageFileError(
              code,
              code === "not-a-file"
                ? "The team features storage path is not a file."
                : `The team features storage file is ${size} bytes or more; it is at most ${ENTERPRISE_STORAGE_FILE_MAX_BYTES} bytes.`,
            ),
        ),
      write: async (text) => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${storagePath}.${process.pid}.tmp`;
        try {
          await writeFileDurably(temporary, text, { durable: true });
          await atomicRename(temporary, storagePath);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
      },
    },
  };
}

interface IpcMainLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

/**
 * Adapts `ipcMain` for the host. Requests from a sender that is not the
 * app's own window are refused like every other app IPC call. The module's
 * handler gets the first argument only; the IPC event, and with it the
 * sender's webContents and session, never reaches module code.
 */
export function ipcMainRegistrar(
  ipcMain: IpcMainLike,
  requireTrustedSender: (event: never) => void,
): EnterpriseIpcRegistrar {
  return Object.freeze({
    handle: (channel: string, listener: (input: unknown) => Promise<unknown>) => {
      ipcMain.handle(channel, (event: unknown, input: unknown) => {
        requireTrustedSender(event as never);
        return listener(input);
      });
    },
    removeHandler: (channel: string) => ipcMain.removeHandler(channel),
  });
}

/**
 * Resolves the private module from the app's node_modules. A package that
 * is not installed is the normal case and returns undefined.
 */
export function resolveInstalledModule(specifier: string, resolve: (specifier: string) => string): string | undefined {
  try {
    return resolve(specifier);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
