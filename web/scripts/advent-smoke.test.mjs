import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SESSION_COOKIE, signReminderUnsubscribe, signSession } from "../src/lib/advent/auth.ts";

const secret = "fixture-session-secret-for-test-use";
const cron = "fixture-cron-secret-for-test-use";
const id = (suffix) => `01234567-abcd-4321-abcd-0123456789${suffix}`;
const cookie = (account, version) => `${SESSION_COOKIE}=${signSession(account, version, Date.now(), secret)}`;
const admin = { Cookie: cookie(id("01"), 2) };
const guest = { Cookie: cookie(id("02"), 6) };
const cronHeaders = { Authorization: `Bearer ${cron}` };

async function withServer(enabled, send, check) {
  const fixtureDir = await mkdtemp(join(tmpdir(), "advent-smoke-"));
  const eventPath = join(fixtureDir, "events.jsonl");
  await writeFile(eventPath, "");
  const socket = createServer().listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  const root = `http://127.0.0.1:${port}`;
  const preload = fileURLToPath(new URL("./advent-smoke-fixture.mjs", import.meta.url));
  const proc = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env, NODE_ENV: "development", NODE_OPTIONS: `--import=${JSON.stringify(preload)}`,
      NEXT_TELEMETRY_DISABLED: "1", VERCEL: "0",
      ADVENT_SMOKE_EVENTS: eventPath, ADVENT_ENABLED: enabled, ADVENT_REMINDERS_SEND: send,
      ADVENT_RULES_APPROVED: "true", ADVENT_NOW: "2026-12-07T06:05:00+01:00",
      ADVENT_SUPABASE_URL: "https://advent-storage.test", ADVENT_SUPABASE_SERVICE_KEY: "fixture",
      ADVENT_SESSION_SECRET: secret, ADVENT_ANSWER_PEPPER: "fixture-answer-pepper-for-test-use",
      ADVENT_ADMIN_EMAILS: "operator@example.test", ADVENT_EMAIL_FROM: "sender@example.test",
      ADVENT_RESEND_API_KEY: "fixture", UPSTASH_REDIS_REST_URL: "https://advent-redis.test",
      UPSTASH_REDIS_REST_TOKEN: "fixture", CRON_SECRET: cron,
    },
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const stopped = once(proc, "exit");
  let log = "";
  proc.stdout.on("data", (data) => { log += data; });
  proc.stderr.on("data", (data) => { log += data; });

  async function get(path, status, options) {
    const response = await fetch(root + path, { signal: AbortSignal.timeout(20_000), ...options });
    if (response.status !== status) assert.equal(response.status, status, `${path.split("?")[0]}: ${(await response.text()).slice(0, 250)}`);
    return response;
  }
  const post = (path, status, body, headers = {}) => get(path, status, {
    method: "POST",
    headers: { Origin: root, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const events = async () => (await readFile(eventPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  async function waitForEvent(predicate) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = (await events()).find(predicate);
      if (found) return found;
      await setTimeout(30);
    }
    assert.fail("The expected campaign fixture event did not arrive.");
  }

  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(root + "/api/advent/reminders", { signal: AbortSignal.timeout(5000) }).catch(() => null)) break;
      if (attempt === 99 || proc.exitCode !== null) assert.fail("The Next.js fixture server did not start.");
      await setTimeout(100);
    }
    await check({ get, post, events, waitForEvent, releaseLookups: () => writeFile(eventPath + ".release", "") });
  } catch (error) {
    console.error(log);
    throw error;
  } finally {
    if (proc.exitCode === null) {
      if (process.platform === "win32") proc.kill("SIGTERM");
      else process.kill(-proc.pid, "SIGTERM");
    }
    await stopped;
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

test("flag off hides every Advent route, including authorised cron requests", async () => {
  await withServer("false", "true", async ({ get, post, events }) => {
    for (const path of [
      "/advent", "/advent/admin", "/advent/day/1", "/advent/me", "/advent/rules",
      "/advent/sign-in", "/advent/sign-up", "/advent/verify", "/advent/u/sample",
      "/advent/u/sample/og", "/api/advent/export", "/api/advent/unsubscribe", "/api/advent/reminders",
    ]) await get(path, 404, { headers: cronHeaders });
    for (const action of [
      "sign-up", "sign-in", "verify-preview", "verify", "complete", "settings", "sign-out", "delete", "set-answers",
      "draw", "replace-winner", "fulfil-prizes", "delete-winners", "purge", "reminders", "unsubscribe",
    ]) await post(`/api/advent/${action}`, 404, {}, cronHeaders);
    assert.deepEqual(await events(), []);
    assert.doesNotMatch(await (await get("/", 200)).text(), /href="\/advent"/);
    assert.doesNotMatch(await (await get("/privacy", 200)).text(), /id="advent"/);
    assert.doesNotMatch(await (await get("/sitemap.xml", 200)).text(), /\/advent/);
  });
});

test("enabled routes require Origin and admin auth, and preserve settings and exports", async () => {
  await withServer("true", "", async ({ get, post, events, waitForEvent }) => {
    await post("/api/advent/sign-up", 403, {}, { Origin: "https://foreign.example.test" });
    await get("/advent/admin", 404, { headers: guest });
    await get("/api/advent/export?draw=1&list=winners", 404, { headers: guest });
    await post("/api/advent/draw", 404, { draw: "1" }, guest);
    const dashboard = await (await get("/advent/admin", 200, { headers: admin })).text();
    assert.match(dashboard, /Launch readiness/);
    assert.match(dashboard, /Account deleted after the draw\. Run a replacement draw\./);
    const csv = await (await get("/api/advent/export?draw=1&list=winners", 200, { headers: admin })).text();
    assert.match(csv, /"'\+fixture@example\.test","fixture",1,1,"Winner"/);
    const missing = await (await get("/api/advent/export?draw=2&list=winners", 200, { headers: admin })).text();
    assert.match(missing, /Account deleted after the draw\. Run a replacement draw\./);

    await post("/api/advent/replace-winner", 200, { original: id("21"), slot: "1" }, admin);
    assert.match(await (await get("/advent/admin", 200, { headers: admin })).text(), /Replacement draw audit/);
    assert.match(await (await get("/api/advent/export?draw=2&list=winners", 200, { headers: admin })).text(), /1,"Winner"/);

    const wrong = await post("/api/advent/complete", 422, { day: "7", answer: "Wrong check" }, guest);
    assert.match((await wrong.json()).error, /9 attempts left/);
    await post("/api/advent/complete", 200, { day: "7", answer: "Correct check" }, guest);
    const rateEvents = await events();
    assert.equal(rateEvents.filter(({ answerBudget }) => answerBudget === 100).length, 2);
    assert.equal(rateEvents.filter(({ releasedAnswerSlot }) => releasedAnswerSlot).length, 1);

    await post("/api/advent/settings", 200, {
      handle: "updated-handle", marketing: "on", marketing_initial: "off", reminders_initial: "on",
    }, guest);
    const updated = await waitForEvent(({ settings }) => settings);
    assert.equal(updated.settings.p_marketing, true);
    assert.equal(updated.settings.p_reminders, false);
    const me = await (await get("/advent/me", 200, { headers: guest })).text();
    assert.match(me, /updated-handle/);
    assert.match(me, /name="marketing_initial" value="on"/);
    assert.match(me, /name="reminders_initial" value="off"/);
    await post("/api/advent/sign-out", 200, {}, guest);
    await post("/api/advent/settings", 401, { handle: "other" }, guest);

    for (const method of ["GET", "POST"]) {
      const dryRun = await get("/api/advent/reminders", 200, { method, headers: cronHeaders });
      assert.deepEqual(await dryRun.json(), { day: 7, dryRun: true, wouldSend: 2, sent: 0, failed: 0, unconfirmed: 0 });
    }
    assert.equal((await events()).filter(({ cleanup }) => cleanup).length, 2);
    assert.ok(!(await events()).some(({ reminderBatch }) => reminderBatch));
  });
});

test("magic links defer lookup, mask sign-ins, and confirm editable signup values before writing", async () => {
  await withServer("true", "", async ({ get, post, events, waitForEvent, releaseLookups }) => {
    const known = await post("/api/advent/sign-in", 200, { email: "operator@example.test" });
    assert.ok(!(await events()).some(({ completedLookup }) => completedLookup));
    const unknown = await post("/api/advent/sign-in", 200, { email: "unknown@example.test" });
    assert.deepEqual(await known.json(), await unknown.json());
    await releaseLookups();
    const signIn = await waitForEvent(({ mail }) => mail === "operator@example.test");
    const signInPreview = await post("/api/advent/verify-preview", 200, { token: signIn.token });
    assert.deepEqual(await signInPreview.json(), {
      preview: { kind: "signin", handle: "operator", maskedEmail: "o•••@example.test" },
    });
    assert.equal(signInPreview.headers.get("set-cookie"), null);

    const first = { email: "signup@example.test", handle: "draft-handle", ref: "AB234567", marketing: "on", age: "on", rules: "on" };
    await post("/api/advent/sign-up", 200, first);
    const previous = await waitForEvent(({ mail }) => mail === first.email);
    await post("/api/advent/sign-up", 200, { ...first, handle: "another-draft" });
    const current = await waitForEvent(({ mail, token }) => mail === first.email && token !== previous.token);
    await post("/api/advent/verify-preview", 400, { token: previous.token });
    const verifyPage = await (await get("/advent/verify", 200)).text();
    assert.match(verifyPage, /Review your link/);
    assert.match(verifyPage, /Advent of Admin needs JavaScript to submit answers\./);
    const preview = await post("/api/advent/verify-preview", 200, { token: current.token });
    assert.deepEqual(await preview.json(), {
      preview: { kind: "signup", email: first.email, handle: "another-draft", referral: "AB234567", marketing: true, reminders: false },
    });
    assert.equal(preview.headers.get("set-cookie"), null);
    await post("/api/advent/verify", 400, { token: current.token, intent: "signin" });
    assert.ok(!(await events()).some(({ confirmation }) => confirmation));

    const verified = await post("/api/advent/verify", 200, {
      token: current.token, intent: "signup", handle: "confirmed-handle",
      discard_referral: "on", reminders: "on", age: "on", rules: "on",
    });
    const attributes = (verified.headers.get("set-cookie") ?? "").split(";").slice(1).map((value) => value.trim().toLowerCase());
    for (const attribute of ["httponly", "secure", "samesite=lax"]) assert.ok(attributes.includes(attribute), attribute);
    const { confirmation } = await waitForEvent(({ confirmation }) => confirmation);
    assert.deepEqual(confirmation, {
      handle: "confirmed-handle", discard_referral: true, marketing: false, reminders: true,
      rules_version: "2026-11-23", marketing_version: "2026-11-23", reminders_version: "2026-11-23",
    });
    await post("/api/advent/verify-preview", 400, { token: current.token });
  });
});

test("cron sends only to the mock provider and one-click unsubscribe uses an opaque ID", async () => {
  await withServer("true", "true", async ({ get, events }) => {
    const first = await get("/api/advent/reminders", 200, { headers: cronHeaders });
    assert.deepEqual(await first.json(), { day: 7, dryRun: false, wouldSend: 2, sent: 1, failed: 1, unconfirmed: 0 });
    const repeat = await get("/api/advent/reminders", 200, { method: "POST", headers: cronHeaders });
    assert.equal((await repeat.json()).wouldSend, 0);
    assert.equal((await events()).filter(({ reminderBatch }) => reminderBatch).length, 1);

    const token = signReminderUnsubscribe(id("10"), Date.now(), secret);
    const unsubscribe = `/api/advent/unsubscribe?token=${token}`;
    assert.match(await (await get(unsubscribe, 200)).text(), /<form method="post"/);
    assert.match(await (await get("/advent/me", 200, { headers: admin })).text(), /name="reminders_initial" value="on"/);
    await get(`${unsubscribe}tamper`, 400, { method: "POST" });
    await get(unsubscribe, 200, { method: "POST", body: "List-Unsubscribe=One-Click" });
    assert.match(await (await get("/advent/me", 200, { headers: admin })).text(), /name="reminders_initial" value="off"/);
  });
});
