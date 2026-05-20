/**
 * Detect a tenant's Entra ID licensing tier by inspecting the
 * subscribed SKUs and looking for the well-known service-plan names
 * that grant Azure AD Premium P1 / P2.
 *
 * Required scope: `Organization.Read.All` (delegated). The probe
 * returns `"unknown"` on any failure — the caller treats `unknown` as
 * informational (badges shown, runs not blocked) rather than as a
 * negative confirmation.
 */

import type { DetectedEntraTier } from "@openagents/agent-sdk";

const AAD_PREMIUM_P1_SERVICE_PLAN = "AAD_PREMIUM";
const AAD_PREMIUM_P2_SERVICE_PLAN = "AAD_PREMIUM_P2";

interface ServicePlan {
  servicePlanName?: string;
  provisioningStatus?: string;
}

interface SubscribedSku {
  capabilityStatus?: string;
  servicePlans?: ServicePlan[];
}

interface SubscribedSkusResponse {
  value?: SubscribedSku[];
}

/**
 * Fetch /subscribedSkus and compute the highest Entra ID tier the
 * tenant is licensed for. Returns `"unknown"` on any error (missing
 * scope, network failure, unexpected shape). Callers should treat
 * `"unknown"` as "tier badge informational, do not block runs."
 */
export async function detectEntraTier(
  tokenProvider: (scopes: string[]) => Promise<string>,
  baseUrl = "https://graph.microsoft.com/beta",
  fetchImpl: typeof fetch = fetch,
): Promise<DetectedEntraTier> {
  try {
    const token = await tokenProvider(["Organization.Read.All"]);
    const response = await fetchImpl(`${baseUrl}/subscribedSkus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return "unknown";
    const body = (await response.json()) as SubscribedSkusResponse;
    return classifySkus(body.value ?? []);
  } catch {
    return "unknown";
  }
}

export function classifySkus(skus: SubscribedSku[]): DetectedEntraTier {
  const enabled = skus.filter((s) => s.capabilityStatus === "Enabled");
  let hasP1 = false;
  let hasP2 = false;
  for (const sku of enabled) {
    for (const plan of sku.servicePlans ?? []) {
      // `Success` is the canonical "this plan is active" status. Some
      // tenants temporarily show `Warning` (e.g. mid-provisioning) —
      // we don't count those, so we never over-report a tier the user
      // can't actually use today.
      if (plan.provisioningStatus !== "Success") continue;
      if (plan.servicePlanName === AAD_PREMIUM_P2_SERVICE_PLAN) hasP2 = true;
      else if (plan.servicePlanName === AAD_PREMIUM_P1_SERVICE_PLAN) hasP1 = true;
    }
  }
  if (hasP2) return "p2";
  if (hasP1) return "p1";
  return "free";
}

/**
 * Compare a tenant's detected tier against an agent's minimum tier
 * requirement. Returns:
 *   - `true` if the tenant satisfies the requirement
 *   - `false` if it falls short
 *   - `"unknown"` if we cannot decide (tenant tier not yet probed)
 *
 * Callers use the `"unknown"` result to avoid blocking runs while the
 * probe hasn't completed; the UI still surfaces the agent's stated
 * requirement so the admin knows what to expect.
 */
export function tenantSatisfiesRequirement(
  detected: DetectedEntraTier | undefined,
  required: "free" | "p1" | "p2",
): boolean | "unknown" {
  if (!detected || detected === "unknown") return "unknown";
  const rank: Record<"free" | "p1" | "p2", number> = { free: 0, p1: 1, p2: 2 };
  return rank[detected] >= rank[required];
}
