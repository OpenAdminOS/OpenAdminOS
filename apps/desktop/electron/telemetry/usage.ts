/**
 * Opt-in install and usage telemetry. Deliberately minimal: counts and
 * versions only, never tenant content, tenant ids, prompts, run
 * results, or error text. Off by default. The exact payload built here
 * is what the Privacy settings preview shows and what gets sent, so the
 * two can never diverge.
 */

import type { UsageTelemetryPayload } from "@openadminos/agent-sdk";

export type { UsageTelemetryPayload } from "@openadminos/agent-sdk";

export interface UsageTelemetryInput {
  installId: string;
  appVersion: string;
  platform: string;
  arch: string;
  /** Whether the active LLM provider runs locally. */
  providerIsLocal: boolean;
  tenantCount: number;
  installedAgentCount: number;
  runCount: number;
  /** Whether a local documentation retrieval index is installed. */
  retrievalIndexInstalled: boolean;
}

/**
 * Bucket a raw count into a coarse range so a specific number can never
 * fingerprint an install. Ranges only widen as the count grows.
 */
export function bucketCount(count: number): string {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 2) return "2";
  if (count <= 5) return "3-5";
  if (count <= 10) return "6-10";
  if (count <= 25) return "11-25";
  if (count <= 50) return "26-50";
  if (count <= 100) return "51-100";
  return "100+";
}

export function buildUsageTelemetryPayload(
  input: UsageTelemetryInput,
): UsageTelemetryPayload {
  return {
    schema: "openadminos-usage-1",
    installId: input.installId,
    appVersion: input.appVersion,
    os: input.platform,
    arch: input.arch,
    providerClass: input.providerIsLocal ? "local" : "hosted",
    tenants: bucketCount(input.tenantCount),
    agents: bucketCount(input.installedAgentCount),
    runs: bucketCount(input.runCount),
    retrievalIndex: input.retrievalIndexInstalled,
  };
}
