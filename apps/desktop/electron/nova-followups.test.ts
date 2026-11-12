import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuditLogEventSeed } from "./audit-log.js";
import {
  NOVA_FOLLOW_UP_TOO_LATE,
  NOVA_FOLLOW_UP_TOO_SOON,
  NOVA_FOLLOW_UPS_DAILY_LIMIT,
  NOVA_FOLLOW_UPS_FULL,
  NovaFollowUps,
  novaFollowUpFireDecision,
} from "./nova-followups.js";
import { openNovaDatabase } from "./nova-memory.js";

function followUps(start = "2026-11-12T10:00:00.000Z") {
  let now = new Date(start);
  const events: AuditLogEventSeed[] = [];
  const store = new NovaFollowUps(openNovaDatabase(":memory:"), { audit: (batch) => events.push(...batch), clock: () => now });
  return { store, events, advance: (ms: number) => { now = new Date(now.getTime() + ms); }, now: () => now };
}

const input = { tenantId: "t1", organizationId: "o1", question: "Check compliance", providerId: "ollama" as const, model: "llama3", delayMinutes: 60 };

describe("Nova follow-ups", () => {
  it("refuses a delay under 1 minute or over 7 days", () => {
    const { store } = followUps();
    assert.throws(() => store.create({ ...input, delayMinutes: 0 }), { message: NOVA_FOLLOW_UP_TOO_SOON });
    assert.throws(() => store.create({ ...input, delayMinutes: 7 * 1440 + 1 }), { message: NOVA_FOLLOW_UP_TOO_LATE });
    assert.doesNotThrow(() => store.create({ ...input, delayMinutes: 1 }));
    assert.doesNotThrow(() => store.create({ ...input, delayMinutes: 7 * 1440 }));
  });

  it("refuses a sixth pending follow-up and a 21st in one day", () => {
    const { store, advance } = followUps();
    const created = Array.from({ length: 5 }, () => store.create(input));
    assert.throws(() => store.create(input), { message: NOVA_FOLLOW_UPS_FULL });
    for (const entry of created) store.cancel(entry.id);
    for (let index = 0; index < 15; index += 1) store.cancel(store.create(input).id);
    assert.throws(() => store.create(input), { message: NOVA_FOLLOW_UPS_DAILY_LIMIT });
    advance(86_400_001);
    assert.doesNotThrow(() => store.create(input));
  });

  it("is due at its time, runs once, and audits each step as a schedule", () => {
    const { store, events, advance } = followUps();
    const followUp = store.create(input);
    assert.equal(followUp.dueAt, "2026-11-12T11:00:00.000Z");
    assert.deepEqual(store.due(), []);
    advance(60 * 60_000);
    assert.deepEqual(store.due().map((entry) => entry.id), [followUp.id]);
    assert.equal(store.claim(followUp.id), true);
    assert.equal(store.claim(followUp.id), false);
    store.finish(followUp.id, "completed", { conversationId: "conv-1", from: "running" });
    assert.equal(store.finish(followUp.id, "failed"), undefined);
    const done = store.get(followUp.id);
    assert.equal(done?.status, "completed");
    assert.equal(done?.conversationId, "conv-1");
    assert.deepEqual(events.map((event) => event.type), ["nova.followup.created", "nova.followup.started", "nova.followup.completed"]);
    assert.ok(events.every((event) => event.initiator === "schedule" && event.source === "nova" && event.details.question === "Check compliance"));
  });

  it("cancels only a pending follow-up", () => {
    const { store, events } = followUps();
    const followUp = store.create(input);
    store.cancel(followUp.id);
    assert.equal(store.get(followUp.id)?.status, "cancelled");
    assert.throws(() => store.cancel(followUp.id), /already finished/);
    assert.ok(events.some((event) => event.type === "nova.followup.cancelled"));
    assert.equal(store.pendingCount(), 0);
  });

  it("marks a follow-up cut off by a quit as failed", () => {
    const { store, advance } = followUps();
    const followUp = store.create({ ...input, delayMinutes: 1 });
    advance(60_000);
    store.claim(followUp.id);
    assert.equal(store.recoverInterrupted(), 1);
    assert.equal(store.get(followUp.id)?.status, "failed");
  });

  it("deletes a disconnected tenant's follow-ups and audits the pending ones as cancelled first", () => {
    const { store, events } = followUps();
    store.create(input);
    store.create({ ...input, tenantId: "t2" });
    events.length = 0;
    assert.equal(store.purgeTenant("t1"), 1);
    assert.deepEqual(store.list("t1"), []);
    assert.equal(store.list("t2").length, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "nova.followup.cancelled");
    assert.equal(events[0]!.details.reason, "The organization was disconnected.");
  });

  it("runs only in its organization, with its provider and model, within an hour", () => {
    const followUp = { tenantId: "t1", organizationId: "o1", providerId: "ollama" as const, model: "llama3", dueAt: "2026-11-12T11:00:00.000Z" };
    const context = { now: new Date("2026-11-12T11:00:30.000Z"), activeTenantId: "t1", activeOrganizationId: "o1", tenantConnected: true, activeProviderId: "ollama" as const, activeModel: "llama3" };
    assert.equal(novaFollowUpFireDecision(followUp, context), "run");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeTenantId: "t2" }), "skipped-organization");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeOrganizationId: "o2" }), "skipped-organization");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, tenantConnected: false }), "skipped-organization");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeProviderId: "anthropic" }), "skipped-provider");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeModel: "other" }), "skipped-provider");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, now: new Date("2026-11-12T12:00:01.000Z") }), "missed");
  });
});
