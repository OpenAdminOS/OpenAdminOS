// Builds the `EnterpriseHost` a module receives. The host closes over the
// few capabilities passed in here (an IPC registrar, a storage file, a log
// sink and the verified licence) and nothing else, so a module cannot reach
// app state, tenant tokens, provider credentials or the keychain through it.
// The host object and every member are frozen.

import {
  ENTERPRISE_INTERFACE_VERSION,
  ENTERPRISE_IPC_PREFIX,
  ENTERPRISE_UI_IPC_PREFIX,
  type EnterpriseAgents,
  type EnterpriseEntitlement,
  type EnterpriseHost,
  type EnterpriseIpcHandler,
  type EnterpriseJson,
  type EnterpriseLog,
  type EnterpriseLogFields,
  type EnterpriseOrganizations,
  type EnterpriseResult,
  type EnterpriseSandboxAssignmentEntry,
  type EnterpriseSandboxes,
  type EnterpriseScheduleTargets,
  type EnterpriseSettingsSection,
  type EnterpriseUiActionHandler,
  type EnterpriseUiActionInput,
  type EnterpriseUiBody,
  type EnterpriseUiReply,
  type EnterpriseStatusContribution,
  type EnterpriseStorage,
} from "./interface.js";
import { EnterpriseHostError } from "./errors.js";
import {
  checkModuleText,
  checkScheduleTargets,
  checkUiActionAgainst,
  checkUiActionInput,
  checkUiBody,
  checkUiNotice,
  checkUiReply,
  currentTargetFor,
  ENTERPRISE_UI_LIMITS,
} from "./ui.js";

export { EnterpriseHostError, type EnterpriseHostErrorCode } from "./errors.js";

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
  maxSandboxIdLength: 64,
  maxSandboxAddressLength: 64,
  maxPairingCodeLength: 64,
  maxOrganizationIdLength: 200,
  maxAssignmentEntries: 50,
  maxAgentIdLength: 200,
});

/** IPC handler names and settings section ids. Part of interface version 1. */
export const ENTERPRISE_NAME_PATTERN = Object.freeze(/^[a-z][a-z0-9-]{0,47}(?:\.[a-z][a-z0-9-]{0,47}){0,3}$/);
/** Storage keys. Part of interface version 1. */
export const ENTERPRISE_STORAGE_KEY_PATTERN = Object.freeze(/^[a-z][a-z0-9._-]{0,63}$/);
const NAME = ENTERPRISE_NAME_PATTERN;
const STORAGE_KEY = ENTERPRISE_STORAGE_KEY_PATTERN;
// C0 and C1 control characters, which have no place in a single line label.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

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
  /**
   * What the app lends a module beyond its own state. Each one left out
   * answers empty (organizations, agents, the sandbox list) or with the
   * named error `sandboxes-unavailable`.
   */
  readonly capabilities?: EnterpriseHostCapabilities;
}

export interface EnterpriseHostCapabilities {
  readonly organizations?: EnterpriseOrganizations;
  readonly agents?: EnterpriseAgents;
  readonly sandboxes?: EnterpriseSandboxes;
  /**
   * The app's own schedules, for the host alone: never reachable from the
   * module. The host turns an agent's schedule on this computer off or on
   * in place, without deleting it, after a module moved it.
   */
  readonly localSchedules?: EnterpriseLocalSchedules;
}

export interface EnterpriseLocalSchedules {
  /** Whether the agent has a schedule on this computer, on or off. */
  has(agentId: string): Promise<boolean>;
  /** Turns the agent's schedule on this computer off or back on, keeping its organization, interval and settings; false when it has none. */
  setEnabled(agentId: string, enabled: boolean): Promise<boolean>;
  /** A move of the agent's schedule starts; the app refuses deleting its schedule here until `endMove`. */
  beginMove?(agentId: string): void;
  endMove?(agentId: string): void;
}

/** A section as the window gets it: with the revision of its body. */
export interface EnterpriseSettingsSectionSnapshot extends EnterpriseSettingsSection {
  readonly revision: number;
}

