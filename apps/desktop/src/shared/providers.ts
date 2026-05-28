import type { ProviderId } from "./openAdminOS.js";

const IMPLEMENTED_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set([
  "ollama",
  "openai",
]);

export function isProviderImplemented(id: ProviderId): boolean {
  return IMPLEMENTED_PROVIDER_IDS.has(id);
}
