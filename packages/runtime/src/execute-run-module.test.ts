import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentModule, AgentSummary } from "@openadminos/agent-sdk";

import { createQueuedRun, executeRun } from "./index.js";

const agent = {
  id: "not-on-disk",
  slug: "not-on-disk",
  name: "Not on disk",
  description: "A module the host built itself.",
  mode: "read",
  category: "devices",
  scopes: [],
  author: { name: "Test", handle: "test", verified: true },
  version: "1.0.0",
  installedAt: new Date(0).toISOString(),
} as unknown as AgentSummary;

describe("executeRun with a module from the host", () => {
  it("runs the given module instead of loading a manifest from disk", async () => {
    const module = { mode: "read", run: async () => ({ summary: "ran the given module" }) } as unknown as AgentModule;
    const run = await executeRun({
      run: createQueuedRun({ agent, providerId: "ollama" }),
      agent,
      providerId: "ollama",
      createGraph: () => ({}) as never,
      module,
      onProgress: () => undefined,
    });
    assert.equal(run.status, "completed");
    assert.equal(run.summary, "ran the given module");
  });
});
