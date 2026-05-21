import type { ProviderId } from "./openAdminOS.js";

// TODO(uli): implementations for these land in v0.2 alongside keytar OS
// keychain support. Until then the UI surfaces them as "Coming in 0.2"
// and disables selection so users can't pick a non-functional provider.
const IMPLEMENTED_PROVIDER_IDS: ReadonlySet<ProviderId> = new Set(["ollama"]);

export function isProviderImplemented(id: ProviderId): boolean {
  return IMPLEMENTED_PROVIDER_IDS.has(id);
}
