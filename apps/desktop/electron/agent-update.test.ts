import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";
import { AppStateStore } from "./state.js";
import { DEFAULT_REGISTRY_SOURCE } from "./registry-client.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
  clear: async () => undefined,
};

describe("registry manifest integrity and update lifecycle", () => {
  for (const source of [DEFAULT_REGISTRY_SOURCE, "https://registry.example/agents"]) {
  it(`installs and updates unsigned agents with manifest integrity from ${source}`, async () => {
    const repoRoot = await findRepoRoot();
    const originalIndex = JSON.parse(
      await readFile(join(repoRoot, "agents", "index.json"), "utf8"),
    ) as { agents: Array<Record<string, unknown>> };
    const originalEntry = originalIndex.agents.find(
      (entry) => entry.slug === "find-inactive-devices",
    );
    assert.ok(originalEntry);
    const originalManifest = await readFile(
      join(repoRoot, "agents", "find-inactive-devices", "manifest.yaml"),
      "utf8",
    );
    const updatedManifest = originalManifest.replace(
      "version: 1.1.0",
      "version: 1.2.0",
    );
    assert.notEqual(updatedManifest, originalManifest);

    let currentManifest = originalManifest;
    let currentEntry: Record<string, unknown> & {
      manifestUrl: string;
      manifestSha256: string;
    } = {
      ...originalEntry,
      manifestUrl: `${source}/find-inactive-devices/manifest.yaml`,
      manifestSha256: digest(originalManifest),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === `${source}/index.json`) {
        return new Response(
          JSON.stringify({ schemaVersion: 1, revision: 1, agents: [currentEntry] }),
          { status: 200 },
        );
      }
      if (url === currentEntry.manifestUrl) {
        return new Response(currentManifest, { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const dir = await mkdtemp(join(tmpdir(), "openadminos-agent-update-"));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"),
      userDataPath: dir,
      tokenStore,
      statsApiUrl: "",
      appVersion: "0.4.0",
    });
    const manifestPath = join(
      dir,
      "agent-updates",
      "find-inactive-devices",
      "manifest.yaml",
    );

    try {
      await store.setRegistrySource(source, { confirmExternalSource: true });
      await store.installAgent("find-inactive-devices");
      assert.equal(await readFile(manifestPath, "utf8"), originalManifest);

      currentManifest = updatedManifest;
      currentEntry = {
        ...currentEntry,
        version: "1.2.0",
        manifestSha256: digest(updatedManifest),
      };
      await store.initRegistry();
      const review = await store.getAgentUpdateReview("find-inactive-devices");
      assert.equal(review.toVersion, "1.2.0");
      await store.updateAgent("find-inactive-devices");
      assert.equal(await readFile(manifestPath, "utf8"), updatedManifest);

      await store.uninstallAgent("find-inactive-devices");
      await assert.rejects(() => stat(manifestPath), /ENOENT/);
    } finally {
      store.close();
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  }

  it("rejects a manifest whose bytes do not match the registry digest", async () => {
    const repoRoot = await findRepoRoot();
    const source = "https://registry.example/agents";
    const index = JSON.parse(
      await readFile(join(repoRoot, "agents", "index.json"), "utf8"),
    ) as { agents: Array<Record<string, unknown>> };
    const entry = index.agents.find((item) => item.slug === "find-inactive-devices");
    assert.ok(entry);
    const manifest = await readFile(
      join(repoRoot, "agents", "find-inactive-devices", "manifest.yaml"),
      "utf8",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) =>
      String(input).endsWith("/index.json")
        ? new Response(
            JSON.stringify({
              schemaVersion: 1,
              agents: [
                {
                  ...entry,
                  manifestUrl: `${source}/find-inactive-devices/manifest.yaml`,
                  manifestSha256: "0".repeat(64),
                },
              ],
            }),
            { status: 200 },
          )
        : new Response(manifest, { status: 200 });

    const dir = await mkdtemp(join(tmpdir(), "openadminos-agent-digest-"));
    const store = new AppStateStore({
      filePath: join(dir, "state.json"),
      userDataPath: dir,
      tokenStore,
      statsApiUrl: "",
      appVersion: "0.4.0",
    });
    try {
      await store.setRegistrySource(source, { confirmExternalSource: true });
      await assert.rejects(
        () => store.installAgent("find-inactive-devices"),
        /digest did not match/,
      );
    } finally {
      store.close();
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Marketplace network failures (design and enterprise round)", () => {
  const unreachable = () => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND registry.example"), { code: "ENOTFOUND" }) });

  it("names the host, the system proxy and the fix when an agent's manifest cannot be fetched", async () => {
    const repoRoot = await findRepoRoot();
    const source = "https://registry.example/agents";
    const index = JSON.parse(await readFile(join(repoRoot, "agents", "index.json"), "utf8")) as { agents: Array<Record<string, unknown>> };
    const entry = index.agents.find((item) => item.slug === "find-inactive-devices");
    assert.ok(entry);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      if (String(input).endsWith("/index.json")) {
        return new Response(JSON.stringify({ schemaVersion: 1, agents: [{ ...entry, manifestUrl: `${source}/find-inactive-devices/manifest.yaml`, manifestSha256: "0".repeat(64) }] }), { status: 200 });
      }
      throw unreachable();
    };
    const dir = await mkdtemp(join(tmpdir(), "openadminos-agent-network-"));
    const store = new AppStateStore({ filePath: join(dir, "state.json"), userDataPath: dir, tokenStore, statsApiUrl: "", appVersion: "0.4.0", resolveProxy: async () => "PROXY proxy.contoso.com:8080" });
    try {
      await store.setRegistrySource(source, { confirmExternalSource: true });
      await assert.rejects(
        () => store.installAgent("find-inactive-devices"),
        /^Error: The Marketplace could not reach registry\.example: its name did not resolve\. This device has a system proxy \(proxy\.contoso\.com:8080\); OpenAdminOS connects directly and did not use it\. Ask your network team to allow direct HTTPS access to registry\.example, then try again\.$/,
      );
    } finally {
      store.close();
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("names the host when the Marketplace index cannot be checked", async () => {
    const { refreshRegistry } = await import("./registry-client.js");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw unreachable(); };
    const dir = await mkdtemp(join(tmpdir(), "openadminos-registry-network-"));
    try {
      const result = await refreshRegistry(dir, "https://registry.example/agents", { resolveProxy: async () => "DIRECT" });
      assert.match(result.error ?? "", /^The Marketplace could not reach registry\.example: its name did not resolve\. No system proxy is set, and OpenAdminOS connected directly\. Check the network connection, VPN and DNS, then try again\.$/);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function findRepoRoot(): Promise<string> {
  let current = process.cwd();
  while (true) {
    try {
      await stat(join(current, "agents", "index.json"));
      return current;
    } catch {
      const parent = join(current, "..");
      if (parent === current) throw new Error("Unable to find repository root");
      current = parent;
    }
  }
}
