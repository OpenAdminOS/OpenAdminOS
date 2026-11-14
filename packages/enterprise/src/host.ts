// Builds the `EnterpriseHost` a module receives. The host closes over the
// few capabilities passed in here (an IPC registrar, a storage file, a log
// sink and the verified licence) and nothing else, so a module cannot reach
// app state, tenant tokens, provider credentials or the keychain through it.
// The host object and every member are frozen.

import {
  ENTERPRISE_INTERFACE_VERSION,
  ENTERPRISE_IPC_PREFIX,
  type EnterpriseEntitlement,
  type EnterpriseHost,
  type EnterpriseIpcHandler,
  type EnterpriseJson,
  type EnterpriseLog,
  type EnterpriseLogFields,
  type EnterpriseSettingsSection,
  type EnterpriseStatusContribution,
  type EnterpriseStorage,
} from "./interface.js";

export const ENTERPRISE_LIMITS = Object.freeze({
  maxIpcHandlers: 32,
  maxIpcInputBytes: 64 * 1024,
  maxIpcOutputBytes: 256 * 1024,
  maxJsonDepth: 16,
  maxSettingsSections: 8,
  maxStorageKeys: 256,
  maxStorageValueBytes: 64 * 1024,
  maxStorageBytes: 1024 * 1024,
  maxLabelLength: 80,
  maxTitleLength: 60,
  maxDetailLength: 300,
  maxLogMessageLength: 500,
});

const NAME = /^[a-z][a-z0-9-]{0,47}(?:\.[a-z][a-z0-9-]{0,47}){0,3}$/;
const STORAGE_KEY = /^[a-z][a-z0-9._-]{0,63}$/;
// C0 and C1 control characters, which have no place in a single line label.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type EnterpriseHostErrorCode =
  | "invalid-name"
  | "duplicate"
  | "limit"
  | "invalid-value"
  | "disposed";

export class EnterpriseHostError extends Error {
  readonly code: EnterpriseHostErrorCode;
  constructor(code: EnterpriseHostErrorCode, message: string) {
    super(message);
    this.name = "EnterpriseHostError";
    this.code = code;
  }
}

/** Registers and removes IPC handlers; the desktop passes an `ipcMain` adapter. */
export interface EnterpriseIpcRegistrar {
  handle(channel: string, listener: (input: unknown) => Promise<unknown>): void;
  removeHandler(channel: string): void;
}

/** Reads and writes the module's own storage file as text. */
export interface EnterpriseStorageBackend {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
}

export type EnterpriseLogLevel = "info" | "warn" | "error";
export type EnterpriseLogSink = (level: EnterpriseLogLevel, message: string, fields?: EnterpriseLogFields) => void;

export interface CreateEnterpriseHostOptions {
  readonly entitlement: () => EnterpriseEntitlement;
  readonly ipc: EnterpriseIpcRegistrar;
  readonly storage: EnterpriseStorageBackend;
  readonly log: EnterpriseLogSink;
  /** Called after the status contribution or the settings sections change. */
  readonly onChange?: () => void;
}

export interface EnterpriseHostSnapshot {
  readonly status: EnterpriseStatusContribution | undefined;
  readonly settingsSections: readonly EnterpriseSettingsSection[];
  readonly ipcChannels: readonly string[];
}

export interface EnterpriseHostController {
  readonly host: EnterpriseHost;
  snapshot(): EnterpriseHostSnapshot;
  /** Removes every IPC handler and refuses further calls. */
  dispose(): void;
}

export function enterpriseIpcChannel(name: string): string {
  return `${ENTERPRISE_IPC_PREFIX}${name}`;
}

