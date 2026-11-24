import { createHash, createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";

const nativeFetch = globalThis.fetch;
const eventFile = process.env.ADVENT_SMOKE_EVENTS;
const event = (value) => appendFileSync(eventFile, JSON.stringify(value) + "\n");
const id = (suffix) => `01234567-abcd-4321-abcd-0123456789${suffix}`;
const admin = { id: id("01"), email: "operator@example.test", handle: "operator", session_version: 2, reminders_opt_in: true };
const guest = { id: id("02"), email: "+fixture@example.test", handle: "fixture", session_version: 6, reminders_opt_in: true };
const opaqueId = id("10");
const accounts = new Map([admin, guest].map((account) => [account.id, {
  ...account, ref_code: "AB234567", badge_public: false, marketing_opt_in: false,
}]));
const tokens = new Map();
const pending = new Map();
let lastRequest = 0;
let reminderClaimed = false;
const records = [guest.id, id("03")].map((winner, index) => ({
  id: id(`2${index}`), kind: "daily", day: index + 1, created_at: "2026-12-05T07:00:00Z",
  eligible_count: 1, eligible_list: [{ id: winner, entries: 1 }],
  eligible_list_sha256: "a".repeat(64), random_bytes_hex: "b".repeat(64),
  winner_participant_ids: [winner], created_by_email: admin.email,
  original_draw_id: null, replaces_draw_id: null, prize_slot: null,
}));

function getToken(hash) {
  const token = tokens.get(hash);
  return token?.used ? undefined : token;
}

function rest(url, method, body) {
  const relation = url.pathname.slice("/rest/v1/".length);
  const filter = (key) => url.searchParams.get(key)?.slice(3);

  switch (relation) {
    case "advent_participants": {
      if (filter("email")) {
        return Response.json([...accounts.values()].filter((row) => row.email === filter("email")));
      }
      const filterId = url.searchParams.get("id");
      if (filterId?.startsWith("in.(")) {
        return Response.json(filterId.slice(4, -1).split(",").map((accountId) => accounts.get(accountId)).filter(Boolean));
      }
      const account = accounts.get(filter("id"));
      return Response.json(account && String(account.session_version) === filter("session_version") ? [account] : []);
    }
    case "advent_login_tokens":
      assert.equal(method, "POST");
      tokens.set(body.token_hash, { account: body.participant_id });
      return new Response(null, { status: 201 });
    case "rpc/advent_issue_signup_token": {
      const email = body.p_pending.email;
      assert.deepEqual(Object.keys(body.p_pending).sort(), ["email", "handle", "marketing", "ref", "reminders"]);
      const old = pending.get(email);
      if (old) tokens.delete(old);
      pending.set(email, body.p_hash);
      tokens.set(body.p_hash, { signup: body.p_pending });
      return Response.json(true);
    }
    case "rpc/advent_preview_token": {
      const token = getToken(body.p_hash);
      if (!token) return Response.json(null);
      if (token.signup) {
        const { email, handle, ref, marketing, reminders } = token.signup;
        return Response.json({ kind: "signup", email, handle, referral: ref || null, marketing, reminders });
      }
      const account = accounts.get(token.account);
      return Response.json({ kind: "signin", handle: account.handle, maskedEmail: "o•••@example.test" });
    }
    case "rpc/advent_consume_token": {
      const token = getToken(body.p_hash);
      if (!token) return Response.json({ status: "invalid" });
      if (token.signup) {
        if (!body.p_confirmation || body.p_signin) return Response.json({ status: "confirmation_required" });
        const account = {
          id: id("04"), email: token.signup.email, handle: body.p_confirmation.handle,
          ref_code: "JK234567", badge_public: false, session_version: 0,
          marketing_opt_in: body.p_confirmation.marketing, reminders_opt_in: body.p_confirmation.reminders,
        };
        accounts.set(account.id, account);
        token.account = account.id;
        event({ confirmation: body.p_confirmation, acceptedAt: body.p_now });
      } else if (!body.p_signin) {
        return Response.json({ status: "confirmation_required" });
      }
      token.used = true;
      return Response.json({ status: "ok", id: token.account, version: accounts.get(token.account).session_version });
    }
    case "rpc/advent_update_settings": {
      const account = accounts.get(body.p_id);
      account.handle = body.p_handle;
      if (body.p_marketing !== null) account.marketing_opt_in = body.p_marketing;
      if (body.p_reminders !== null) account.reminders_opt_in = body.p_reminders;
      event({ settings: body });
      return Response.json(true);
    }
    case "rpc/advent_sign_out": {
      const account = accounts.get(body.p_id);
      if (account.session_version === body.p_version) account.session_version++;
      return new Response(null, { status: 204 });
    }
    case "rpc/advent_complete_door": {
      assert.equal(body.p_day, 7);
      assert.equal(body.p_on_time, true);
      assert.equal(body.p_can_record_wrong, true);
      const hash = (answer) => createHmac("sha256", process.env.ADVENT_ANSWER_PEPPER).update(`7:${answer}`).digest("hex");
      if (body.p_hash === hash("correct check")) return Response.json({ status: "done" });
      assert.equal(body.p_hash, hash("wrong check"));
      return Response.json({ status: "wrong", remaining: 9 });
    }
    case "rpc/advent_replacement_offer":
      assert.equal(body.p_original_id, id("21"));
      assert.equal(body.p_slot, 1);
      return Response.json({
        status: "ok", predecessor: id("21"),
        eligible: [{ id: id("10"), entries: 1 }, { id: admin.id, entries: 3 }],
      });
    case "rpc/advent_record_draw": {
      const record = body.p_record;
      assert.equal(record.kind, "replacement");
      assert.equal(record.replaces_draw_id, id("21"));
      assert.deepEqual(record.eligible_list, [{ id: admin.id, entries: 3 }, { id: id("10"), entries: 1 }]);
      assert.equal(record.eligible_list_sha256, createHash("sha256").update(`${admin.id},3\n${id("10")},1\n`).digest("hex"));
      assert.equal(record.winner_participant_ids.length, 1);
      // Give both synthetic candidates accounts so the random result is always exportable.
      accounts.set(id("10"), { id: id("10"), email: "alternate@example.test", handle: "alternate" });
      records.push({ id: id("22"), day: null, ...record });
      return Response.json("ok");
    }
    case "rpc/advent_daily_cleanup":
      event({ cleanup: true });
      return Response.json({ expiredTokens: 2, staleAttempts: 3 });
    case "rpc/advent_reminder_count":
      event({ reminderCount: body.p_day });
      return Response.json(2);
    case "rpc/advent_reminder_claim":
      if (reminderClaimed) return Response.json([]);
      reminderClaimed = true;
      assert.equal(body.p_day, 7);
      assert.equal(body.p_limit, 100);
      return Response.json([admin, guest].map(({ id: accountId, email }) => ({ id: accountId, email, unsubscribeId: opaqueId })));
    case "rpc/advent_reminder_record":
      assert.deepEqual(body.p_outcomes, [
        { id: admin.id, status: "sent", message_id: "fixture-message-id" },
        { id: guest.id, status: "failed", code: "recipient_rejected" },
      ]);
      return new Response(null, { status: 204 });
    case "rpc/advent_unsubscribe_reminders":
      assert.equal(body.p_unsubscribe_id, opaqueId);
      accounts.get(admin.id).reminders_opt_in = false;
      return new Response(null, { status: 204 });
    case "rpc/advent_reminder_stats":
      return Response.json({ optedIn: 2, days: [] });
    case "rpc/advent_referral_count":
      return Response.json(0);
    case "rpc/advent_door_stats":
      return Response.json(Array.from({ length: 24 }, (_, index) => ({day:index+1, completed:0, on_time:0, answer_count:0})));
    case "advent_completions":
      return Response.json([]);
    case "advent_retention":
      return Response.json([{ prizes_fulfilled_at: null, winners_deleted_at: null }]);
    case "advent_draws":
      return Response.json(records.filter((record) =>
        (!filter("day") || String(record.day) === filter("day"))
        && (!filter("original_draw_id") || record.original_draw_id === filter("original_draw_id"))));
    default:
      throw new Error(`Unexpected campaign fixture relation ${relation}`);
  }
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (!["advent-storage.test", "advent-redis.test", "api.resend.com"].includes(url.hostname)) {
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), `Unexpected outbound fixture request to ${url.hostname}`);
    return nativeFetch(input, init);
  }
  const body = init?.body ? JSON.parse(init.body) : input instanceof Request && input.body ? await input.clone().json() : null;
  if (url.hostname === "advent-redis.test") {
    const execute = (command) => {
      if (command.some((value) => String(value).startsWith("oa:rate:advent:wrong-answer:"))) {
        if (command[0] === "eval") event({ answerBudget: Number(command.at(-2)) });
        if (command[0] === "zrem") event({ releasedAnswerSlot: true });
      }
      return { result: 1 };
    };
    return Response.json(url.pathname === "/pipeline" ? body.map(execute) : execute(body));
  }
  if (url.hostname === "advent-storage.test") {
    if (url.searchParams.get("email")) {
      // The test releases the mocked lookup only after both HTTP replies arrive.
      for (let attempt = 0; !existsSync(eventFile + ".release"); attempt++) {
        assert.ok(attempt < 100, "The HTTP response waited on the account lookup");
        await setTimeout(30);
      }
      event({ completedLookup: ++lastRequest });
    }
    return rest(url, init?.method, body);
  }
  if (url.pathname === "/emails/batch") {
    assert.equal(process.env.ADVENT_REMINDERS_SEND, "true");
    assert.equal(body.length, 2);
    assert.equal(new Headers(init?.headers).get("X-Batch-Validation"), "permissive");
    assert.match(new Headers(init?.headers).get("Idempotency-Key"), /^advent-2026:7:[0-9a-f]{64}$/);
    for (const message of body) {
      assert.match(message.text, /\/advent\/day\/7/);
      assert.doesNotMatch(message.html, /<img|utm_/);
      assert.equal(message.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
      const unsubscribe = message.headers["List-Unsubscribe"];
      assert.ok(unsubscribe.includes(opaqueId));
      assert.ok(!unsubscribe.includes(admin.id) && !unsubscribe.includes(guest.id));
    }
    event({ reminderBatch: true });
    return Response.json({ data: [{ id: "fixture-message-id" }], errors: [{ index: 1, message: "Fixture rejection" }] });
  }
  assert.equal(url.pathname, "/emails");
  const link = body.text.match(/https?:\/\/[^\s]+\/advent\/verify#[^\s]+/)?.[0];
  assert.ok(link);
  event({ mail: body.to[0], token: new URL(link).hash.slice(1) });
  return Response.json({ id: "fixture-link-email" });
};