export interface EnterpriseHostSnapshot {
  readonly status: EnterpriseStatusContribution | undefined;
  readonly settingsSections: readonly EnterpriseSettingsSectionSnapshot[];
  readonly scheduleTargets: EnterpriseScheduleTargets | undefined;
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

export function enterpriseUiChannel(name: string): string {
  return `${ENTERPRISE_UI_IPC_PREFIX}${name}`;
}

const SUPERSEDED_NOTICE = Object.freeze({
  type: "notice" as const,
  tone: "neutral" as const,
  title: "The section changed",
  message: "The section changed while this ran, so it shows the newest state.",
});

export function createEnterpriseHost(options: CreateEnterpriseHostOptions): EnterpriseHostController {
  const capabilities = options.capabilities ?? {};
  const channels = new Map<string, string>();
  const uiChannels = new Map<string, string>();
  const sections = new Map<string, EnterpriseSettingsSection>();
  /** Moves on with every body, so the window draws the newest and drops replies to an older one. */
  const revisions = new Map<string, number>();
  let status: EnterpriseStatusContribution | undefined;
  let scheduleTargets: EnterpriseScheduleTargets | undefined;
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

  /** Registers one IPC handler channel under ENTERPRISE_IPC_PREFIX; UI actions have their own prefix and registry. */
  const register = (name: string, handler: unknown, what: string, listener: (request: EnterpriseJson) => Promise<EnterpriseJson>): void => {
    assertLive();
    assertName(name, `${what} name`);
    if (typeof handler !== "function") {
      throw new EnterpriseHostError("invalid-value", `The ${what} for ${name} is not a function.`);
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
      if (options.entitlement().state === "expired") {
        throw new EnterpriseHostError("expired", "The team features licence and its grace period ended. Install a renewed licence, then restart OpenAdminOS.");
      }
      const request = checkJson(input ?? null, ENTERPRISE_LIMITS.maxIpcInputBytes, `the request to ${name}`);
      return checkJson(await listener(request), ENTERPRISE_LIMITS.maxIpcOutputBytes, `the reply from ${name}`);
    });
    channels.set(name, channel);
  };

  const registerIpc = (name: string, handler: EnterpriseIpcHandler): void => {
    register(name, handler, "IPC handler", async (request) => {
      let result: EnterpriseJson | void;
      try {
        result = await handler(request);
      } catch (error) {
        options.log("error", "enterprise: an IPC handler failed", { name, error: errorMessage(error) });
        throw new Error(`The team feature request ${name} failed: ${errorMessage(error)}`);
      }
      return result ?? null;
    });
  };

