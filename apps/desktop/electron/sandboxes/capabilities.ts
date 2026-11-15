import type {
  EnterpriseHostCapabilities,
  EnterpriseOrganization,
  EnterpriseReadOnlyAgent,
  EnterpriseSandboxes,
} from "@openadminos/enterprise";

import type { SandboxService } from "./service.js";

export interface SandboxCapabilitiesOptions {
  organizations(): Promise<readonly EnterpriseOrganization[]>;
  catalog(): Promise<readonly EnterpriseReadOnlyAgent[]>;
  /** Called on the first sandbox call only, so an unused service opens nothing. */
  createService(): SandboxService;
}

export interface SandboxCapabilities {
  readonly capabilities: EnterpriseHostCapabilities;
  /** Closes the service when one was created. */
  close(): void;
}

/** What the desktop lends the team features module: the calls, never the service or its keys. */
export function createSandboxCapabilities(options: SandboxCapabilitiesOptions): SandboxCapabilities {
  let service: SandboxService | undefined;
  const get = () => (service ??= options.createService());
  const sandboxes: EnterpriseSandboxes = {
    list: () => get().list(),
    pair: (input) => get().pair(input),
    sync: (sandboxId) => get().sync(sandboxId),
    assign: (sandboxId, entries) => get().assign(sandboxId, entries),
    unpair: (sandboxId) => get().unpair(sandboxId),
    status: (sandboxId) => get().status(sandboxId),
  };
  return {
    capabilities: {
      organizations: { list: () => options.organizations() },
      agents: { readOnlyCatalog: () => options.catalog() },
      sandboxes,
    },
    close: () => service?.close(),
  };
}
