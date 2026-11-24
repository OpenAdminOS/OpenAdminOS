import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { REMINDER_LINK_SECONDS, signReminderUnsubscribe, signSession, verifyReminderUnsubscribe, verifySession } from "./auth.ts";
import { parseBatchResult, reminderSendingEnabled, renderReminder, runReminders } from "./reminders.ts";
import type { Recipient, SendOutcome } from "./reminders.ts";
import { campaignDoorForDate, reminderDoorAt } from "./time.ts";

test("delivery requires both explicit flags and a nonempty Resend key", () => {
  assert.equal(reminderSendingEnabled("true", "true", "test-key"), true);
  assert.equal(reminderSendingEnabled(undefined, "true", "test-key"), false);
  assert.equal(reminderSendingEnabled("false", "true", "test-key"), false);
  assert.equal(reminderSendingEnabled("true", undefined, "test-key"), false);
  assert.equal(reminderSendingEnabled("true", "TRUE", "test-key"), false);
  assert.equal(reminderSendingEnabled("true", "true", undefined), false);
  assert.equal(reminderSendingEnabled("true", "true", " "), false);
});

test("reminders use the current day in Berlin and do not send before 06:00 or after December 24", () => {
  const day = (value: string) => reminderDoorAt(Date.parse(value));
  assert.equal(day("2026-11-30T22:59:59Z"), null);
  assert.equal(day("2026-11-30T23:00:00Z"), null);
  assert.equal(campaignDoorForDate(Date.parse("2026-11-30T23:00:00Z")), 1);
  assert.equal(day("2026-12-01T04:59:59Z"), null);
  assert.equal(day("2026-12-01T05:00:00Z"), 1);
  assert.equal(day("2026-12-01T23:00:00Z"), null);
  assert.equal(day("2026-12-02T05:00:00Z"), 2);
  assert.equal(day("2026-12-24T22:59:59Z"), 24);
  assert.equal(day("2026-12-24T23:00:00Z"), null);
});

test("dry runs only count eligibility and days outside the send window do nothing", async () => {
  const io = {
    count: async (day: number) => {
      assert.equal(day, 7);
      return 13;
    },
    claim: async () => assert.fail("dry runs must not claim recipients"),
    send: async () => assert.fail("dry runs must not send"),
    record: async () => assert.fail("dry runs must not write outcomes"),
  };
  assert.deepEqual(await runReminders(7, false, io), {
    day: 7, dryRun: true, wouldSend: 13, sent: 0, failed: 0, unconfirmed: 0,
  });
  assert.deepEqual(await runReminders(null, true, io), {
    day: null, dryRun: false, wouldSend: 0, sent: 0, failed: 0, unconfirmed: 0,
  });
});

