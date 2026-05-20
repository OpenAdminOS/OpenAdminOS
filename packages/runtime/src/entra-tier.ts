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

import type { DetectedEntraTier, TenantLicense } from "@openagents/agent-sdk";

/**
 * SKU part numbers we surface in the Settings → Tenants license panel.
 * Limited to the SKUs an admin would actually reason about when
 * deciding "will the agents work" — Microsoft 365 / Office 365
 * Business + Enterprise tiers, EMS bundles, and the standalone Azure
 * AD Premium SKUs. Unknown SKUs are still persisted in raw form on
 * the tenant record (see TenantRecord.subscribedSkus) but excluded
 * from the surfaced list to keep the panel readable.
 *
 * Reference: https://learn.microsoft.com/en-us/entra/identity/users/licensing-service-plan-reference
 */
const RELEVANT_SKU_NAMES: Record<string, string> = {
  // Microsoft 365 Enterprise
  SPE_E3: "Microsoft 365 E3",
  SPE_E5: "Microsoft 365 E5",
  SPE_E5_NOPSTNCONF: "Microsoft 365 E5 (without audio conferencing)",
  // Microsoft 365 E7 — announced 2026-03-09, GA 2026-05-01. Bundles
  // E5 + Copilot + Agent 365 + Work IQ + Microsoft Entra Suite.
  // skuPartNumber is conventional (Microsoft's licensing reference
  // doc had not been updated at v0.2 ship). Variants mirror E5.
  SPE_E7: "Microsoft 365 E7",
  SPE_E7_NOPSTNCONF: "Microsoft 365 E7 (without audio conferencing)",
  SPE_E7_NOTEAMS: "Microsoft 365 E7 (without Teams)",
  SPE_F1: "Microsoft 365 F1",
  SPE_F3: "Microsoft 365 F3",
  // Microsoft 365 Business
  SPB: "Microsoft 365 Business Premium",
  O365_BUSINESS_ESSENTIALS: "Microsoft 365 Business Basic",
  O365_BUSINESS_PREMIUM: "Microsoft 365 Business Standard",
  O365_BUSINESS: "Microsoft 365 Apps for business",
  OFFICESUBSCRIPTION: "Microsoft 365 Apps for enterprise",
  // Office 365
  STANDARDPACK: "Office 365 E1",
  ENTERPRISEPACK: "Office 365 E3",
  ENTERPRISEPREMIUM: "Office 365 E5",
  ENTERPRISEPREMIUM_NOPSTNCONF: "Office 365 E5 (without audio conferencing)",
  // Enterprise Mobility + Security
  EMS: "Enterprise Mobility + Security E3",
  EMSPREMIUM: "Enterprise Mobility + Security E5",
  // Azure AD Premium standalones
  AAD_PREMIUM: "Microsoft Entra ID P1 (standalone)",
  AAD_PREMIUM_P2: "Microsoft Entra ID P2 (standalone)",
};

const AAD_PREMIUM_P1_SERVICE_PLAN = "AAD_PREMIUM";
const AAD_PREMIUM_P2_SERVICE_PLAN = "AAD_PREMIUM_P2";

interface ServicePlan {
  servicePlanName?: string;
  provisioningStatus?: string;
}

interface SubscribedSku {
  skuId?: string;
  skuPartNumber?: string;
  capabilityStatus?: string;
  servicePlans?: ServicePlan[];
  prepaidUnits?: {
    enabled?: number;
    suspended?: number;
    warning?: number;
  };
  consumedUnits?: number;
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
  const result = await probeSubscribedSkus(tokenProvider, baseUrl, fetchImpl);
  return result?.tier ?? "unknown";
}

/**
 * Single-call probe that returns both the Entra tier and the list of
 * tenant-relevant SKUs from one `/subscribedSkus` fetch. Saves a
 * round trip vs. calling `detectEntraTier` separately. Returns null
 * on any failure (callers treat as `tier: 'unknown'`, no licenses).
 */
export async function probeSubscribedSkus(
  tokenProvider: (scopes: string[]) => Promise<string>,
  baseUrl = "https://graph.microsoft.com/beta",
  fetchImpl: typeof fetch = fetch,
): Promise<{ tier: DetectedEntraTier; relevantLicenses: TenantLicense[] } | null> {
  try {
    const token = await tokenProvider(["Organization.Read.All"]);
    const response = await fetchImpl(`${baseUrl}/subscribedSkus`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as SubscribedSkusResponse;
    const skus = body.value ?? [];
    return {
      tier: classifySkus(skus),
      relevantLicenses: extractRelevantLicenses(skus),
    };
  } catch {
    return null;
  }
}

/**
 * Filter `/subscribedSkus` down to the subset an admin actually
 * thinks about — Microsoft 365 Business / Enterprise tiers, EMS
 * bundles, standalone Azure AD Premium. Unknown SKUs are dropped to
 * keep the surfaced license panel readable; the runtime persists the
 * tenant's full SKU list separately for future use.
 */
export function extractRelevantLicenses(skus: SubscribedSku[]): TenantLicense[] {
  const out: TenantLicense[] = [];
  for (const sku of skus) {
    if (sku.capabilityStatus !== "Enabled") continue;
    const partNumber = sku.skuPartNumber;
    if (!partNumber) continue;
    const displayName = RELEVANT_SKU_NAMES[partNumber];
    if (!displayName) continue;
    out.push({
      skuPartNumber: partNumber,
      displayName,
      enabledUnits: sku.prepaidUnits?.enabled ?? 0,
      consumedUnits: sku.consumedUnits ?? 0,
    });
  }
  // Sort by enabled units desc so the largest license shows first.
  return out.sort((a, b) => b.enabledUnits - a.enabledUnits);
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
