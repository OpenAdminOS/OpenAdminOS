// The versioned interface between the OpenAdminOS desktop host and an
// optional team features module. This file is the contract: a module built
// against one interface version must keep working with every host that
// reports the same version. `interface.test.ts` fails on any change to the
// declarations below; an incompatible change needs a new version number.
//
// The host gives a module host APIs only. Nothing reachable from
// `EnterpriseHost` exposes tenant tokens, provider credentials, the keychain
// or any secret store, and writes to a tenant still go through the normal
// diff confirmation in the app.

/** The interface version this host implements. */
export const ENTERPRISE_INTERFACE_VERSION = 1 as const;

/** Every IPC channel a module registers is placed under this prefix. */
export const ENTERPRISE_IPC_PREFIX = "openadminos-enterprise:" as const;

/** The only values that cross the IPC and storage boundaries. */
export type EnterpriseJson =
  | null
  | boolean
  | number
  | string
  | readonly EnterpriseJson[]
  | { readonly [key: string]: EnterpriseJson };

/**
 * `active`: the licence is inside its validity window.
 * `grace`: the licence expired, but the grace period has not ended.
 * `expired`: the grace period ended while the app was running. The host
 * does not activate a module with an expired licence; this state is only
 * seen when the module asks again later in the same launch.
 */
export type EnterpriseLicenceState = "active" | "grace" | "expired";

export interface EnterpriseEntitlement {
  readonly state: EnterpriseLicenceState;
  readonly licenseeId: string;
  readonly features: readonly string[];
  /** Milliseconds since the Unix epoch. */
  readonly notBefore: number;
  /** Milliseconds since the Unix epoch. */
  readonly expiresAt: number;
  /** Milliseconds since the Unix epoch: `expiresAt` plus the grace period. */
  readonly graceEndsAt: number;
}

/**
 * Handles one IPC request from the renderer. The handler receives the
 * validated input only, never the IPC event, the sender or the window.
 */
export type EnterpriseIpcHandler = (
  input: EnterpriseJson,
) => EnterpriseJson | void | Promise<EnterpriseJson | void>;

/** A section the app shows in Settings while the module is active. */
export interface EnterpriseSettingsSection {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

/**
 * What the status strip shows while team features are active, for example
 * "Team service · Frankfurt · end-to-end encrypted".
 */
export interface EnterpriseStatusContribution {
  readonly label: string;
  readonly detail?: string;
}

/** Storage that belongs to the module alone, kept apart from app state. */
export interface EnterpriseStorage {
  get(key: string): Promise<EnterpriseJson | undefined>;
  set(key: string, value: EnterpriseJson): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<readonly string[]>;
}

export type EnterpriseLogFields = Readonly<Record<string, string | number | boolean>>;

export interface EnterpriseLog {
  info(message: string, fields?: EnterpriseLogFields): void;
  warn(message: string, fields?: EnterpriseLogFields): void;
  error(message: string, fields?: EnterpriseLogFields): void;
}

/** Everything a module can reach. The object and its members are frozen. */
export interface EnterpriseHost {
  readonly interfaceVersion: typeof ENTERPRISE_INTERFACE_VERSION;
  /** The licence as of now, checked again against the clock on each call. */
  entitlement(): EnterpriseEntitlement;
  /** Registers `openadminos-enterprise:<name>` for the renderer. */
  registerIpc(name: string, handler: EnterpriseIpcHandler): void;
  registerSettingsSection(section: EnterpriseSettingsSection): void;
  /** Sets or clears the status strip entry. */
  setStatusContribution(status: EnterpriseStatusContribution | undefined): void;
  readonly storage: EnterpriseStorage;
  readonly log: EnterpriseLog;
}

/** Returned by `activate`; the host calls `deactivate` when the app quits. */
export interface EnterpriseHandle {
  deactivate(): void | Promise<void>;
}

/**
 * The module's default export. `activate` is called once per launch, and
 * only when the app holds a valid licence. Returning `undefined` means the
 * module stays off; the host then removes anything it registered.
 */
export interface EnterpriseModule {
  readonly interfaceVersion: number;
  activate(host: EnterpriseHost): EnterpriseHandle | undefined;
}