  /**
   * A UI action, on its own channel under ENTERPRISE_UI_IPC_PREFIX and in
   * its own registry. The window's input is checked against the UI it was
   * given before the handler runs, and the reply before the window draws
   * it. A reply body replaces the section's body in the host, unless the
   * section changed while the handler ran. A failure, or a reply the app
   * does not draw, becomes a danger notice with the reason.
   */
  const registerUiAction = (name: string, handler: EnterpriseUiActionHandler): void => {
    assertLive();
    assertName(name, "UI action name");
    if (typeof handler !== "function") throw new EnterpriseHostError("invalid-value", `The UI action ${name} is not a function.`);
    if (uiChannels.has(name)) throw new EnterpriseHostError("duplicate", `A UI action named ${name} is already registered.`);
    if (uiChannels.size >= ENTERPRISE_UI_LIMITS.maxUiActions) {
      throw new EnterpriseHostError("limit", `A module can register at most ${ENTERPRISE_UI_LIMITS.maxUiActions} UI actions.`);
    }
    const channel = enterpriseUiChannel(name);
    options.ipc.handle(channel, async (raw: unknown) => {
      if (disposed) throw new EnterpriseHostError("disposed", "Team features were turned off for this launch.");
      if (options.entitlement().state === "expired") {
        throw new EnterpriseHostError("expired", "The team features licence and its grace period ended. Install a renewed licence, then restart OpenAdminOS.");
      }
      const input = checkUiActionInput(checkJson(raw ?? null, ENTERPRISE_LIMITS.maxIpcInputBytes, `the request to ${name}`));
      checkUiActionAgainst(input, name, { body: (id) => sections.get(id)?.body, scheduleTargets });
      const revision = input.kind === "button" ? revisions.get(input.sectionId) : undefined;
      // A schedule moves away only once it exists here: without one the module is not asked, and its place stays.
      // Back here is allowed without one, since nothing can then run twice.
      let noScheduleHere = false;
      const local = input.kind === "schedule" ? capabilities.localSchedules : undefined;
      if (input.kind === "schedule" && local) {
        try {
          noScheduleHere = !(await local.has(input.agentId));
        } catch (error) {
          options.log("error", "enterprise: the schedule here could not be read before a move", { agentId: input.agentId, error: errorMessage(error) });
          return danger("The schedule here could not be read", "The app could not read the schedule here, so nothing moved.", "Try again. If it keeps failing, restart OpenAdminOS.");
        }
        if (noScheduleHere && input.targetId !== "this-computer") return NO_SCHEDULE_HERE;
      }
      // While a move runs, the app does not delete the schedule here.
      if (input.kind === "schedule") local?.beginMove?.(input.agentId);
      try {
        let reply: EnterpriseUiReply;
        try {
          reply = checkUiReply(await handler(input), new Set(uiChannels.keys()));
        } catch (error) {
          options.log("error", "enterprise: a UI action failed", { name, error: errorMessage(error) });
          return checkJson(failedReply(error), ENTERPRISE_LIMITS.maxIpcOutputBytes, `the reply from ${name}`);
        }
        // A schedule choice answers with a notice; a body there has no section to go to.
        if (input.kind === "schedule" && reply.body) {
          options.log("error", "enterprise: a schedule action answered with a body", { name });
          return danger("The schedule did not move", "The team features module answered a schedule choice with a section body, which the schedule card does not take. Nothing changed here.", "Update the team features module, then try again.");
        }
        // Too large to send is refused before it is stored, so a body is never kept and then reported as a failure.
        try {
          checkJson(reply, ENTERPRISE_LIMITS.maxIpcOutputBytes, `the reply from ${name}`);
        } catch (error) {
          options.log("error", "enterprise: a UI action reply was too large", { name, error: errorMessage(error) });
          return danger("The team feature did not complete", `The reply from ${name} is larger than the app takes, so nothing was kept.`, "Update the team features module, then try again.");
        }
        if (input.kind === "button" && reply.body) {
          const section = sections.get(input.sectionId);
          if (!disposed && section && revisions.get(input.sectionId) === revision) {
            setBody(section, reply.body);
          } else {
            // The section changed while the handler ran: the newer body stays.
            reply = Object.freeze({ notice: reply.notice ?? SUPERSEDED_NOTICE });
          }
        }
        if (input.kind === "schedule") reply = await handOff(input, reply, noScheduleHere);
        return checkJson(reply, ENTERPRISE_LIMITS.maxIpcOutputBytes, `the reply from ${name}`);
      } finally {
        if (input.kind === "schedule") local?.endMove?.(input.agentId);
      }
    });
    uiChannels.set(name, channel);
  };

