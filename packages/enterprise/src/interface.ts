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

/** An organization connected in the app: ids and name only. */
export interface EnterpriseOrganization {
  readonly id: string;
  readonly name: string;
  /** Lowercase Microsoft 365 tenant id. */
  readonly tenantId: string;
}

export interface EnterpriseOrganizations {
  /** Organizations whose Microsoft 365 tenant is connected now. */
  list(): Promise<readonly EnterpriseOrganization[]>;
}

/** A bundled read-only agent a sandbox can run. */
export interface EnterpriseReadOnlyAgent {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  /** SHA-256 hex of the agent's manifest.yaml. */
  readonly manifestSha256: string;
}

export interface EnterpriseAgents {
  readOnlyCatalog(): Promise<readonly EnterpriseReadOnlyAgent[]>;
}

/** Every sandbox call answers with a value or a named error; nothing is thrown across the interface. */
export type EnterpriseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: EnterpriseError };

export interface EnterpriseError {
  readonly code: string;
  readonly message: string;
}

/** Why sync stopped for a sandbox. It stays until the sandbox is paired again. */
export interface EnterpriseSandboxFailure {
  readonly code: string;
  readonly message: string;
  /** ISO 8601. */
  readonly at: string;
}

/** A sandbox paired with this desktop, as the desktop holds it. */
export interface EnterpriseSandbox {
  readonly sandboxId: string;
  readonly name: string;
  /** `<IP>:<port>`, IPv6 in brackets. */
  readonly address: string;
  readonly organizationId: string;
  readonly tenantId: string;
  /** ISO 8601. */
  readonly pairedAt: string;
  /** SHA-256 of the sandbox's device key, 52 Crockford base32 characters. */
  readonly pairingKeyFingerprint: string;
  /** `stopped`: an integrity failure stopped sync; pair again to recover. */
  readonly state: "paired" | "stopped";
  readonly failure?: EnterpriseSandboxFailure;
  readonly lastSyncAt?: string;
  /** The last audit row of the sandbox the desktop verified. */
  readonly auditSeq: number;
  /** The version of the last schedule assignment sent; 0 before the first. */
  readonly assignmentVersion: number;
}

export interface EnterpriseSandboxPairInput {
  readonly address: string;
  readonly code: string;
  readonly organizationId: string;
}

export interface EnterpriseSandboxSyncResult {
  readonly sandbox: EnterpriseSandbox;
  /** Runs added to or updated in run history. */
  readonly runsImported: number;
  /** Of those, runs whose finished event is in the verified audit rows. */
  readonly runsVerified: number;
  readonly runsUnverified: number;
  readonly auditRowsAccepted: number;
  readonly auditBatches: number;
  /** Runs the sandbox could not read or the desktop could not take, by run id and reason. */
  readonly problems: readonly string[];
}

export interface EnterpriseSandboxAssignmentEntry {
  /** A bundled read-only agent from `agents.readOnlyCatalog()`. */
  readonly agentId: string;
  readonly intervalSeconds: number;
}

export interface EnterpriseSandboxAssignResult {
  readonly version: number;
  readonly assigned: readonly string[];
  /** Assigned agents the sandbox config also lists; the config one runs. */
  readonly shadowed: readonly string[];
  /** Permissions only the agents that fell away needed. */
  readonly rolesNoLongerNeeded: readonly string[];
  readonly notice?: string;
}

export interface EnterpriseSandboxUnpairResult {
  readonly sandboxId: string;
  /** False when the sandbox could not be reached; it is unpaired on this desktop either way. */
  readonly sandboxConfirmed: boolean;
  readonly rolesNoLongerNeeded: readonly string[];
  readonly message: string;
}

/** What the sandbox reports about itself. No secrets, keys or tokens. */
export interface EnterpriseSandboxRemoteStatus {
  readonly hostVersion: string;
  readonly bindingChanged: boolean;
  readonly model: { readonly provider: string; readonly model: string; readonly digest: string };
  readonly assignmentVersion?: number;
  readonly schedules: readonly {
    readonly agentId: string;
    readonly source: "config" | "assigned";
    readonly intervalSeconds: number;
    readonly nextRunAt?: string;
    readonly status?: string;
  }[];
  readonly problems: readonly { readonly reason: string; readonly message: string }[];
}

export interface EnterpriseSandboxStatus {
  readonly sandbox: EnterpriseSandbox;
  /** Absent while sync is stopped: a stopped sandbox is not contacted. */
  readonly remote?: EnterpriseSandboxRemoteStatus;
}

/**
 * Sandboxes the customer runs, paired with this desktop. The desktop
 * holds the keys and verifies everything a sandbox sends; a module only
 * decides when to call. Nothing here runs on its own: without a call no
 * connection is made.
 */
export interface EnterpriseSandboxes {
  list(): Promise<readonly EnterpriseSandbox[]>;
  /** Pairs with the code the sandbox shows, for a connected organization. */
  pair(input: EnterpriseSandboxPairInput): Promise<EnterpriseResult<EnterpriseSandbox>>;
  /** Imports runs and verified audit rows since the last sync. */
  sync(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxSyncResult>>;
  /** Replaces the assigned schedules; read-only agents only. */
  assign(sandboxId: string, entries: readonly EnterpriseSandboxAssignmentEntry[]): Promise<EnterpriseResult<EnterpriseSandboxAssignResult>>;
  unpair(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxUnpairResult>>;
  status(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxStatus>>;
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
  readonly organizations: EnterpriseOrganizations;
  readonly agents: EnterpriseAgents;
  readonly sandboxes: EnterpriseSandboxes;
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
