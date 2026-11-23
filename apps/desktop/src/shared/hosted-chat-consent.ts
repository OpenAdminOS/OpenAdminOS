import type { HostedOllamaDestination, ProviderId } from "./openAdminOS";

function hostedChatConsentKey(tenantId: string | undefined, providerId: ProviderId, model?: string, destination?: HostedOllamaDestination): string {
  // Tenant ids are GUIDs or the sample id, so the no-tenant key never
  // collides with one. The no-tenant decision also names the model, so a
  // model change asks again.
  const scope = tenantId ? `${tenantId}:${providerId}` : `no-tenant:${providerId}:${model ?? "default"}`;
  return `openadminos:intune-chat-hosted-consent:v3:${scope}${destination ? `:${destination}` : ""}`;
}

export function hasRememberedHostedChatConsent(
  tenantId: string | undefined,
  providerId: ProviderId,
  model?: string,
  destination?: HostedOllamaDestination,
): boolean {
  try {
    return window.localStorage.getItem(hostedChatConsentKey(tenantId, providerId, model, destination)) === "true";
  } catch {
    return false;
  }
}

export function rememberHostedChatConsent(tenantId: string | undefined, providerId: ProviderId, model?: string, destination?: HostedOllamaDestination): void {
  try {
    window.localStorage.setItem(hostedChatConsentKey(tenantId, providerId, model, destination), "true");
  } catch {
    // If localStorage is unavailable, the next hosted send will ask again.
  }
}
