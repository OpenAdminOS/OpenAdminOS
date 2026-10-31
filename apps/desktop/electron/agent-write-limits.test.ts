import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentSummary, RegistryAgentSummary, WriteLimits } from "@openadminos/agent-sdk";
import { parseAgentTemplate } from "@openadminos/runtime";
import { buildAgentUpdateReview } from "./agent-draft-helpers.js";
import { entryToRegistrySummary } from "./state-helpers.js";
import type { RegistryIndexEntry } from "./registry-client.js";
import { AppStateStore } from "./state.js";

const source = readFileSync(fileURLToPath(new URL("../../../agents/offboarding-agent/manifest.yaml", import.meta.url)), "utf8");

function review(before?: WriteLimits, after?: WriteLimits) {
  const parsedManifest = parseAgentTemplate(source);
  if (after) parsedManifest.descriptor.writeLimits = after;
  const previous: AgentSummary = {
    id: "offboarding-agent", slug: "offboarding-agent", name: "Offboarding agent", description: "Review changes.",
    mode: "write", category: "devices", tier: "agent", requiresEntraTier: "free", scopes: [], author: { name: "OpenAdminOS" }, version: "1.0.0", installedAt: "2026-10-31T00:00:00Z",
    ...(before ? { writeLimits: before } : {}),
  };
  const target: RegistryAgentSummary = { ...previous, registryId: previous.id, version: "1.1.0", ...(after ? { writeLimits: after } : {}) };
  return buildAgentUpdateReview({ previous, target, parsedManifest, manifestText: source, manifestSha256: "0".repeat(64) });
}

describe("write limit update review", () => {
  for (const [label, before, after, expected] of [
    ["raise total", { maxActions: 20 }, { maxActions: 30 }, "warn"],
    ["remove total", { maxActions: 200 }, undefined, "warn"],
    ["raise default", undefined, { maxActions: 200 }, "warn"],
    ["lower total", { maxActions: 30 }, { maxActions: 20 }, "info"],
    ["lower default", undefined, { maxActions: 20 }, "info"],
  ] as const) {
    it(`flags ${label} as ${expected}`, () => {
      const result = review(before, after);
      assert.equal(result.changes.find(c => c.id === "write-limit-total")?.severity, expected);
      if (expected === "warn") assert.equal(result.requiresConfirmation, true);
    });
  }

  for (const [label, before, after, expected] of [
    ["raise", 10, 20, "warn"], ["remove", 10, undefined, "warn"], ["lower", 20, 10, "info"], ["add", undefined, 10, "info"],
  ] as const) {
    it(`flags ${label} per-kind limit as ${expected}`, () => {
      const result = review(
        { maxActions: 100, ...(before ? { maxActionsPerOperation: { "graph-write": before } } : {}) },
        { maxActions: 100, ...(after ? { maxActionsPerOperation: { "graph-write": after } } : {}) },
      );
      assert.equal(result.changes.find(c => c.id === "write-limit-operation:graph-write")?.severity, expected);
    });
  }

  it("does not report unchanged limits", () => {
    const result = review({ maxActions: 50 }, { maxActions: 50 });
    assert.ok(!result.changes.some(c => c.id.startsWith("write-limit-")));
  });

  it("warns when a per-kind declaration rises even below a tighter total", () => {
    const result = review(
      { maxActions: 5, maxActionsPerOperation: { "graph-write": 10 } },
      { maxActions: 5, maxActionsPerOperation: { "graph-write": 20 } },
    );
    assert.equal(result.changes.find(c => c.id === "write-limit-operation:graph-write")?.severity, "warn");
  });

  it("carries registry limits into host summaries", () => {
    const writeLimits = { maxActions: 20, maxActionsPerOperation: { "graph-write": 10 } };
    const entry: RegistryIndexEntry = {
      id: "limited-agent", slug: "limited-agent", name: "Limited agent", description: "Review changes.",
      mode: "write", category: "devices", tier: "agent", scopes: [], author: { name: "OpenAdminOS", verified: true },
      version: "1.0.0", minAppVersion: "0.7.2", manifestUrl: "https://registry.example/limited-agent/manifest.yaml", manifestSha256: "0".repeat(64), writeLimits,
    };
    assert.deepEqual(entryToRegistrySummary(entry, "0.7.2").writeLimits, writeLimits);
  });
});

it("retains installed limits, reviews increases, and clears removed declarations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-limits-update-"));
  const registrySource = "https://registry.example/agents";
  const originalFetch = globalThis.fetch;
  const index = JSON.parse(readFileSync(fileURLToPath(new URL("../../../agents/index.json", import.meta.url)), "utf8")) as { agents: RegistryIndexEntry[] };
  const entry = index.agents.find(agent => agent.slug === "offboarding-agent")!;
  const parsed = parseAgentTemplate(source);
  const store = new AppStateStore({
    filePath: join(dir, "state.json"), userDataPath: dir, statsApiUrl: "", appVersion: "0.7.2",
    tokenStore: { read: async () => "", write: async () => undefined, clear: async () => undefined },
  });
  let manifestText = "";
  let nextEntry: RegistryIndexEntry;
  function update(version: string, limits?: WriteLimits) {
    parsed.descriptor.version = version;
    delete parsed.descriptor.writeLimits;
    if (limits) parsed.descriptor.writeLimits = limits;
    manifestText = JSON.stringify(parsed);
    const { writeLimits: _previousLimits, ...metadata } = entry;
    nextEntry = { ...metadata, version, manifestUrl: `${registrySource}/offboarding-agent/manifest.yaml`, manifestSha256: createHash("sha256").update(manifestText).digest("hex"), ...(limits ? { writeLimits: limits } : {}) };
  }
  update("1.1.0", { maxActions: 20 });
  globalThis.fetch = async input => String(input).endsWith("/index.json")
    ? new Response(JSON.stringify({ schemaVersion: 1, revision: 1, agents: [nextEntry] }))
    : new Response(manifestText);
  try {
    await store.setRegistrySource(registrySource, { confirmExternalSource: true });
    await store.installAgent("offboarding-agent");
    assert.deepEqual((await store.listAgents()).find(agent => agent.slug === "offboarding-agent")?.writeLimits, { maxActions: 20 });
    update("1.2.0", { maxActions: 30 });
    await store.initRegistry();
    assert.equal((await store.getAgentUpdateReview("offboarding-agent")).changes.find(change => change.id === "write-limit-total")?.severity, "warn");
    await assert.rejects(() => store.updateAgent("offboarding-agent"), /Review and confirm/);
    await store.updateAgent("offboarding-agent", { confirmTrustChanges: true });
    assert.deepEqual((await store.listAgents()).find(agent => agent.slug === "offboarding-agent")?.writeLimits, { maxActions: 30 });
    update("1.3.0");
    await store.initRegistry();
    assert.equal((await store.getAgentUpdateReview("offboarding-agent")).changes.find(change => change.id === "write-limit-total")?.severity, "warn");
    await store.updateAgent("offboarding-agent", { confirmTrustChanges: true });
    assert.equal((await store.listAgents()).find(agent => agent.slug === "offboarding-agent")?.writeLimits, undefined);
  } finally {
    store.close();
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});
