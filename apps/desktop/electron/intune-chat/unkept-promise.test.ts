import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_PROMISE_NUDGES, PROMISE_REPAIR_PROMPT, completeWithPromiseNudge, eachAttemptWithin, looksLikeUnkeptPromise } from "./unkept-promise.js";

describe("unkept promise", () => {
  it("finds answers that only announce work", () => {
    for (const answer of [
      "I'll check that now.",
      "Let me look into the device inventory.",
      "I am checking the compliance policies.",
      "I will now query the sign-in logs.",
      "One moment, I'm pulling the data.",
      "Give me a moment. I'm going to verify the assignments.",
      "Sure. Let me go and check the Autopilot profiles for you.",
      "I’ll look into it.",
      "Okay, let me check the compliance policies.",
      "Got it. I'm checking the sign-in logs now.",
    ]) {
      assert.equal(looksLikeUnkeptPromise(answer), true, answer);
    }
  });

  it("leaves finished answers alone, also when they mention a later step", () => {
    for (const answer of [
      "Checked 47 devices; 3 are non-compliant. I'll check again tomorrow if you ask.",
      "WIN-01 and WIN-02 have not synced in 30 days.",
      "No device is non-compliant. If you want, I can check the stale devices next.",
      "I can check the Autopilot profiles if you tell me which group.",
      "Let me know if you want the list sent to Outlook.",
      "There is a second admin account without MFA: admin2@contoso.example.",
      "Let's look at the results: 3 devices are encrypted and 1 is not.",
      "- WIN-01: noncompliant\n- WIN-02: compliant\nI'll check the rest next.",
      "Write this query: \"let me check the logs\" is how the help text starts.",
      "```kql\n// I'll check this later\nSigninLogs\n```",
      "All devices are compliant. I'll check the app installs next.",
      "All devices are compliant, and I'll check the app installs next.",
      "Yes. Let's verify it in Devices.",
      "Open Devices, then let's check the compliance column.",
      "BitLocker is off on the pilot laptops. Let me check the policy assignment next.",
      "",
      "The tenant has no Windows Update rings assigned to the pilot group, so the devices in it receive updates on the default schedule. That matches what the compliance report shows. Let me know which ring you plan to use.",
    ]) {
      assert.equal(looksLikeUnkeptPromise(answer), false, answer);
    }
  });

  it("asks a single-call model again at most twice and keeps its last answer", async () => {
    const prompts: string[] = [];
    const replies = ["I'll check that now.", "Let me look.", "Still checking, one moment.", "unused"];
    const answer = await completeWithPromiseNudge(async (prompt) => {
      prompts.push(prompt);
      return replies[prompts.length - 1]!;
    }, "Admin question: which devices?");
    assert.equal(prompts.length, 1 + MAX_PROMISE_NUDGES);
    assert.equal(answer, "Still checking, one moment.");
    assert.ok(prompts[1]!.startsWith("Admin question: which devices?"));
    assert.ok(prompts[1]!.includes("Your previous reply:\nI'll check that now."));
    assert.ok(prompts[1]!.endsWith(PROMISE_REPAIR_PROMPT));
  });

  it("returns a finished first answer without asking again", async () => {
    let calls = 0;
    const answer = await completeWithPromiseNudge(async () => {
      calls += 1;
      return "Three devices are noncompliant: WIN-01, WIN-02 and WIN-03.";
    }, "Admin question");
    assert.equal(calls, 1);
    assert.match(answer, /Three devices/);
  });
});

describe("attempt bounds", () => {
  const pause = (ms: number) => new Promise<void>((resolve) => { const timer = setTimeout(resolve, ms); void timer; });

  it("gives every repair turn its own time, so nudges do not turn an answer into a timeout", async () => {
    const replies = ["I'll check that now.", "Let me look.", "Three devices are noncompliant."];
    let calls = 0;
    // Each attempt takes 60% of the bound; the three together take 180%.
    const answer = await completeWithPromiseNudge(eachAttemptWithin(async () => { await pause(300); return replies[calls++]!; }, 500, "timed out"), "Admin question");
    assert.equal(answer, "Three devices are noncompliant.");
    assert.equal(calls, 3);
  });

  it("ends an attempt that does not answer in time with the designed message and aborts its call", async () => {
    let aborted = false;
    const bounded = eachAttemptWithin((_prompt, signal) => new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("late"), 2000);
      signal.addEventListener("abort", () => { aborted = true; clearTimeout(timer); resolve("aborted"); });
    }), 50, "The assigned provider did not answer within one minute.");
    await assert.rejects(bounded("Admin question"), /did not answer within one minute/);
    assert.equal(aborted, true);
  });
});
