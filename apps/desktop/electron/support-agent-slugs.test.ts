import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_REGISTRY_SOURCE } from "./registry-client.js";
import { publicSupportAgentSlugs } from "./support-agent-slugs.js";

const officialManifest = (slug: string) => `${DEFAULT_REGISTRY_SOURCE}/${slug}/manifest.yaml`;
const provenance = (slug: string) => ({
  source: "registry" as const,
  manifestUrl: officialManifest(slug),
  installedVersion: "1.0.0",
  installedAt: "2026-11-24",
});

test("only installed agents with confirmed official registry provenance can publish a slug", () => {
  const registryAgents = [
    { slug: "compliance-overview", manifestUrl: officialManifest("compliance-overview") },
    { slug: "local-copy", manifestUrl: officialManifest("local-copy") },
    { slug: "private-agent", manifestUrl: "https://example.invalid/private/manifest.yaml" },
    { slug: "bundled-agent", manifestUrl: officialManifest("bundled-agent") },
    { slug: "old-install", manifestUrl: officialManifest("old-install") },
  ];
  const installedAgents = [
    { slug: "compliance-overview", provenance: provenance("compliance-overview") },
    { slug: "local-copy", provenance: { ...provenance("local-copy"), source: "user" as const } },
    { slug: "private-agent", provenance: provenance("private-agent") },
    { slug: "bundled-agent", provenance: { ...provenance("bundled-agent"), source: "bundled" as const } },
    { slug: "old-install" },
    { slug: "unlisted", provenance: provenance("unlisted") },
  ];

  assert.deepEqual(
    [...publicSupportAgentSlugs({ registrySource: DEFAULT_REGISTRY_SOURCE, registryAgents, installedAgents })],
    ["compliance-overview"],
  );
  assert.equal(
    publicSupportAgentSlugs({ registrySource: "https://example.invalid/private", registryAgents, installedAgents }).size,
    0,
  );
});