export function createEnterpriseHost(options: CreateEnterpriseHostOptions): EnterpriseHostController {
  const channels = new Map<string, string>();
  const sections = new Map<string, EnterpriseSettingsSection>();
  let status: EnterpriseStatusContribution | undefined;
  let disposed = false;

  const assertLive = () => {
    if (disposed) throw new EnterpriseHostError("disposed", "Team features were turned off for this launch.");
  };
  const changed = () => {
    try {
      options.onChange?.();
    } catch (error) {
      options.log("error", "enterprise: the change listener failed", { error: errorMessage(error) });
    }
  };

  const log: EnterpriseLog = Object.freeze({
    info: freezeFn((message: string, fields?: EnterpriseLogFields) => writeLog(options.log, "info", message, fields)),
    warn: freezeFn((message: string, fields?: EnterpriseLogFields) => writeLog(options.log, "warn", message, fields)),
    error: freezeFn((message: string, fields?: EnterpriseLogFields) => writeLog(options.log, "error", message, fields)),
  });

  const registerIpc = (name: string, handler: EnterpriseIpcHandler): void => {
    assertLive();
    assertName(name, "IPC handler name");
    if (typeof handler !== "function") {
      throw new EnterpriseHostError("invalid-value", `The IPC handler for ${name} is not a function.`);
    }
    if (channels.has(name)) {
      throw new EnterpriseHostError("duplicate", `An IPC handler named ${name} is already registered.`);
    }
    if (channels.size >= ENTERPRISE_LIMITS.maxIpcHandlers) {
      throw new EnterpriseHostError("limit", `A module can register at most ${ENTERPRISE_LIMITS.maxIpcHandlers} IPC handlers.`);
    }
    const channel = enterpriseIpcChannel(name);
    options.ipc.handle(channel, async (input: unknown) => {
      if (disposed) throw new EnterpriseHostError("disposed", "Team features were turned off for this launch.");
      const request = checkJson(input ?? null, ENTERPRISE_LIMITS.maxIpcInputBytes, `the request to ${name}`);
      let result: EnterpriseJson | void;
      try {
        result = await handler(request);
      } catch (error) {
        options.log("error", "enterprise: an IPC handler failed", { name, error: errorMessage(error) });
        throw new Error(`The team feature request ${name} failed: ${errorMessage(error)}`);
      }
      return checkJson(result ?? null, ENTERPRISE_LIMITS.maxIpcOutputBytes, `the reply from ${name}`);
    });
    channels.set(name, channel);
  };

  const registerSettingsSection = (section: EnterpriseSettingsSection): void => {
    assertLive();
    if (typeof section !== "object" || section === null) {
      throw new EnterpriseHostError("invalid-value", "A settings section must be an object.");
    }
    assertName(section.id, "settings section id");
    if (sections.has(section.id)) {
      throw new EnterpriseHostError("duplicate", `A settings section named ${section.id} is already registered.`);
    }
    if (sections.size >= ENTERPRISE_LIMITS.maxSettingsSections) {
      throw new EnterpriseHostError("limit", `A module can register at most ${ENTERPRISE_LIMITS.maxSettingsSections} settings sections.`);
    }
    sections.set(section.id, Object.freeze({
      id: section.id,
      title: checkText(section.title, ENTERPRISE_LIMITS.maxTitleLength, "settings section title"),
      description: checkText(section.description, ENTERPRISE_LIMITS.maxDetailLength, "settings section description"),
    }));
    changed();
  };

  const setStatusContribution = (next: EnterpriseStatusContribution | undefined): void => {
    assertLive();
    if (next === undefined) {
      status = undefined;
    } else {
      if (typeof next !== "object" || next === null) {
        throw new EnterpriseHostError("invalid-value", "A status contribution must be an object.");
      }
      const label = checkText(next.label, ENTERPRISE_LIMITS.maxLabelLength, "status label");
      status = next.detail === undefined
        ? Object.freeze({ label })
        : Object.freeze({ label, detail: checkText(next.detail, ENTERPRISE_LIMITS.maxDetailLength, "status detail") });
    }
    changed();
  };

  const host: EnterpriseHost = Object.freeze({
    interfaceVersion: ENTERPRISE_INTERFACE_VERSION,
    entitlement: freezeFn(() => options.entitlement()),
    registerIpc: freezeFn(registerIpc),
    registerSettingsSection: freezeFn(registerSettingsSection),
    setStatusContribution: freezeFn(setStatusContribution),
    storage: createStorage(options.storage, assertLive),
    log,
  });

  return Object.freeze({
    host,
    snapshot: () => Object.freeze({
      status,
      settingsSections: Object.freeze([...sections.values()]),
      ipcChannels: Object.freeze([...channels.values()]),
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const channel of channels.values()) {
        try {
          options.ipc.removeHandler(channel);
        } catch (error) {
          options.log("warn", "enterprise: an IPC handler could not be removed", { channel, error: errorMessage(error) });
        }
      }
      channels.clear();
      sections.clear();
      status = undefined;
      changed();
    },
  });
}

