import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  findRegistryAgentById,
  listAllRegistryAgents,
  listAllRegistryAgentsWithIssues,
  listBuiltInRegistryAgents,
} from "./index.js";

function manifest(id: string, services: string): string {
  return `
descriptor:
  id: ${id}
  name: ${id}
  description: Lists managed devices.
  version: 1.0.0
  author:
    name: Local
  category: devices
  mode: read
${services}
skills:
  - id: devices
    format: graph
    label: Load devices
    settings:
      method: GET
      path: /deviceManagement/managedDevices
      scopes:
        - DeviceManagementManagedDevices.Read.All
definition:
  result:
    summary: Done.
`;
}

async function userRoot(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "openadminos-registry-listing-"));
  for (const [folder, text] of Object.entries(entries)) {
    await mkdir(join(root, folder), { recursive: true });
    await writeFile(join(root, folder, "manifest.yaml"), text, "utf8");
  }
  return root;
}

describe("registry listing with an invalid local manifest", () => {
  it("lists the valid agents and one entry per invalid manifest", async () => {
    const root = await userRoot({
      "local-devices": manifest("local-devices", "  services:\n    - intune"),
      "wrong-services": manifest("wrong-services", "  services:\n    - entra"),
      "broken-yaml": "descriptor: [unclosed\n",
    });
    try {
      const listing = listAllRegistryAgentsWithIssues(root);
      const slugs = listing.agents.map((agent) => agent.slug);
      assert.ok(slugs.includes("local-devices"));
      assert.ok(!slugs.includes("wrong-services"));
      // Bundled agents still load next to the invalid local ones.
      assert.ok(listBuiltInRegistryAgents().every((agent) => slugs.includes(agent.slug)));

      assert.deepEqual(
        listing.invalid.map(({ id, folder, registryPath, manifestPath, source }) => ({
          id, folder, registryPath, manifestPath, source,
        })),
        [
          {
            id: "broken-yaml",
            folder: "broken-yaml",
            registryPath: join(root, "broken-yaml"),
            manifestPath: join(root, "broken-yaml", "manifest.yaml"),
            source: "user",
          },
          {
            id: "wrong-services",
            folder: "wrong-services",
            registryPath: join(root, "wrong-services"),
            manifestPath: join(root, "wrong-services", "manifest.yaml"),
            source: "user",
          },
        ],
      );
      const wrong = listing.invalid.find((entry) => entry.id === "wrong-services");
      assert.equal(
        wrong?.reason,
        "descriptor.services: [entra] does not cover DeviceManagementManagedDevices.Read.All; these scopes belong to intune",
      );
      assert.equal(wrong?.sourceText, manifest("wrong-services", "  services:\n    - entra"));
      assert.ok(listing.invalid.find((entry) => entry.id === "broken-yaml")?.reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps listAllRegistryAgents and findRegistryAgentById working", async () => {
    const root = await userRoot({
      "local-devices": manifest("local-devices", "  services:\n    - intune"),
      "wrong-services": manifest("wrong-services", "  services:\n    - entra"),
    });
    try {
      assert.ok(listAllRegistryAgents(root).some((agent) => agent.slug === "local-devices"));
      assert.equal(findRegistryAgentById("local-devices", root)?.slug, "local-devices");
      assert.equal(findRegistryAgentById("wrong-services", root), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
