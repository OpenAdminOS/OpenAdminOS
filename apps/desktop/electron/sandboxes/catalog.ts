import { createHash } from "node:crypto";

import type { RegistryAgentSummary } from "@openadminos/agent-sdk";
import type { EnterpriseReadOnlyAgent } from "@openadminos/enterprise";
import { listBuiltInRegistryAgents, loadAgentManifestPreview } from "@openadminos/runtime";

/**
 * The bundled read-only agents a sandbox can run, with the SHA-256 of
 * each manifest.yaml. A sandbox runs bundled agents only and compares the
 * hash with its own copy, so an agent installed from the registry or
 * written by the admin is not offered.
 */
export function readOnlyCatalog(
  agents: () => RegistryAgentSummary[] = listBuiltInRegistryAgents,
  preview: (agent: RegistryAgentSummary) => { sourceText: string } | undefined = loadAgentManifestPreview,
): EnterpriseReadOnlyAgent[] {
  const catalog: EnterpriseReadOnlyAgent[] = [];
  for (const agent of agents()) {
    if (agent.mode !== "read") continue;
    let source: string | undefined;
    try {
      source = preview(agent)?.sourceText;
    } catch {
      // An invalid manifest is listed by the agent screens; it is not offered here.
      continue;
    }
    if (source === undefined) continue;
    catalog.push({
      id: agent.id,
      name: agent.name,
      scopes: [...agent.scopes],
      manifestSha256: createHash("sha256").update(source, "utf8").digest("hex"),
    });
  }
  return catalog.sort((left, right) => left.id.localeCompare(right.id));
}
