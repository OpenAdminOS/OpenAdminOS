import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";

import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

async function makeStore(usageTelemetryUrl: string): Promise<{
  store: AppStateStore;
  cleanup(): Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "openadminos-usage-"));
  const statePath = join(dir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      activeProviderId: "ollama",
      installId: "anon-test",
      installedAgents: [],
      runs: [],
      tenants: [],
    }),
    "utf8",
  );
  const store = new AppStateStore({
    filePath: statePath,
    tokenStore,
    userDataPath: dir,
    statsApiUrl: "",
    usageTelemetryUrl,
    appVersion: "0.5.0",
  });
  return {
    store,
    async cleanup() {
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const COLLECTOR = "https://collector.example";

describe("opt-in usage telemetry gate", () => {
  // Count only requests to the collector; provider probing (e.g. a
  // local Ollama check) also uses fetch and is not telemetry.
  let collectorCalls: string[];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    collectorCalls = [];
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      if (String(url).startsWith(COLLECTOR)) {
        collectorCalls.push(String(init?.body ?? ""));
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("never sends when disabled, even with an endpoint configured", async () => {
    const { store, cleanup } = await makeStore(COLLECTOR);
    try {
      const preview = await store.getUsageTelemetryPreview();
      assert.equal(preview.enabled, false);
      assert.equal(preview.endpointConfigured, true);
      const result = await store.sendUsageTelemetry();
      assert.equal(result.sent, false);
      assert.equal(collectorCalls.length, 0, "no collector call when telemetry is off");
    } finally {
      await cleanup();
    }
  });

  it("sends the exact previewed payload once enabled", async () => {
    const { store, cleanup } = await makeStore(COLLECTOR);
    try {
      await store.setUsageTelemetryEnabled(true);
      const preview = await store.getUsageTelemetryPreview();
      // An explicit send (the same path the "test ping" button uses)
      // must reach the collector with the exact previewed payload.
      const result = await store.sendUsageTelemetry();
      assert.equal(result.sent, true);
      const previewBody = JSON.stringify(preview.payload);
      assert.ok(
        collectorCalls.includes(previewBody),
        "collector received the exact previewed payload",
      );
    } finally {
      await cleanup();
    }
  });

  it("stays inert when enabled but no endpoint is configured", async () => {
    const { store, cleanup } = await makeStore("");
    try {
      await store.setUsageTelemetryEnabled(true);
      const result = await store.sendUsageTelemetry();
      assert.equal(result.sent, false);
      assert.equal(collectorCalls.length, 0);
    } finally {
      await cleanup();
    }
  });
});