  /**
   * A schedule moves in one main process step. The module took the choice;
   * only when it now reports the schedule at the chosen place does the app
   * change the schedule on this computer, in place: off when it moved to
   * another place, on again when it came back. Anything else changes
   * nothing here and says so.
   */
  const handOff = async (input: Extract<EnterpriseUiActionInput, { kind: "schedule" }>, reply: EnterpriseUiReply, noScheduleHere: boolean): Promise<EnterpriseUiReply> => {
    if (reply.notice?.tone === "danger") return reply;
    // App copy says "here" for this computer: the reply passes the same text check as module text.
    const place = (targetId: string) => (targetId === "this-computer" ? "here" : `on ${scheduleTargets?.targets.find((target) => target.id === targetId)?.label ?? targetId}`);
    const now = currentTargetFor(scheduleTargets, input.agentId);
    if (now !== input.targetId) {
      return danger("The schedule did not move", `The team features module did not report the schedule ${place(input.targetId)}; it reports it ${place(now)}. Nothing changed here.`, "Try again. If it keeps happening, check the team features module.");
    }
    const local = capabilities.localSchedules;
    if (local) {
      const here = input.targetId === "this-computer";
      if (here && noScheduleHere) {
        // Moved back with nothing here to turn on: nothing changes here, and the card says how to schedule it.
        return Object.freeze({ notice: Object.freeze({ type: "notice" as const, tone: "neutral" as const, title: "Moved back", message: "Moved back. Turn on Automatic runs to schedule it here." }) });
      }
      let found: boolean;
      try {
        found = await local.setEnabled(input.agentId, here);
      } catch (error) {
        options.log("error", "enterprise: the schedule here could not follow a move", { agentId: input.agentId, error: errorMessage(error) });
        return here
          ? danger("The schedule is not on here", "The team features module moved the schedule back, but it could not be turned on here.", "Turn on Automatic runs in the schedule card.")
          : danger("The schedule runs in two places", `The schedule now runs ${place(input.targetId)}, and it could not be turned off here, so it runs in both places.`, "Use Turn off here in the schedule card.");
      }
      if (here && !found) {
        return danger("No schedule here", "The team features module moved the schedule back, but there is no schedule here to turn on.", "Turn on Automatic runs in the schedule card.");
      }
      if (!here && !found) {
        // The schedule here went away while the module moved it.
        return Object.freeze({
          notice: Object.freeze({
            type: "notice" as const,
            tone: "warning" as const,
            title: "Runs only there now",
            message: `The schedule now runs ${place(input.targetId)} only; there is no schedule here any more.`,
            recovery: "To run it here again, choose here, then turn on Automatic runs.",
          }),
        });
      }
    }
    return reply.notice ? reply : Object.freeze({ ...reply, notice: Object.freeze({ type: "notice" as const, tone: "success" as const, title: "Saved", message: `The schedule now runs ${place(input.targetId)}.` }) });
  };

  /** Stores a checked body and moves the section's revision on. */
  const setBody = (section: EnterpriseSettingsSection, body: EnterpriseUiBody | undefined): void => {
    const { body: _previous, ...rest } = section;
    sections.set(section.id, Object.freeze({ ...rest, ...(body ? { body } : {}) }));
    revisions.set(section.id, (revisions.get(section.id) ?? 0) + 1);
    changed();
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
    const body = section.body === undefined ? undefined : checkUiBody(section.body, new Set(uiChannels.keys()));
    revisions.set(section.id, 1);
    sections.set(section.id, Object.freeze({
      id: section.id,
      title: checkText(section.title, ENTERPRISE_LIMITS.maxTitleLength, "settings section title", true),
      description: checkText(section.description, ENTERPRISE_LIMITS.maxDetailLength, "settings section description", true),
      ...(body ? { body } : {}),
    }));
    changed();
  };

  const updateSettingsSection = (id: string, body: EnterpriseUiBody | undefined): void => {
    assertLive();
    const section = typeof id === "string" ? sections.get(id) : undefined;
    if (!section) throw new EnterpriseHostError("invalid-name", "No settings section with that id is registered.");
    setBody(section, body === undefined ? undefined : checkUiBody(body, new Set(uiChannels.keys())));
  };

  const setScheduleTargets = (next: EnterpriseScheduleTargets | undefined): void => {
    assertLive();
    scheduleTargets = next === undefined ? undefined : checkScheduleTargets(next, new Set(uiChannels.keys()));
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
      // The status strip is where the app speaks about where data goes: module text there passes the same phrase check.
      const label = checkText(next.label, ENTERPRISE_LIMITS.maxLabelLength, "status label", true);
      status = next.detail === undefined
        ? Object.freeze({ label })
        : Object.freeze({ label, detail: checkText(next.detail, ENTERPRISE_LIMITS.maxDetailLength, "status detail", true) });
    }
    changed();
  };

  const host: EnterpriseHost = Object.freeze({
    interfaceVersion: ENTERPRISE_INTERFACE_VERSION,
    entitlement: freezeFn(() => options.entitlement()),
    registerIpc: freezeFn(registerIpc),
    registerSettingsSection: freezeFn(registerSettingsSection),
    updateSettingsSection: freezeFn(updateSettingsSection),
    registerUiAction: freezeFn(registerUiAction),
    setScheduleTargets: freezeFn(setScheduleTargets),
    setStatusContribution: freezeFn(setStatusContribution),
    storage: createStorage(options.storage, assertLive),
    log,
    ...createCapabilities(options, assertLive),
  });

  return Object.freeze({
    host,
    snapshot: () => Object.freeze({
      status,
      settingsSections: Object.freeze([...sections.values()].map((section) => Object.freeze({ ...section, revision: revisions.get(section.id) ?? 1 }))),
      scheduleTargets,
      ipcChannels: Object.freeze([...channels.values(), ...uiChannels.values()]),
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const channel of [...channels.values(), ...uiChannels.values()]) {
        try {
          options.ipc.removeHandler(channel);
        } catch (error) {
          options.log("warn", "enterprise: an IPC handler could not be removed", { channel, error: errorMessage(error) });
        }
      }
      channels.clear();
      uiChannels.clear();
      sections.clear();
      revisions.clear();
      status = undefined;
      scheduleTargets = undefined;
      changed();
    },
  });
}

