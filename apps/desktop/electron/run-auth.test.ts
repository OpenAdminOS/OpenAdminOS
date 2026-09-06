import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { RunGraphApi } from "@openadminos/agent-sdk";
import { AppStateStore } from "./state.js";

it("scheduled Graph access fails with recovery instructions without opening Microsoft sign-in", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-scheduled-auth-"));
  const filePath = join(dir, "state.json");
  await writeFile(filePath, JSON.stringify({ activeProviderId: "ollama", installedAgents: [], runs: [],
    activeTenantId: "tenant-1", tenants: [{ id: "tenant-1", displayName: "Test", username: "test@example.com", homeAccountId: "test", addedAt: new Date().toISOString() }] }));
  let browserCalls = 0;
  const store = new AppStateStore({ filePath, userDataPath: dir, statsApiUrl: "",
    tokenStore: { read: async () => "", write: async () => undefined },
    openBrowser: async () => { browserCalls += 1; },
  });
  // Force a missing cached account without contacting Microsoft.
  Object.defineProperty(store, "msalClientForTenant", { value: () => ({
    getTokenCache: () => ({ getAccountByHomeId: async () => null }),
  }) });
  try {
    const internal = store as unknown as { buildGraph(tenant: string, scopes: string[], execution: {
      signal: AbortSignal; allowInteractive: boolean; onAuthRequired(): Promise<void>;
    }): Promise<{ createGraph(log: () => void): RunGraphApi }> };
    const selection = await internal.buildGraph("tenant-1", ["Policy.Read.All"], {
      signal: new AbortController().signal, allowInteractive: false,
      onAuthRequired: async () => { throw new Error("Interactive flow must not start"); },
    });
    await assert.rejects(selection.createGraph(() => undefined).request({ method: "GET", path: "/identity/conditionalAccess/policies" }), /Scheduled run needs Microsoft sign-in/);
    assert.equal(browserCalls, 0);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
