import type { ProviderId } from "./openAdminOS.js";

const IMPLEMENTED_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set([
  "ollama",
  "apple-foundation",
  "openai",
]);

export function isProviderImplemented(id: ProviderId): boolean {
  return IMPLEMENTED_PROVIDER_IDS.has(id);
}
