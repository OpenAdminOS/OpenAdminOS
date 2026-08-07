import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_REGISTRY_SOURCE,
  refreshRegistry,
  validateRegistrySource,
  verifyOfficialRegistrySignature,
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

      const firstSource = "https://registry-one.example/agents";
      const official = await refreshRegistry(dir, firstSource);
      assert.equal(official.entries.length, 1);
      assert.equal(official.fromCache, false);

      globalThis.fetch = async () => {
        throw new Error("offline");
      };

      const cachedOfficial = await refreshRegistry(dir, firstSource);
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

  it("does not cache a custom index that fails entry validation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-invalid-registry-"));
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            agents: [{ ...registryEntry("invalid-agent"), manifestSha256: "bad" }],
          }),
          { status: 200 },
        );
      const source = "https://registry-invalid.example/agents";
      const invalid = await refreshRegistry(dir, source);
      assert.equal(invalid.fromCache, false);
      assert.deepEqual(invalid.entries, []);
      assert.match(invalid.error ?? "", /manifest SHA-256 digest/);

      globalThis.fetch = async () => {
        throw new Error("offline");
      };
      const offline = await refreshRegistry(dir, source);
      assert.equal(offline.fromCache, false);
      assert.deepEqual(offline.entries, []);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("verifies the checked-in official index and rejects modified bytes", () => {
    const indexText = readFileSync(findRepoFile("agents/index.json"), "utf8");
    const signature = readFileSync(findRepoFile("agents/index.sig"), "utf8").trim();

    assert.equal(verifyOfficialRegistrySignature(indexText, signature), true);
    assert.equal(
      verifyOfficialRegistrySignature(`${indexText} `, signature),
      false,
    );
  });

  it("enforces the official signature during refresh and reuses only its verified cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-official-registry-"));
    const originalFetch = globalThis.fetch;
    const indexText = readFileSync(findRepoFile("agents/index.json"), "utf8");
    const signature = readFileSync(findRepoFile("agents/index.sig"), "utf8").trim();
    try {
      globalThis.fetch = async (input) =>
        new Response(String(input).endsWith("/index.sig") ? signature : indexText, {
          status: 200,
        });

      const live = await refreshRegistry(dir, DEFAULT_REGISTRY_SOURCE);
      assert.equal(live.fromCache, false);
      assert.equal(live.error, null);
      assert.ok(live.entries.length > 0);

      globalThis.fetch = async () => {
        throw new Error("offline");
      };
      const cached = await refreshRegistry(dir, DEFAULT_REGISTRY_SOURCE);
      assert.equal(cached.fromCache, true);
      assert.equal(cached.entries.length, live.entries.length);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an official refresh when the signature is missing or invalid", async () => {
    const indexText = JSON.stringify({
      schemaVersion: 1,
      agents: [registryEntry("official-agent")],
    });
    const originalFetch = globalThis.fetch;
    try {
      for (const signatureResponse of [
        new Response("missing", { status: 404 }),
        new Response("not-a-signature", { status: 200 }),
      ]) {
        const dir = await mkdtemp(join(tmpdir(), "openadminos-bad-signature-"));
        try {
          globalThis.fetch = async (input) =>
            String(input).endsWith("/index.sig")
              ? signatureResponse.clone()
              : new Response(indexText, { status: 200 });
          const result = await refreshRegistry(dir, DEFAULT_REGISTRY_SOURCE);
          assert.equal(result.fromCache, false);
          assert.deepEqual(result.entries, []);
          assert.ok(result.error);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an older signed official revision after a newer verified revision was cached", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-registry-replay-"));
    const originalFetch = globalThis.fetch;
    const indexText = readFileSync(findRepoFile("agents/index.json"), "utf8");
    const signature = readFileSync(findRepoFile("agents/index.sig"), "utf8").trim();
    const index = JSON.parse(indexText) as { revision: number; agents: unknown[] };
    const newerRevision = index.revision + 1;
    try {
      await mkdir(join(dir, "registry-cache"), { recursive: true });
      await writeFile(
        join(dir, "registry-cache", "index.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          revision: newerRevision,
          agents: index.agents,
          cachedAt: "2026-08-06T00:00:00.000Z",
          sourceUrl: DEFAULT_REGISTRY_SOURCE,
          signatureVerified: true,
        })}\n`,
        "utf8",
      );
      globalThis.fetch = async (input) =>
        new Response(String(input).endsWith("/index.sig") ? signature : indexText, {
          status: 200,
        });

      const result = await refreshRegistry(dir, DEFAULT_REGISTRY_SOURCE);
      assert.equal(result.fromCache, true);
      assert.equal(result.entries.length, index.agents.length);
      assert.match(result.error ?? "", /replay rejected/i);
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
    manifestSha256: "0".repeat(64),
  };
}

function findRepoFile(relativePath: string): string {
  let current = process.cwd();
  while (true) {
    const candidate = join(current, relativePath);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      const parent = join(current, "..");
      if (parent === current) throw new Error(`Unable to find ${relativePath}`);
      current = parent;
    }
  }
}