const NO_SCHEDULE_HERE = Object.freeze({
  notice: Object.freeze({
    type: "notice" as const,
    tone: "danger" as const,
    title: "No schedule here",
    message: "Turn on Automatic runs first; a schedule can move only once it exists here.",
    recovery: "Turn on Automatic runs in the schedule card, then choose again.",
  }),
});

/** A danger notice in the app's own words. */
function danger(title: string, message: string, recovery: string): EnterpriseUiReply {
  return Object.freeze({ notice: Object.freeze({ type: "notice" as const, tone: "danger" as const, title, message, recovery }) });
}

/** The notice a failed UI action answers with: the reason, and the step that fixes it. */
function failedReply(error: unknown): EnterpriseUiReply {
  // The reason passes the same check as module text; one that does not is replaced.
  // The reason is built once, checked as built, and used as the check returned it.
  let reason = "The team features module did not say why.";
  const candidate = errorMessage(error).trim().slice(0, ENTERPRISE_UI_LIMITS.maxMessageLength);
  try {
    reason = checkUiNotice({ type: "notice", tone: "neutral", title: "x", message: candidate }).message;
  } catch {
    // Keep the generic reason.
  }
  return Object.freeze({
    notice: Object.freeze({
      type: "notice" as const,
      tone: "danger" as const,
      title: "The team feature did not complete",
      message: reason,
      recovery: "Try again. If it keeps failing, the app log names the cause.",
    }),
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
      if (Buffer.byteLength(text, "utf8") > ENTERPRISE_LIMITS.maxStorageBytes) {
        throw new EnterpriseHostError("limit", `The team features storage file is larger than ${ENTERPRISE_LIMITS.maxStorageBytes} bytes.`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new EnterpriseHostError("invalid-value", "The team features storage file is not valid JSON.");
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new EnterpriseHostError("invalid-value", "The team features storage file is not a JSON object.");
      }
      const stored = Object.entries(parsed);
      if (stored.length > ENTERPRISE_LIMITS.maxStorageKeys) {
        throw new EnterpriseHostError("limit", `The team features storage file holds more than ${ENTERPRISE_LIMITS.maxStorageKeys} keys.`);
      }
      for (const [key, value] of stored) {
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

const SANDBOX_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const UNAVAILABLE = Object.freeze({
  ok: false as const,
  error: Object.freeze({ code: "sandboxes-unavailable", message: "Sandboxes are not available in this build of OpenAdminOS." }),
});

/**
 * Wraps what the app lends a module. Every call checks that the host is
 * live and the licence not expired, checks its input, and returns a deep
 * frozen copy of plain JSON within the reply limit, so no app object,
 * function or secret crosses the boundary.
 */
function createCapabilities(
  options: CreateEnterpriseHostOptions,
  assertLive: () => void,
): Pick<EnterpriseHost, "organizations" | "agents" | "sandboxes"> {
  const capabilities = options.capabilities ?? {};
  const guard = () => {
    assertLive();
    if (options.entitlement().state === "expired") {
      throw new EnterpriseHostError("expired", "The team features licence and its grace period ended. Install a renewed licence, then restart OpenAdminOS.");
    }
  };
  const reply = async <T>(what: string, call: () => Promise<T>): Promise<T> => {
    guard();
    const value = await call();
    return checkJson(value, ENTERPRISE_LIMITS.maxIpcOutputBytes, `the reply from ${what}`) as T;
  };
  const result = async <T>(what: string, call: (() => Promise<EnterpriseResult<T>>) | undefined): Promise<EnterpriseResult<T>> => {
    guard();
    if (!call) return UNAVAILABLE;
    let value: EnterpriseResult<T>;
    try {
      value = await call();
    } catch (error) {
      options.log("error", "enterprise: a sandbox call failed", { call: what, error: errorMessage(error) });
      value = { ok: false, error: { code: "internal-error", message: `The sandbox request ${what} failed: ${errorMessage(error)}` } };
    }
    return checkJson(value, ENTERPRISE_LIMITS.maxIpcOutputBytes, `the reply from ${what}`) as EnterpriseResult<T>;
  };
  const sandboxes = capabilities.sandboxes;

  const organizations: EnterpriseOrganizations = Object.freeze({
    list: freezeFn(() => reply("organizations.list", async () => (capabilities.organizations ? capabilities.organizations.list() : []))),
  });
  const agents: EnterpriseAgents = Object.freeze({
    readOnlyCatalog: freezeFn(() => reply("agents.readOnlyCatalog", async () => (capabilities.agents ? capabilities.agents.readOnlyCatalog() : []))),
  });
  const sandboxApi: EnterpriseSandboxes = Object.freeze({
    list: freezeFn(() => reply("sandboxes.list", async () => (sandboxes ? sandboxes.list() : []))),
    pair: freezeFn((input: Parameters<EnterpriseSandboxes["pair"]>[0]) => {
      guard();
      const checked = checkPairInput(input);
      return result("sandboxes.pair", sandboxes && (() => sandboxes.pair(checked)));
    }),
    sync: freezeFn((sandboxId: string) => {
      guard();
      const id = checkSandboxId(sandboxId);
      return result("sandboxes.sync", sandboxes && (() => sandboxes.sync(id)));
    }),
    assign: freezeFn((sandboxId: string, entries: readonly EnterpriseSandboxAssignmentEntry[]) => {
      guard();
      const id = checkSandboxId(sandboxId);
      const checked = checkAssignmentEntries(entries);
      return result("sandboxes.assign", sandboxes && (() => sandboxes.assign(id, checked)));
    }),
    unpair: freezeFn((sandboxId: string) => {
      guard();
      const id = checkSandboxId(sandboxId);
      return result("sandboxes.unpair", sandboxes && (() => sandboxes.unpair(id)));
    }),
    status: freezeFn((sandboxId: string) => {
      guard();
      const id = checkSandboxId(sandboxId);
      return result("sandboxes.status", sandboxes && (() => sandboxes.status(id)));
    }),
  });
  return { organizations, agents, sandboxes: sandboxApi };
}

function checkSandboxId(value: unknown): string {
  if (typeof value !== "string" || !SANDBOX_ID.test(value)) {
    throw new EnterpriseHostError("invalid-value", `A sandbox id is letters, digits, dot, dash and underscore, up to ${ENTERPRISE_LIMITS.maxSandboxIdLength} characters.`);
  }
  return value;
}

function checkShortText(value: unknown, maxLength: number, what: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength || CONTROL.test(value)) {
    throw new EnterpriseHostError("invalid-value", `The ${what} must be one line of 1 to ${maxLength} characters.`);
  }
  return value;
}

function checkPairInput(input: unknown): { address: string; code: string; organizationId: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EnterpriseHostError("invalid-value", "Pairing takes an object with address, code and organizationId.");
  }
  const fields = input as Record<string, unknown>;
  return Object.freeze({
    address: checkShortText(fields.address, ENTERPRISE_LIMITS.maxSandboxAddressLength, "sandbox address"),
    code: checkShortText(fields.code, ENTERPRISE_LIMITS.maxPairingCodeLength, "pairing code"),
    organizationId: checkShortText(fields.organizationId, ENTERPRISE_LIMITS.maxOrganizationIdLength, "organization id"),
  });
}

function checkAssignmentEntries(entries: unknown): readonly EnterpriseSandboxAssignmentEntry[] {
  if (!Array.isArray(entries) || entries.length > ENTERPRISE_LIMITS.maxAssignmentEntries) {
    throw new EnterpriseHostError("invalid-value", `An assignment is a list of at most ${ENTERPRISE_LIMITS.maxAssignmentEntries} entries.`);
  }
  return Object.freeze(entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new EnterpriseHostError("invalid-value", "Each assignment entry is an object with agentId and intervalSeconds.");
    }
    const fields = entry as Record<string, unknown>;
    const intervalSeconds = fields.intervalSeconds;
    if (typeof intervalSeconds !== "number" || !Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
      throw new EnterpriseHostError("invalid-value", "intervalSeconds must be a positive whole number.");
    }
    return Object.freeze({
      agentId: checkShortText(fields.agentId, ENTERPRISE_LIMITS.maxAgentIdLength, "agent id"),
      intervalSeconds,
    });
  }));
}

