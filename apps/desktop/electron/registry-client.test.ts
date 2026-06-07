import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_REGISTRY_SOURCE,
  refreshRegistry,
  validateRegistrySource,
} from "./registry-client.js";

describe("registry source validation", () => {
  it("accepts and normalizes the official HTTPS source", () => {
    const result = validateRegistrySource(`${DEFAULT_REGISTRY_SOURCE}/`);

    assert.equal(result.sourceUrl, DEFAULT_REGISTRY_SOURCE);
    assert.equal(result.isOfficial, true);
    assert.equal(result.requiresTrustReview, false);
  });

  it("requires HTTPS for public sources", () => {
    assert.throws(
      () => validateRegistrySource("http://example.com/openadminos/agents"),
      /must use HTTPS/,
    );
  });

  it("rejects private and localhost sources unless the dev override is set", () => {
    assert.throws(
      () => validateRegistrySource("https://192.168.1.20/agents"),
      /Private or localhost/,
    );
    assert.throws(
      () => validateRegistrySource("http://localhost:4900/agents"),
      /OPENADMINOS_ALLOW_DEV_REGISTRY_SOURCE/,
    );

    assert.equal(
      validateRegistrySource("http://localhost:4900/agents", {
        allowDevSource: true,
      }).sourceUrl,
      "http://localhost:4900/agents",
    );
    assert.equal(
      validateRegistrySource("https://192.168.1.20/agents", {
        allowDevSource: true,
      }).sourceUrl,
      "https://192.168.1.20/agents",
    );
  });

  it("rejects credentials, query strings, fragments, and index.json paths", () => {
    assert.throws(
      () => validateRegistrySource("https://user:pass@example.com/agents"),
      /must not include credentials/,
    );
    assert.throws(
      () => validateRegistrySource("https://example.com/agents?branch=main"),
      /must not include query/,
    );
    assert.throws(
      () => validateRegistrySource("https://example.com/agents#main"),
      /must not include query/,
    );
    assert.throws(
      () => validateRegistrySource("https://example.com/agents/index.json"),
      /agent directory/,
    );
  });

  it("does not reuse cached agents from another source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-registry-"));
    const originalFetch = globalThis.fetch;
    try {
      await mkdir(join(dir, "registry-cache"), { recursive: true });
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            agents: [registryEntry("agent-from-official")],
          }),
          { status: 200 },
        );

      const official = await refreshRegistry(dir, DEFAULT_REGISTRY_SOURCE);
      assert.equal(official.entries.length, 1);
      assert.equal(official.fromCache, false);

      globalThis.fetch = async () => {
        throw new Error("offline");
      };

      const cachedOfficial = await refreshRegistry(dir, DEFAULT_REGISTRY_SOURCE);
      assert.equal(cachedOfficial.entries.length, 1);
      assert.equal(cachedOfficial.fromCache, true);

      const custom = await refreshRegistry(dir, "https://example.com/agents");
      assert.equal(custom.entries.length, 0);
      assert.equal(custom.fromCache, false);
      assert.match(custom.error ?? "", /offline/);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function registryEntry(slug: string) {
  return {
    id: slug,
    slug,
    name: "Test agent",
    description: "Test agent.",
    version: "1.0.0",
    mode: "read",
    category: "devices",
    tier: "agent",
    requiresEntraTier: "free",
    author: { name: "OpenAdminOS", verified: true },
    scopes: ["Device.Read.All"],
    minAppVersion: "0.0.0",
    manifestUrl: `${DEFAULT_REGISTRY_SOURCE}/${slug}/manifest.yaml`,
  };
}
