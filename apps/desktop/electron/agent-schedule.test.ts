import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { TokenCacheStorage } from "@openadminos/runtime";
import { AppStateStore } from "./state.js";

const tokenStore: TokenCacheStorage = {
  read: async () => "",
  write: async () => undefined,
};

describe("agent scheduling", () => {
  it("anchors a newly enabled schedule so it does not fire immediately", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openadminos-schedule-"));
    const filePath = join(dir, "state.json");
    await writeFile(
      filePath,
      `${JSON.stringify({
        activeProviderId: "ollama",
        tenants: [],
        runs: [],
        installedAgents: [{
          id: "agent-1",
          slug: "agent-1",
          name: "Agent One",
          description: "Fixture",
          mode: "read",
          category: "devices",
          tier: "agent",
          requiresEntraTier: "free",
          scopes: [],
          author: { name: "OpenAdminOS", verified: true },
          version: "1.0.0",
          installedAt: "2025-01-01T00:00:00.000Z",
        }],
      }, null, 2)}\n`,
      "utf8",
    );
    const store = new AppStateStore({ filePath, tokenStore, statsApiUrl: "" });
    try {
      const before = Date.now();
      await store.updateAgentSchedule("agent-1", {
        enabled: true,
        intervalSeconds: 3600,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        notifyOnChangeOnly: false,
      });
      const schedule = await store.getAgentSchedule("agent-1");
      const anchor = Date.parse(schedule?.lastScheduledRunAt ?? "");
      assert.ok(anchor >= before && anchor <= Date.now());

      await store.fireDueSchedules();
      assert.equal((await store.getAppState()).runs.length, 0);

      await store.updateAgentSchedule("agent-1", {
        enabled: false,
        intervalSeconds: 3600,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        notifyOnChangeOnly: false,
        lastScheduledRunAt: "2025-01-01T00:00:00.000Z",
      });
      const beforeReenable = Date.now();
      await store.updateAgentSchedule("agent-1", {
        enabled: true,
        intervalSeconds: 3600,
        notifyOnSuccess: true,
        notifyOnFailure: true,
        notifyOnChangeOnly: false,
        lastScheduledRunAt: "2025-01-01T00:00:00.000Z",
      });
      const reenabled = await store.getAgentSchedule("agent-1");
      const reenabledAnchor = Date.parse(reenabled?.lastScheduledRunAt ?? "");
      assert.ok(reenabledAnchor >= beforeReenable && reenabledAnchor <= Date.now());

      await store.fireDueSchedules();
      assert.equal((await store.getAppState()).runs.length, 0);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
