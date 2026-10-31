import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { RunRecord } from "@openadminos/agent-sdk";
import { AppStateStore } from "./state.js";

it("migrates old run usage to null and preserves new usage through local persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-run-usage-"));
  const filePath = join(dir, "state.json");
  const old: RunRecord = { id: "old", agentSlug: "report", status: "completed", queuedAt: new Date().toISOString(), steps: [], logs: [], tokens: { promptTokens: 3, completionTokens: 2 } };
  const recent: RunRecord = { ...old, id: "recent", providerId: "azure-openai", model: "deployment", usage: { providerId: "azure-openai", model: "deployment", calls: 2, mixedModels: false, promptTokens: 100, completionTokens: 50, totalTokens: 150, costUsd: 0.02 } };
  await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], tenants: [], runs: [old, recent] }));
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: "", tokenStore: { read: async () => "", write: async () => undefined } });
  try {
    const state = await store.getAppState();
    assert.equal(state.runs[0]?.usage, null);
    assert.deepEqual(state.runs[0]?.tokens, old.tokens);
    assert.deepEqual(state.runs[1]?.usage, recent.usage);
    await store.setRunHistoryRetentionSettings({ neverPrune: true });
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as { runs: RunRecord[] };
    assert.equal(persisted.runs[0]?.usage, null);
    assert.deepEqual(persisted.runs[1]?.usage, recent.usage);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
