import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentSummary } from "@openadminos/agent-sdk";

import { companionUpcomingSchedules, runDueCompanionSchedules } from "./companion-schedules.js";

function agent(slug: string, organizationId?: string): AgentSummary {
  return {
    id: slug, slug, name: slug, description: "", mode: "read", category: "devices", tier: "agent",
    requiresEntraTier: "free", scopes: [], author: { name: "OpenAdminOS" }, version: "1.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    schedule: { enabled: true, intervalSeconds: 3600, lastScheduledRunAt: "2026-01-01T00:00:00.000Z", ...(organizationId ? { organizationId } : {}) },
  } as AgentSummary;
}

describe("menu bar upcoming schedules (review round 1)", () => {
  it("lists only the active organization's schedules", () => {
    const state = {
      installedAgents: [agent("mine", "org-a"), agent("theirs", "org-b"), agent("unassigned")],
      runs: [],
      activeOrganizationId: "org-a",
    };
    assert.deepEqual(companionUpcomingSchedules(state).map((item) => item.agentSlug), ["mine"]);
  });

  it("lists nothing with no organization active", () => {
    const state = { installedAgents: [agent("mine", "org-a")], runs: [], activeOrganizationId: undefined };
    assert.deepEqual(companionUpcomingSchedules(state), []);
  });
});

describe("menu bar run due (review round 2)", () => {
  it("counts other organizations' and unassigned schedules as waiting, never as errors", async () => {
    const started: string[] = [];
    const result = await runDueCompanionSchedules(
      {
        installedAgents: [agent("mine", "org-a"), agent("theirs", "org-b"), agent("unassigned"), { ...agent("writer", "org-a"), mode: "write" }],
        runs: [],
        activeOrganizationId: "org-a",
      },
      Date.parse("2026-11-09T12:00:00.000Z"),
      { startScheduledRun: async (entry) => void started.push(entry.slug) },
    );
    assert.deepEqual(started, ["mine"]);
    assert.deepEqual(result, {
      queued: 1,
      skippedWrite: 1,
      skippedInFlight: 0,
      skippedNotDue: 0,
      waitingOtherOrganization: 2,
      errors: [],
    });
  });

  it("waits on every schedule with no organization active", async () => {
    const result = await runDueCompanionSchedules(
      { installedAgents: [agent("mine", "org-a")], runs: [], activeOrganizationId: undefined },
      Date.parse("2026-11-09T12:00:00.000Z"),
      { startScheduledRun: async () => assert.fail("nothing may start") },
    );
    assert.equal(result.waitingOtherOrganization, 1);
    assert.equal(result.queued, 0);
    assert.deepEqual(result.errors, []);
  });
});
