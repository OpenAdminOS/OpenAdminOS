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
export interface EnterpriseHost {
    readonly interfaceVersion: typeof ENTERPRISE_INTERFACE_VERSION;
    entitlement(): EnterpriseEntitlement;
    registerIpc(name: string, handler: EnterpriseIpcHandler): void;
    registerSettingsSection(section: EnterpriseSettingsSection): void;
    setStatusContribution(status: EnterpriseStatusContribution | undefined): void;
    readonly storage: EnterpriseStorage;
    readonly log: EnterpriseLog;
}
export interface EnterpriseHandle {
    deactivate(): void | Promise<void>;
}
export interface EnterpriseModule {
    readonly interfaceVersion: number;
    activate(host: EnterpriseHost): EnterpriseHandle | undefined;
}
