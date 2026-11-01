import type { ProviderId, ProviderSummary } from "./openAdminOS.js";
import { isProviderImplemented } from "./providers.js";

/**
 * Order in which a ready local provider is selected for a user who never
 * chose one. Hosted providers are deliberately absent: selecting one
 * automatically would send tenant data off the device.
 */
export const LOCAL_AUTO_SELECT_ORDER: readonly ProviderId[] = [
  "ollama",
  "lm-studio",
  "apple-foundation",
];

/**
 * Whether a provider can answer right now, for detection purposes. Follows
 * the host's run gate ("connected", or a configured Azure OpenAI deployment
 * at "available") and is stricter about models, so an embedding-only
 * Ollama or an unconfigured Azure placeholder never counts.
 */
export function isProviderReady(provider: ProviderSummary | undefined): boolean {
  if (!provider || !isProviderImplemented(provider.id)) return false;
  // Ollama counts only with a text-generation model. Azure OpenAI counts
  // only with a configured deployment: the catalog placeholder also reads
  // "available" before any check has run.
  if ((provider.id === "ollama" || provider.id === "azure-openai") && provider.models.length === 0) {
    return false;
  }
  return (
    provider.status === "connected" ||
    (provider.id === "azure-openai" && provider.status === "available")
  );
}

/**
 * The local provider to select for a user who has not chosen one, or
 * undefined when nothing should change: the active provider is already
 * ready, or no local provider is ready. Only providers whose endpoint is on
 * this device (`isLocal`) qualify.
 */
export function pickLocalProviderToAutoSelect(
  providers: readonly ProviderSummary[],
  activeProviderId: ProviderId,
): ProviderSummary | undefined {
  const active = providers.find((provider) => provider.id === activeProviderId);
  if (isProviderReady(active)) return undefined;
  for (const id of LOCAL_AUTO_SELECT_ORDER) {
    const candidate = providers.find((provider) => provider.id === id);
    if (candidate?.isLocal === true && isProviderReady(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Hosted providers that are ready on this device, shown first as
 * "Detected on this device" when no local provider is ready. They are
 * never selected automatically; the user picks one with a click. Empty
 * once the active provider is ready, since there is nothing left to pick.
 */
export function detectedHostedProviders(
  providers: readonly ProviderSummary[],
  activeProviderId: ProviderId,
): ProviderSummary[] {
  const active = providers.find((provider) => provider.id === activeProviderId);
  if (isProviderReady(active)) return [];
  if (providers.some((provider) => provider.isLocal && isProviderReady(provider))) {
    return [];
  }
  return providers.filter((provider) => !provider.isLocal && isProviderReady(provider));
}
