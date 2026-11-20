import type { ChildProcess } from "node:child_process";

export function assertProviderTestGuardActive(): void;
export function registerProviderFixtureDirectory(directory: string): void;
export function waitForProviderFixtureSpawn(executable: string): Promise<ChildProcess>;
export function stubLoopbackConnectionRefused(): void;
export function allowLiveMcpOrigin(endpoint: string): void;
export function installProviderTestGuard(): void;
