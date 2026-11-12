import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AuditLogEventSeed } from "./audit-log.js";
import {
  NOVA_NOTES_FULL,
  NOVA_NOTES_PER_ORGANIZATION,
  NOVA_NOTES_PROMPT_MAX_CHARS,
  NovaMemory,
  openNovaDatabase,
} from "./nova-memory.js";

function memory(start = "2026-11-12T10:00:00.000Z") {
  let now = new Date(start);
  const events: AuditLogEventSeed[] = [];
  const store = new NovaMemory(openNovaDatabase(":memory:"), {
    audit: (batch) => events.push(...batch),
    clock: () => now,
  });
  return { store, events, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("Nova notes", () => {
  it("keeps provenance and review state, and audits the full text", () => {
    const { store, events } = memory();
    const note = store.propose({ tenantId: "t1", organizationId: "o1", text: "  The Berlin office uses   the Kiosk profile. ", source: "user-said", sessionId: "s1", conversationId: "c1", turnId: "u1" });
    assert.equal(note.text, "The Berlin office uses the Kiosk profile.");
    assert.equal(note.reviewState, "proposed");
    assert.equal(note.source, "user-said");
    assert.deepEqual([note.sessionId, note.conversationId, note.turnId, note.organizationId], ["s1", "c1", "u1", "o1"]);
    assert.ok(note.expiresAt);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, "nova.memory-note-proposed");
    assert.equal(events[0]!.source, "nova");
    assert.equal(events[0]!.tenantId, "t1");
    assert.equal(events[0]!.details.text, "The Berlin office uses the Kiosk profile.");
    assert.equal(events[0]!.details.conversationId, "c1");
    assert.equal(events[0]!.details.turnId, "u1");
  });

  it("never gives a proposed note to a prompt; a confirmed or edited one only for its tenant", () => {
    const { store, events } = memory();
    const proposed = store.propose({ tenantId: "t1", text: "Proposed only", source: "nova-proposed" });
    const confirmed = store.propose({ tenantId: "t1", text: "Confirmed fact", source: "user-said" });
    store.propose({ tenantId: "t2", text: "Other tenant", source: "user-said" });
    assert.deepEqual(store.promptNotes("t1"), []);
    store.confirm(confirmed.id);
    assert.deepEqual(store.promptNotes("t1"), ["Confirmed fact"]);
    store.edit(proposed.id, "Edited fact");
    assert.equal(store.get(proposed.id)?.reviewState, "edited");
    assert.equal(store.get(proposed.id)?.expiresAt, undefined);
    assert.deepEqual(new Set(store.promptNotes("t1")), new Set(["Confirmed fact", "Edited fact"]));
    assert.deepEqual(store.promptNotes("t2"), []);
    const types = events.map((event) => event.type);
    assert.ok(types.includes("nova.memory-note-confirmed"));
    const edited = events.find((event) => event.type === "nova.memory-note-edited");
    assert.equal(edited?.details.text, "Edited fact");
    assert.equal(edited?.details.previousText, "Proposed only");
  });

  it("keeps the prompt within its character budget, newest first", () => {
    const { store, advance } = memory();
    for (let index = 0; index < 12; index += 1) {
      const note = store.propose({ tenantId: "t1", text: `${index} ${"x".repeat(250)}`, source: "user-said" });
      advance(1000);
      store.confirm(note.id);
    }
    const notes = store.promptNotes("t1");
    assert.ok(notes.join("").length <= NOVA_NOTES_PROMPT_MAX_CHARS);
    assert.ok(notes[0]!.startsWith("11 "));
  });

  it("expires a proposed note after 30 days and keeps a confirmed one", () => {
    const { store, events, advance } = memory();
    const waiting = store.propose({ tenantId: "t1", text: "Waiting", source: "nova-proposed" });
    const kept = store.propose({ tenantId: "t1", text: "Kept", source: "user-said" });
    store.confirm(kept.id);
    advance(29 * 86_400_000);
    assert.equal(store.list("t1").length, 2);
    advance(2 * 86_400_000);
    assert.deepEqual(store.list("t1").map((note) => note.text), ["Kept"]);
    assert.equal(store.get(waiting.id), undefined);
    assert.ok(events.some((event) => event.type === "nova.memory-note-expired" && event.details.noteId === waiting.id));
  });

  it("refuses the note past 200 for one organization", () => {
    const { store } = memory();
    for (let index = 0; index < NOVA_NOTES_PER_ORGANIZATION; index += 1) store.propose({ tenantId: "t1", text: `Note ${index}`, source: "user-said" });
    assert.throws(() => store.propose({ tenantId: "t1", text: "One more", source: "user-said" }), { message: NOVA_NOTES_FULL });
    assert.doesNotThrow(() => store.propose({ tenantId: "t2", text: "Another organization", source: "user-said" }));
  });

  it("refuses empty and over-long notes", () => {
    const { store } = memory();
    assert.throws(() => store.propose({ tenantId: "t1", text: "   ", source: "user-said" }), /needs some text/);
    assert.throws(() => store.propose({ tenantId: "t1", text: "x".repeat(301), source: "user-said" }), /at most 300 characters/);
  });

  it("refuses a note for a tenant that is being disconnected", () => {
    const store = new NovaMemory(openNovaDatabase(":memory:"), {
      audit: () => undefined,
      assertWritable: () => { throw new Error("closed"); },
    });
    assert.throws(() => store.propose({ tenantId: "t1", text: "Fact", source: "user-said" }), /closed/);
  });

  it("forgets a note and audits it, and purges a tenant with the audit first", () => {
    const { store, events } = memory();
    const one = store.propose({ tenantId: "t1", text: "One", source: "user-said" });
    store.propose({ tenantId: "t1", text: "Two", source: "user-said" });
    store.propose({ tenantId: "t2", text: "Stays", source: "user-said" });
    store.forget(one.id);
    assert.ok(events.some((event) => event.type === "nova.memory-note-forgotten" && event.details.text === "One"));
    let rowsWhenAudited = -1;
    const auditing = new NovaMemory(openNovaDatabase(":memory:"), {
      audit: (batch) => {
        if (batch.some((event) => event.type === "nova.memory-note-purged")) rowsWhenAudited = auditing.list("t1").length;
      },
    });
    auditing.propose({ tenantId: "t1", text: "A", source: "user-said" });
    assert.equal(auditing.purgeTenant("t1"), 1);
    assert.equal(rowsWhenAudited, 1);
    assert.equal(auditing.list("t1").length, 0);
    assert.equal(store.purgeTenant("t1"), 1);
    assert.equal(store.list("t2").length, 1);
  });
});

describe("Nova notes past their window and on Disconnect", () => {
  it("refuses to confirm or edit a proposed note past its 30 days, also from a stale view", () => {
    const { store, advance } = memory();
    const first = store.propose({ tenantId: "t1", text: "Kiosks are in Berlin", source: "user-said" });
    const second = store.propose({ tenantId: "t1", text: "Laptops are in Munich", source: "user-said" });
    advance(45 * 86_400_000);
    assert.throws(() => store.confirm(first.id), /no longer|gone|not found/i);
    assert.throws(() => store.edit(second.id, "Laptops are in Hamburg"), /no longer|gone|not found/i);
    assert.deepEqual(store.promptNotes("t1"), []);
  });

  it("keeps a disconnected tenant's notes when the purge events cannot be kept on disk", () => {
    const store = new NovaMemory(openNovaDatabase(":memory:"), {
      audit: () => undefined,
      auditDurably: () => { throw new Error("audit log and pending file unavailable"); },
    });
    store.confirm(store.propose({ tenantId: "t1", text: "Kiosks are in Berlin", source: "user-said" }).id);
    assert.throws(() => store.purgeTenant("t1"), /pending file unavailable/);
    assert.equal(store.list("t1").length, 1, "nothing is deleted without its audit events");
  });
});