test("the reminder eligibility query skips opt-outs, same-door completions and prior claims", () => {
  // Run the production SELECT against a disposable fixture. Its filters use
  // standard SQL. Supabase-specific grants and mutations stay in the migration.
  const migration = readFileSync(new URL("../../../supabase/advent/0001_init.sql", import.meta.url), "utf8");
  const query = /create function public\.advent_reminder_eligible\(p_day int\)[\s\S]*?as \$\$([\s\S]*?)\$\$;/.exec(migration)?.[1];
  assert.ok(query);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      create table advent_participants (id text primary key, reminders_opt_in bool);
      create table advent_completions (participant_id text, day int);
      create table advent_reminder_sends (participant_id text, day int);
      insert into advent_participants values
        ('eligible',true), ('completed',true), ('earlier-completion',true),
        ('already-claimed',true), ('claimed-yesterday',true), ('opted-out',false);
      insert into advent_completions values ('completed',7), ('earlier-completion',6);
      insert into advent_reminder_sends values ('already-claimed',7), ('claimed-yesterday',6);
    `);
    const recipients = db.prepare(query.replaceAll("public.", "").replaceAll("p_day", ":day"));
    assert.deepEqual(recipients.all({ day: 7 }).map(({ id }) => id).sort(), [
      "claimed-yesterday", "earlier-completion", "eligible",
    ]);
  } finally {
    db.close();
  }
});

test("send runs reserve at most 100 recipients per batch and reruns only send unclaimed day records", async () => {
  const people = Array.from({ length: 205 }, (_, index) => ({
    id: `participant-${index}`, email: `participant-${index}@example.test`, unsubscribeId: `opaque-${index}`,
  }));
  const claims = new Map<number, Set<string>>();
  const batchSizes: number[] = [];
  const recorded: SendOutcome[] = [];
  const io = {
    count: async () => assert.fail("send runs use atomic claims"),
    claim: async (day: number, limit: number) => {
      const reserved = claims.get(day) ?? new Set<string>();
      const batch = people.filter(({ id }) => !reserved.has(id)).slice(0, limit);
      for (const { id } of batch) reserved.add(id);
      claims.set(day, reserved);
      return batch;
    },
    send: async (recipients: Recipient[]) => {
      batchSizes.push(recipients.length);
      return recipients.map(({ id }): SendOutcome => id === "participant-2"
        ? { id, status: "failed", code: "recipient_rejected" }
        : { id, status: "sent", messageId: `message-${id}` });
    },
    record: async (_day: number, outcomes: SendOutcome[]) => {
      recorded.push(...outcomes);
    },
  };

  const results = await Promise.all([runReminders(7, true, io), runReminders(7, true, io)]);
  assert.deepEqual(batchSizes, [100, 100, 5]);
  assert.equal(results.reduce((total, run) => total + run.sent, 0), 204);
  assert.equal(results.reduce((total, run) => total + run.failed, 0), 1);
  assert.equal(new Set(recorded.map(({ id }) => id)).size, 205);
  assert.equal((await runReminders(7, true, io)).wouldSend, 0);
  assert.equal((await runReminders(8, true, io)).wouldSend, 205);
});

test("Resend permissive batches retain the failed indexes and accept only an unambiguous response", () => {
  assert.deepEqual(parseBatchResult(["a", "b", "c"], {
    data: [{ id: "message-a" }, { id: "message-c" }],
    errors: [{ index: 1, message: "provider text is not persisted" }],
  }), [
    { id: "a", status: "sent", messageId: "message-a" },
    { id: "b", status: "failed", code: "recipient_rejected" },
    { id: "c", status: "sent", messageId: "message-c" },
  ]);
  assert.deepEqual(parseBatchResult(["a", "b"], { data: [{ id: "message-a" }] }), [
    { id: "a", status: "unconfirmed", code: "unexpected_batch_response" },
    { id: "b", status: "unconfirmed", code: "unexpected_batch_response" },
  ]);
});

test("reminder messages include the door, goal, tenant requirement and unsubscribe link without tracking assets", () => {
  const site = "https://example.test";
  const unsubscribe = `${site}/api/advent/unsubscribe?token=example`;
  const message = renderReminder({ day: 7, title: "Try a model", goal: "Read <version> in Settings.", needsTenant: false }, site, unsubscribe);
  assert.equal(message.subject, "Door 7 is open: Try a model");
  assert.match(message.text, /Read <version> in Settings/);
  assert.match(message.html, /Read &lt;version&gt; in Settings/);
  for (const body of [message.text, message.html]) {
    assert.ok(body.includes(`${site}/advent/day/7`));
    assert.ok(body.includes(unsubscribe));
    assert.ok(body.includes("No Microsoft 365 tenant needed."));
    assert.doesNotMatch(body, /<img|utm_|pixel/i);
  }
});

test("unsubscribe tokens are purpose-bound, tamper resistant, and expire after 90 days", () => {
  const id = "01234567-abcd-4321-abcd-0123456789ab";
  const now = Date.parse("2026-12-07T05:00:00Z");
  const secret = "test-secret-for-reminder-unsubscribe-links";
  const token = signReminderUnsubscribe(id, now, secret);
  assert.equal(verifyReminderUnsubscribe(token, now, secret), id);
  assert.equal(verifyReminderUnsubscribe(token, now + REMINDER_LINK_SECONDS * 1000 - 1, secret), id);
  assert.equal(verifyReminderUnsubscribe(token, now + REMINDER_LINK_SECONDS * 1000, secret), null);
  assert.equal(verifyReminderUnsubscribe(token.replace(/^0/, "9"), now, secret), null);
  assert.equal(verifyReminderUnsubscribe(token, now, "wrong test secret"), null);
  assert.equal(verifyReminderUnsubscribe(signSession(id, 0, now, secret), now, secret), null);
  assert.equal(verifySession(token, now, secret), null);
});
