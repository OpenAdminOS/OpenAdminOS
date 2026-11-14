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

import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  ENTERPRISE_INTERFACE_VERSION,
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

import type { EnterpriseStatus } from "@openadminos/agent-sdk";

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
  | { readonly kind: "licence-refused"; readonly reason: LicenceFailureReason; readonly message: string }
  | { readonly kind: "module-off"; readonly source: "stub" | "module" }
  | { readonly kind: "active" }
  | { readonly kind: "failed"; readonly error: Error };

export interface EnterpriseRuntime {
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
}

const INACTIVE: EnterpriseStatusView = Object.freeze({ active: false });

function inactive(outcome: EnterpriseOutcome): EnterpriseRuntime {
  return Object.freeze({ outcome, status: () => INACTIVE, deactivate: async () => undefined });
}

export async function loadEnterprise(options: LoadEnterpriseOptions): Promise<EnterpriseRuntime> {
  let token: string | undefined;
  try {
    token = await options.readLicenceToken();
  } catch (error) {
    options.log("warn", "enterprise: the licence file could not be read, team features stay off", {
      error: errorMessage(error),
    });
    return inactive({ kind: "licence-refused", reason: "missing", message: errorMessage(error) });
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
    return inactive({ kind: "licence-refused", reason: licence.reason, message: licence.message });
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
          `The team features module could not be loaded: ${errorMessage(error)}`,
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
    return failed(options, error);
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
      new EnterpriseModuleLoadError(`The team features module failed to start: ${errorMessage(error)}`, { cause: error }),
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
    return failed(options, new EnterpriseModuleLoadError("The team features module returned a promise from activate; interface version 1 needs a handle or undefined."));
  }
  if (handle === undefined || handle === null) {
    controller.dispose();
    return inactive({ kind: "module-off", source });
  }
  if (typeof handle.deactivate !== "function") {
    controller.dispose();
    return failed(options, new EnterpriseModuleLoadError("The team features module returned a handle without deactivate."));
  }

  options.log("info", "enterprise: team features are on", {
    licensee: verified.licenseeId,
    licence: verified.state,
    features: verified.features.length,
  });
  const active = handle;
  let stopped = false;
  return Object.freeze({
    outcome: Object.freeze({ kind: "active" }),
    status: (): EnterpriseStatusView => {
      if (stopped) return INACTIVE;
      const snapshot = controller.snapshot();
      return Object.freeze({
        active: true,
        label: snapshot.status?.label ?? DEFAULT_TEAM_STATUS_LABEL,
        ...(snapshot.status?.detail === undefined ? {} : { detail: snapshot.status.detail }),
        settingsSections: snapshot.settingsSections,
      });
    },
    deactivate: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await active.deactivate();
      } catch (error) {
        options.log("error", "enterprise: the team features module failed to stop", { error: errorMessage(error) });
      } finally {
        controller.dispose();
      }
    },
  });
}

function failed(options: LoadEnterpriseOptions, error: unknown): EnterpriseRuntime {
  const named = error instanceof Error ? error : new EnterpriseModuleLoadError(String(error));
  options.log("error", `enterprise: ${named.name}: ${named.message}`);
  return inactive({ kind: "failed", error: named });
}

/** Reads the licence and keeps module storage in the app's user data folder. */
export function enterpriseFiles(userDataDir: string): {
  readLicenceToken: () => Promise<string | undefined>;
  storage: EnterpriseStorageBackend;
} {
  const directory = join(userDataDir, ENTERPRISE_DIRECTORY);
  const storagePath = join(directory, ENTERPRISE_STORAGE_FILE);
  return {
    readLicenceToken: async () => {
      let handle;
      try {
        handle = await open(join(directory, ENTERPRISE_LICENCE_FILE), "r");
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
        throw error;
      }
      try {
        // Checked on the open handle, so the file read is the file checked.
        const info = await handle.stat();
        if (!info.isFile()) {
          throw new EnterpriseLicenceFileError("not-a-file", "The licence path is not a file.");
        }
        if (info.size > ENTERPRISE_LICENCE_FILE_MAX_BYTES) {
          throw new EnterpriseLicenceFileError(
            "too-large",
            `The licence file is ${info.size} bytes; a licence is at most ${ENTERPRISE_LICENCE_FILE_MAX_BYTES} bytes.`,
          );
        }
        const buffer = Buffer.alloc(ENTERPRISE_LICENCE_FILE_MAX_BYTES + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > ENTERPRISE_LICENCE_FILE_MAX_BYTES) {
          throw new EnterpriseLicenceFileError("too-large", "The licence file grew past the size limit while it was read.");
        }
        return buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }
    },
    storage: {
      read: async () => {
        try {
          return await readFile(storagePath, "utf8");
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
          throw error;
        }
      },
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
