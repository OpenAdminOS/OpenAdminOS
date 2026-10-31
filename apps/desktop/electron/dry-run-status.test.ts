import assert from "node:assert/strict";
import { it } from "node:test";
import type { AgentSummary, RunRecord, TenantRecord } from "@openadminos/agent-sdk";
import { isTerminalRunStatus, runNotificationTitle } from "./state-helpers.js";
import {
  evaluateRunDeliveryRule,
  formatTeamsDeliveryMessage,
  formatWhatsAppDeliveryMessage,
  formatOutlookDeliveryMessage,
  formatChatDeliveryMessage,
  formatPlainDeliveryMessage,
  formatDeliveryEmailSubject,
} from "./run-delivery-format.js";

it("formats dry runs as terminal, unapplied results in notifications and every delivery format", () => {
  const run = { id: "dry", agentSlug: "test", status: "planned", dryRun: true,
    queuedAt: "2026-10-31T12:00:00Z", steps: [], logs: [], summary: "One proposed change." } satisfies RunRecord;
  const agent = { name: "Test" } as AgentSummary;
  const tenant = { displayName: "Test tenant" } as TenantRecord;
  assert.equal(isTerminalRunStatus(run.status), true);
  assert.equal(runNotificationTitle(run), "Dry run: not applied");
  for (const format of [formatTeamsDeliveryMessage, formatWhatsAppDeliveryMessage, formatOutlookDeliveryMessage, formatChatDeliveryMessage, formatPlainDeliveryMessage]) {
    const text = format(run, agent, tenant);
    assert.match(text, /Dry run: not applied/);
    assert.doesNotMatch(text, /Failed|Awaiting confirmation/);
  }
  assert.match(formatDeliveryEmailSubject(run, agent), /dry run: not applied/);
  for (const status of ["planned", "failed"] as const) {
    const result = evaluateRunDeliveryRule({ ...run, status }, { notifyOnSuccess: true, notifyOnFailure: true }, "Teams");
    assert.equal(result.shouldSend, false);
    assert.match(result.detail, /disabled for dry runs/);
  }
});
