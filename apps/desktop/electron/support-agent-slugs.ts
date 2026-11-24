import type { AgentSummary, RegistryAgentSummary } from "@openadminos/agent-sdk";
import { DEFAULT_REGISTRY_SOURCE } from "./registry-client.js";

interface AgentCatalog {
  registrySource: string;
  registryAgents: readonly Pick<RegistryAgentSummary, "slug" | "manifestUrl">[];
  installedAgents: readonly Pick<AgentSummary, "slug" | "provenance">[];
}

export function publicSupportAgentSlugs(catalog: AgentCatalog): ReadonlySet<string> {
  const publicSlugs = new Set<string>();
  if (catalog.registrySource !== DEFAULT_REGISTRY_SOURCE) return publicSlugs;

  const officialSlugs = new Set(
    catalog.registryAgents
      .filter(({ slug, manifestUrl }) => isOfficialManifest(slug, manifestUrl))
      .map(({ slug }) => slug),
  );

  for (const { slug, provenance } of catalog.installedAgents) {
    if (
      officialSlugs.has(slug) &&
      provenance?.source === "registry" &&
      isOfficialManifest(slug, provenance.manifestUrl)
    ) {
      publicSlugs.add(slug);
    }
  }
  return publicSlugs;
}

function isOfficialManifest(slug: string, manifestUrl: string | undefined): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) &&
    manifestUrl === `${DEFAULT_REGISTRY_SOURCE}/${slug}/manifest.yaml`;
}
