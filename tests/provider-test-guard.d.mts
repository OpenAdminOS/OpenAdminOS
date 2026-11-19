export function assertProviderTestGuardActive(): void;
export function registerProviderFixtureDirectory(directory: string): void;
export function waitForProviderFixtureExit(executable: string): Promise<NodeJS.Signals | null>;
export function stubLoopbackConnectionRefused(): void;
export function allowLiveMcpOrigin(endpoint: string): void;
export function installProviderTestGuard(): void;