function createStorage(backend: EnterpriseStorageBackend, assertLive: () => void): EnterpriseStorage {
  let loaded: Promise<Map<string, EnterpriseJson>> | undefined;
  // Writes run one after another so a later write never lands first.
  let queue: Promise<unknown> = Promise.resolve();

  const load = () => {
    loaded ??= backend.read().then((text) => {
      const entries = new Map<string, EnterpriseJson>();
      if (text === undefined || text.trim() === "") return entries;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new EnterpriseHostError("invalid-value", "The team features storage file is not valid JSON.");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new EnterpriseHostError("invalid-value", "The team features storage file is not a JSON object.");
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (STORAGE_KEY.test(key)) entries.set(key, checkJson(value, ENTERPRISE_LIMITS.maxStorageValueBytes, `stored value ${key}`));
      }
      return entries;
    }).catch((error: unknown) => {
      // Read again next time, so a passing file system error does not
      // disable storage for the rest of the launch.
      loaded = undefined;
      throw error;
    });
    return loaded;
  };

  const run = <T>(task: (entries: Map<string, EnterpriseJson>) => Promise<T>): Promise<T> => {
    const next = queue.then(async () => task(await load()));
    queue = next.catch(() => undefined);
    return next;
  };

  const persist = async (entries: Map<string, EnterpriseJson>) => {
    const text = JSON.stringify(Object.fromEntries(entries));
    if (Buffer.byteLength(text, "utf8") > ENTERPRISE_LIMITS.maxStorageBytes) {
      throw new EnterpriseHostError("limit", `Team features storage is limited to ${ENTERPRISE_LIMITS.maxStorageBytes} bytes.`);
    }
    await backend.write(text);
  };

  return Object.freeze({
    get: freezeFn(async (key: string) => {
      assertLive();
      assertStorageKey(key);
      return run(async (entries) => entries.get(key));
    }),
    set: freezeFn(async (key: string, value: EnterpriseJson) => {
      assertLive();
      assertStorageKey(key);
      const checked = checkJson(value, ENTERPRISE_LIMITS.maxStorageValueBytes, `the value for ${key}`);
      await run(async (entries) => {
        if (!entries.has(key) && entries.size >= ENTERPRISE_LIMITS.maxStorageKeys) {
          throw new EnterpriseHostError("limit", `Team features storage holds at most ${ENTERPRISE_LIMITS.maxStorageKeys} keys.`);
        }
        const next = new Map(entries);
        next.set(key, checked);
        await persist(next);
        entries.set(key, checked);
      });
    }),
    delete: freezeFn(async (key: string) => {
      assertLive();
      assertStorageKey(key);
      await run(async (entries) => {
        if (!entries.has(key)) return;
        const next = new Map(entries);
        next.delete(key);
        await persist(next);
        entries.delete(key);
      });
    }),
    keys: freezeFn(async () => {
      assertLive();
      return run(async (entries) => Object.freeze([...entries.keys()]));
    }),
  });
}

/**
 * Checks that `value` is plain JSON within the size and depth limits and
 * returns a deep frozen copy, so the caller keeps no reference into it.
 */
export function checkJson(value: unknown, maxBytes: number, what: string): EnterpriseJson {
  const copy = copyJson(value, 0, what);
  const text = JSON.stringify(copy);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new EnterpriseHostError("limit", `${capitalise(what)} is larger than ${maxBytes} bytes.`);
  }
  return copy;
}

function copyJson(value: unknown, depth: number, what: string): EnterpriseJson {
  if (depth > ENTERPRISE_LIMITS.maxJsonDepth) {
    throw new EnterpriseHostError("limit", `${capitalise(what)} is nested deeper than ${ENTERPRISE_LIMITS.maxJsonDepth} levels.`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EnterpriseHostError("invalid-value", `${capitalise(what)} contains a number JSON cannot hold.`);
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => copyJson(item, depth + 1, what)));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EnterpriseHostError("invalid-value", `${capitalise(what)} contains a value that is not plain JSON.`);
    }
    const out: Record<string, EnterpriseJson> = {};
    for (const [key, item] of Object.entries(value)) {
      // Defined, not assigned, so a "__proto__" key stays a plain own property.
      Object.defineProperty(out, key, { value: copyJson(item, depth + 1, what), enumerable: true, writable: true, configurable: true });
    }
    return Object.freeze(out);
  }
  throw new EnterpriseHostError("invalid-value", `${capitalise(what)} contains a value that is not plain JSON.`);
}

function assertName(name: unknown, what: string): asserts name is string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new EnterpriseHostError(
      "invalid-name",
      `The ${what} must be lower case letters, digits and hyphens, up to four dot separated parts.`,
    );
  }
}

function assertStorageKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !STORAGE_KEY.test(key)) {
    throw new EnterpriseHostError("invalid-name", "A storage key must be lower case letters, digits, dots, hyphens and underscores, up to 64 characters.");
  }
}

function checkText(value: unknown, maxLength: number, what: string): string {
  if (typeof value !== "string") throw new EnterpriseHostError("invalid-value", `The ${what} must be text.`);
  const text = value.trim();
  if (text === "" || text.length > maxLength || CONTROL.test(text)) {
    throw new EnterpriseHostError("invalid-value", `The ${what} must be one line of 1 to ${maxLength} characters.`);
  }
  return text;
}

function writeLog(sink: EnterpriseLogSink, level: "info" | "warn" | "error", message: unknown, fields: unknown): void {
  const text = typeof message === "string" ? message.slice(0, ENTERPRISE_LIMITS.maxLogMessageLength) : String(message);
  const safeFields: Record<string, string | number | boolean> = {};
  if (typeof fields === "object" && fields !== null) {
    for (const [key, value] of Object.entries(fields).slice(0, 16)) {
      if (typeof value === "string") safeFields[key] = value.slice(0, ENTERPRISE_LIMITS.maxLogMessageLength);
      else if (typeof value === "number" || typeof value === "boolean") safeFields[key] = value;
    }
  }
  sink(level, `enterprise module: ${text}`, Object.freeze(safeFields));
}

function freezeFn<T extends (...args: never[]) => unknown>(fn: T): T {
  return Object.freeze(fn);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
