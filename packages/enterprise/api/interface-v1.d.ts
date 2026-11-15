export declare const ENTERPRISE_INTERFACE_VERSION: 1;
export declare const ENTERPRISE_IPC_PREFIX: "openadminos-enterprise:";
export type EnterpriseJson = null | boolean | number | string | readonly EnterpriseJson[] | {
    readonly [key: string]: EnterpriseJson;
};
export type EnterpriseLicenceState = "active" | "grace" | "expired";
export interface EnterpriseEntitlement {
    readonly state: EnterpriseLicenceState;
    readonly licenseeId: string;
    readonly features: readonly string[];
    readonly notBefore: number;
    readonly expiresAt: number;
    readonly graceEndsAt: number;
}
export type EnterpriseIpcHandler = (input: EnterpriseJson) => EnterpriseJson | void | Promise<EnterpriseJson | void>;
export interface EnterpriseSettingsSection {
    readonly id: string;
    readonly title: string;
    readonly description: string;
}
export interface EnterpriseStatusContribution {
    readonly label: string;
    readonly detail?: string;
}
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
export interface EnterpriseOrganization {
    readonly id: string;
    readonly name: string;
    readonly tenantId: string;
}
export interface EnterpriseOrganizations {
    list(): Promise<readonly EnterpriseOrganization[]>;
}
export interface EnterpriseReadOnlyAgent {
    readonly id: string;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly manifestSha256: string;
}
export interface EnterpriseAgents {
    readOnlyCatalog(): Promise<readonly EnterpriseReadOnlyAgent[]>;
}
export type EnterpriseResult<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: EnterpriseError;
};
export interface EnterpriseError {
    readonly code: string;
    readonly message: string;
}
export interface EnterpriseSandboxFailure {
    readonly code: string;
    readonly message: string;
    readonly at: string;
}
export interface EnterpriseSandbox {
    readonly sandboxId: string;
    readonly name: string;
    readonly address: string;
    readonly organizationId: string;
    readonly tenantId: string;
    readonly pairedAt: string;
    readonly pairingKeyFingerprint: string;
    readonly state: "paired" | "stopped";
    readonly failure?: EnterpriseSandboxFailure;
    readonly lastSyncAt?: string;
    readonly auditSeq: number;
    readonly assignmentVersion: number;
}
export interface EnterpriseSandboxPairInput {
    readonly address: string;
    readonly code: string;
    readonly organizationId: string;
}
export interface EnterpriseSandboxSyncResult {
    readonly sandbox: EnterpriseSandbox;
    readonly runsImported: number;
    readonly runsVerified: number;
    readonly runsUnverified: number;
    readonly runsSkipped: number;
    readonly auditRowsAccepted: number;
    readonly auditBatches: number;
    readonly problems: readonly string[];
}
export interface EnterpriseSandboxAssignmentEntry {
    readonly agentId: string;
    readonly intervalSeconds: number;
}
export interface EnterpriseSandboxAssignResult {
    readonly version: number;
    readonly assigned: readonly string[];
    readonly shadowed: readonly string[];
    readonly rolesNoLongerNeeded: readonly string[];
    readonly notice?: string;
}
export interface EnterpriseSandboxUnpairResult {
    readonly sandboxId: string;
    readonly sandboxConfirmed: boolean;
    readonly rolesNoLongerNeeded: readonly string[];
    readonly message: string;
}
export interface EnterpriseSandboxRemoteStatus {
    readonly hostVersion: string;
    readonly bindingChanged: boolean;
    readonly model: {
        readonly provider: string;
        readonly model: string;
        readonly digest: string;
    };
    readonly assignmentVersion?: number;
    readonly schedules: readonly {
        readonly agentId: string;
        readonly source: "config" | "assigned";
        readonly intervalSeconds: number;
        readonly nextRunAt?: string;
        readonly status?: string;
    }[];
    readonly problems: readonly {
        readonly reason: string;
        readonly message: string;
    }[];
}
export interface EnterpriseSandboxStatus {
    readonly sandbox: EnterpriseSandbox;
    readonly remote?: EnterpriseSandboxRemoteStatus;
}
export interface EnterpriseSandboxes {
    list(): Promise<readonly EnterpriseSandbox[]>;
    pair(input: EnterpriseSandboxPairInput): Promise<EnterpriseResult<EnterpriseSandbox>>;
    sync(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxSyncResult>>;
    assign(sandboxId: string, entries: readonly EnterpriseSandboxAssignmentEntry[]): Promise<EnterpriseResult<EnterpriseSandboxAssignResult>>;
    unpair(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxUnpairResult>>;
    status(sandboxId: string): Promise<EnterpriseResult<EnterpriseSandboxStatus>>;
}
export interface EnterpriseHost {
    readonly interfaceVersion: typeof ENTERPRISE_INTERFACE_VERSION;
    entitlement(): EnterpriseEntitlement;
    registerIpc(name: string, handler: EnterpriseIpcHandler): void;
    registerSettingsSection(section: EnterpriseSettingsSection): void;
    setStatusContribution(status: EnterpriseStatusContribution | undefined): void;
    readonly storage: EnterpriseStorage;
    readonly log: EnterpriseLog;
    readonly organizations: EnterpriseOrganizations;
    readonly agents: EnterpriseAgents;
    readonly sandboxes: EnterpriseSandboxes;
}
export interface EnterpriseHandle {
    deactivate(): void | Promise<void>;
}
export interface EnterpriseModule {
    readonly interfaceVersion: number;
    activate(host: EnterpriseHost): EnterpriseHandle | undefined;
}
