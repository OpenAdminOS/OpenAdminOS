import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ScheduleAssignment } from "@openadminos/pairing";

import { AssignmentError, checkAssignment, effectiveSchedules } from "./assignments.js";
import { loadSandboxConfig } from "./config.js";
import { bundledHash, tempDir, TENANT, writeConfig } from "./test-support.js";

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof AssignmentError);
    return error.code;
  }
  return "accepted";
}

describe("schedule assignments", () => {
  const { dir, cleanup } = tempDir();
  const config = loadSandboxConfig(writeConfig(dir));
  cleanup();
  const assignment = (overrides: Partial<ScheduleAssignment> = {}): ScheduleAssignment => ({
    pairingId: "pairing-1",
    version: 2,
    organizationId: "org-1",
    tenantId: TENANT,
    entries: [{ agentId: "compliance-overview", templateSha256: bundledHash("compliance-overview"), intervalSeconds: 3600 }],
    issuedAt: new Date().toISOString(),
    ...overrides,
  });
  const check = (value: ScheduleAssignment, heldVersion?: number | "none") =>
    codeOf(() => checkAssignment(value, { config, pairingId: "pairing-1", heldVersion: heldVersion === "none" ? undefined : heldVersion ?? 1 }));

  it("accepts a newer assignment for this pairing whose agents pass the sandbox checks", () => {
    assert.equal(check(assignment()), "accepted");
    assert.equal(check(assignment({ version: 1 }), "none"), "accepted", "the first assignment");
  });

  it("names each refusal", () => {
    const entry = assignment().entries[0]!;
    assert.equal(check(assignment({ version: 1 })), "assignment-replayed");
    assert.equal(check(assignment({ pairingId: "pairing-0" })), "assignment-binding-mismatch");
    assert.equal(check(assignment({ organizationId: "org-2" })), "assignment-binding-mismatch");
    assert.equal(check(assignment({ entries: [{ ...entry, templateSha256: "0".repeat(64) }] })), "assignment-template-mismatch");
    assert.equal(check(assignment({ entries: [{ ...entry, intervalSeconds: 899 }] })), "assignment-interval-invalid");
    assert.equal(check(assignment({ entries: [{ agentId: "offboarding-agent", templateSha256: bundledHash("offboarding-agent"), intervalSeconds: 3600 }] })), "assignment-agent-refused");
    assert.equal(check(assignment({ entries: [{ agentId: "no-such-agent", templateSha256: "0".repeat(64), intervalSeconds: 3600 }] })), "assignment-agent-refused");
  });

  it("joins config and assigned schedules by agent id, with the config winning", () => {
    const value = assignment({
      entries: [
        { agentId: "find-inactive-devices", templateSha256: bundledHash("find-inactive-devices"), intervalSeconds: 7200 },
        { agentId: "compliance-overview", templateSha256: bundledHash("compliance-overview"), intervalSeconds: 3600 },
      ],
    });
    const { schedules, shadowed } = effectiveSchedules(config, value);
    assert.deepEqual(schedules.map((schedule) => [schedule.agent.id, schedule.source, schedule.agent.intervalSeconds]), [
      ["find-inactive-devices", "config", 3600],
      ["compliance-overview", "assigned", 3600],
    ]);
    assert.deepEqual(shadowed, ["find-inactive-devices"]);
    assert.deepEqual(effectiveSchedules(config, undefined).schedules.map((schedule) => schedule.source), ["config"]);
  });
});