/**
 * Checks that `value` is plain JSON within the size and depth limits and
 * returns a deep frozen copy, so the caller keeps no reference into it.
 * Bytes are counted during the walk, as the UTF-8 length of the value's
 * JSON text, so an oversized value is refused as soon as the limit is
 * passed instead of after copying all of it.
 */
export function checkJson(value: unknown, maxBytes: number, what: string): EnterpriseJson {
  return copyJson(value, 0, { remaining: maxBytes, maxBytes, what });
}

interface JsonBudget {
  remaining: number;
  readonly maxBytes: number;
  readonly what: string;
}

function spend(budget: JsonBudget, bytes: number): void {
  budget.remaining -= bytes;
  if (budget.remaining < 0) {
    throw new EnterpriseHostError("limit", `${capitalise(budget.what)} is larger than ${budget.maxBytes} bytes.`);
  }
}

function spendString(budget: JsonBudget, text: string): void {
  // The JSON text is at least the string's length plus two quotes; check
  // that first so a huge string is never serialised.
  if (text.length + 2 > budget.remaining) spend(budget, text.length + 2);
  spend(budget, Buffer.byteLength(JSON.stringify(text), "utf8"));
}

function copyJson(value: unknown, depth: number, budget: JsonBudget): EnterpriseJson {
  const { what } = budget;
  if (depth > ENTERPRISE_LIMITS.maxJsonDepth) {
    throw new EnterpriseHostError("limit", `${capitalise(what)} is nested deeper than ${ENTERPRISE_LIMITS.maxJsonDepth} levels.`);
  }
  if (value === null) {
    spend(budget, 4);
    return value;
  }
  if (typeof value === "boolean") {
    spend(budget, value ? 4 : 5);
    return value;
  }
  if (typeof value === "string") {
    spendString(budget, value);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new EnterpriseHostError("invalid-value", `${capitalise(what)} contains a number JSON cannot hold.`);
    spend(budget, JSON.stringify(value).length);
    return value;
  }
  if (Array.isArray(value)) {
    spend(budget, 2 + Math.max(0, value.length - 1));
    const out: EnterpriseJson[] = [];
    for (let index = 0; index < value.length; index += 1) {
      out.push(copyJson(value[index], depth + 1, budget));
    }
    return Object.freeze(out);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new EnterpriseHostError("invalid-value", `${capitalise(what)} contains a value that is not plain JSON.`);
    }
    const entries = Object.entries(value);
    spend(budget, 2 + Math.max(0, entries.length - 1));
    const out: Record<string, EnterpriseJson> = {};
    for (const [key, item] of entries) {
      spendString(budget, key);
      spend(budget, 1);
      // Defined, not assigned, so a "__proto__" key stays a plain own property.
      Object.defineProperty(out, key, { value: copyJson(item, depth + 1, budget), enumerable: true, writable: true, configurable: true });
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

function checkText(value: unknown, maxLength: number, what: string, phrases = false): string {
  if (typeof value !== "string") throw new EnterpriseHostError("invalid-value", `The ${what} must be text.`);
  const text = value.trim();
  if (text === "" || text.length > maxLength || CONTROL.test(text)) {
    throw new EnterpriseHostError("invalid-value", `The ${what} must be one line of 1 to ${maxLength} characters.`);
  }
  if (phrases) checkModuleText(value, what);
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
