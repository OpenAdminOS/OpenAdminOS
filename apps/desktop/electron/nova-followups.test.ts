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

const input = { tenantId: "t1", organizationId: "o1", question: "Check compliance", providerId: "ollama" as const, model: "llama3", delayMinutes: 60, providerLocal: true, providerEndpoint: "http://127.0.0.1:11434" };

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

  it("keeps the daily count through pruning and a Disconnect purge", () => {
    const { store, advance } = followUps();
    for (let index = 0; index < 20; index += 1) {
      store.cancel(store.create(input).id);
      advance(1000);
    }
    assert.equal(store.purgeTenant("t1"), 20);
    assert.throws(() => store.create(input), { message: NOVA_FOLLOW_UPS_DAILY_LIMIT });
    assert.throws(() => store.create({ ...input, tenantId: "t2" }), { message: NOVA_FOLLOW_UPS_DAILY_LIMIT });
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
    // A click set it; it ran on its own time.
    assert.deepEqual(events.map((event) => event.initiator), ["person", "schedule", "schedule"]);
    assert.ok(events.every((event) => event.source === "nova" && event.details.question === "Check compliance"));
  });

  it("cancels only a pending follow-up", () => {
    const { store, events } = followUps();
    const followUp = store.create(input);
    store.cancel(followUp.id);
    assert.equal(store.get(followUp.id)?.status, "cancelled");
    assert.throws(() => store.cancel(followUp.id), /already finished/);
    assert.equal(events.find((event) => event.type === "nova.followup.cancelled")?.initiator, "person");
    assert.equal(store.pendingCount(), 0);
  });

  it("counts pending follow-ups per organization for the panel", () => {
    const { store } = followUps();
    store.create(input);
    store.create(input);
    store.create({ ...input, tenantId: "t2", organizationId: "o2" });
    assert.equal(store.pendingCount("t1"), 2);
    assert.equal(store.pendingCount("t2"), 1);
    assert.equal(store.pendingCount("t3"), 0);
    assert.equal(store.pendingCount(), 3);
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

  it("keeps a disconnected tenant's follow-ups when the cancel events cannot be kept on disk", () => {
    const db = openNovaDatabase(":memory:");
    const store = new NovaFollowUps(db, { audit: () => undefined, auditDurably: () => { throw new Error("audit log and pending file unavailable"); } });
    store.create(input);
    assert.throws(() => store.purgeTenant("t1"), /pending file unavailable/);
    assert.equal(store.list("t1").length, 1, "nothing is deleted without its audit events");
  });

  it("stores where its provider ran and audits it", () => {
    const { store, events } = followUps();
    const followUp = store.create(input);
    assert.equal(store.get(followUp.id)?.providerLocal, true);
    assert.equal(store.get(followUp.id)?.providerEndpoint, "http://127.0.0.1:11434");
    assert.equal(events[0]!.details.providerLocal, true);
  });

  it("does not run when its local provider now runs off this device or at another endpoint", () => {
    const followUp = { tenantId: "t1", organizationId: "o1", providerId: "ollama" as const, model: "llama3", dueAt: "2026-11-12T11:00:00.000Z", providerLocal: true, providerEndpoint: "http://127.0.0.1:11434" };
    const context = { now: new Date("2026-11-12T11:00:30.000Z"), activeTenantId: "t1", activeOrganizationId: "o1", tenantConnected: true, activeProviderId: "ollama" as const, activeModel: "llama3", activeProviderLocal: true, activeProviderEndpoint: "http://127.0.0.1:11434" };
    assert.equal(novaFollowUpFireDecision(followUp, context), "run");
    // Loopback Ollama set later to a remote host keeps the provider id and model.
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeProviderLocal: false, activeProviderEndpoint: "https://ollama.example.com" }), "skipped-provider");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeProviderEndpoint: "http://127.0.0.1:11500" }), "skipped-provider");
    // The same endpoint no longer counted as on this device, for example a LAN address.
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeProviderLocal: false }), "skipped-provider");
    // A hosted provider has no endpoint; one set while it was hosted does not run on a local one.
    const hosted = { ...followUp, providerId: "anthropic" as const, providerLocal: false, providerEndpoint: undefined };
    const hostedContext = { ...context, activeProviderId: "anthropic" as const, activeProviderEndpoint: undefined };
    assert.equal(novaFollowUpFireDecision(hosted, { ...hostedContext, activeProviderLocal: false }), "run");
    assert.equal(novaFollowUpFireDecision(hosted, { ...hostedContext, activeProviderLocal: true }), "skipped-provider");
    const { providerLocal: _unknown, ...unrecorded } = hosted;
    assert.equal(novaFollowUpFireDecision(unrecorded, { ...hostedContext, activeProviderLocal: false }), "skipped-provider");
    // A follow-up from a build that did not record where its provider ran runs nowhere.
    const { providerLocal: _local, providerEndpoint: _endpoint, ...legacy } = followUp;
    assert.equal(novaFollowUpFireDecision(legacy, context), "skipped-provider");
  });

  it("runs only in its organization, with its provider and model, within an hour", () => {
    const followUp = { tenantId: "t1", organizationId: "o1", providerId: "ollama" as const, model: "llama3", dueAt: "2026-11-12T11:00:00.000Z", providerLocal: true };
    const context = { now: new Date("2026-11-12T11:00:30.000Z"), activeTenantId: "t1", activeOrganizationId: "o1", tenantConnected: true, activeProviderId: "ollama" as const, activeModel: "llama3", activeProviderLocal: true };
    assert.equal(novaFollowUpFireDecision(followUp, context), "run");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeTenantId: "t2" }), "skipped-organization");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeOrganizationId: "o2" }), "skipped-organization");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, tenantConnected: false }), "skipped-organization");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeProviderId: "anthropic" }), "skipped-provider");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, activeModel: "other" }), "skipped-provider");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, providerAllowed: false }), "skipped-provider");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, providerAllowed: true }), "run");
    assert.equal(novaFollowUpFireDecision(followUp, { ...context, now: new Date("2026-11-12T12:00:01.000Z") }), "missed");
  });
});
