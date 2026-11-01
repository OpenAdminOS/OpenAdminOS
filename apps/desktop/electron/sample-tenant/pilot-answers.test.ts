import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_SUGGESTED_PROMPTS } from "../../src/shared/chat-prompts.js";
import {
  PILOT_COPY,
  PILOT_PROMPTS,
  PILOT_STARTERS,
  pilotPromptEntry,
} from "../../src/shared/pilot-mode.js";
import { computeSampleTenantAnswer } from "./answers.js";
import { createSampleGraph } from "./graph.js";
import { buildPilotPreparedAnswer } from "./pilot-answers.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
// Thresholds and error codes that are part of the question, not the data.
const STATIC_NUMBERS = new Set([7, 30, 90, 53003]);

describe("pilot prepared answers", () => {
  it("has six starters with two follow-ups each, all existing suggested prompts", () => {
    assert.equal(PILOT_STARTERS.length, 6);
    assert.deepEqual(
      PILOT_STARTERS.map((starter) => starter.area),
      ["Devices", "Compliance", "Conditional Access", "Users", "Apps", "Security"],
    );
    for (const starter of PILOT_STARTERS) assert.equal(starter.followUps.length, 2);
    assert.equal(new Set(PILOT_PROMPTS).size, 18);
    for (const prompt of PILOT_PROMPTS) {
      assert.ok((CHAT_SUGGESTED_PROMPTS as readonly string[]).includes(prompt), prompt);
    }
  });

  it("links the stale device, Conditional Access, and guest answers to their pilot agents", () => {
    assert.equal(
      pilotPromptEntry("Which managed devices have not synced in the last 7 days?")?.agentSlug,
      "find-inactive-devices",
    );
    assert.equal(
      pilotPromptEntry("Which Conditional Access policies are disabled or report-only?")?.agentSlug,
      "conditional-access-explainer",
    );
    assert.equal(
      pilotPromptEntry("Which guest users have not signed in recently?")?.agentSlug,
      "stale-guest-cleanup",
    );
    assert.equal(pilotPromptEntry("Which user accounts are disabled?")?.agentSlug, undefined);
    assert.equal(pilotPromptEntry("Draft a limerick about coffee."), undefined);
  });

  for (const prompt of PILOT_PROMPTS) {
    it(`writes the narrative from computed facts for: ${prompt}`, async () => {
      const graph = createSampleGraph({ now: NOW });
      const prepared = await buildPilotPreparedAnswer(graph, prompt, NOW);
      const computed = await computeSampleTenantAnswer(createSampleGraph({ now: NOW }), prompt, NOW);
      assert.ok(prepared);
      assert.ok(computed);
      assert.deepEqual(prepared.computed.facts, computed.facts);

      const sentences = prepared.narrative.split(/(?<=\.)\s+/).filter(Boolean);
      assert.ok(sentences.length >= 2 && sentences.length <= 4, `${sentences.length} sentences`);
      assert.ok(prepared.markdown.startsWith(prepared.narrative));
      assert.ok(!prepared.markdown.slice(prepared.narrative.length).includes(computed.sentence));
      assert.match(prepared.markdown, /\| .+ \|/);
      assert.ok(prepared.markdown.endsWith(PILOT_COPY.answerFooter));
      assert.doesNotMatch(prepared.markdown, /\u2014/);

      // Every number in the narrative must come from the computed facts.
      let text = prepared.narrative;
      const factStrings = Object.values(computed.facts)
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter((value): value is string => typeof value === "string")
        .sort((left, right) => right.length - left.length);
      for (const value of factStrings) text = text.split(value).join(" ");
      const numericFacts = new Set(
        Object.values(computed.facts).filter((value): value is number => typeof value === "number"),
      );
      for (const match of text.matchAll(/\d+/g)) {
        const value = Number(match[0]);
        assert.ok(
          numericFacts.has(value) || STATIC_NUMBERS.has(value),
          `Narrative number ${value} is not a computed fact: ${prepared.narrative}`,
        );
      }
    });
  }

  it("states the planted counts", async () => {
    const expectations: Array<[string, RegExp]> = [
      ["Which managed devices have not synced in the last 7 days?", /^17 of 119 managed devices/],
      ["Which Windows devices are not encrypted?", /^5 of 71 managed Windows devices/],
      ["Which Conditional Access policies are disabled or report-only?", /^2 of 8 Conditional Access policies/],
      ["Which guest users have not signed in recently?", /^7 of 8 guest accounts/],
      ["Which app registration secrets or certificates expire soon?", /^1 app registration credential expires/],
      ["Which high-severity Defender incidents are open?", /^2 high-severity incidents are open/],
    ];
    for (const [prompt, pattern] of expectations) {
      const prepared = await buildPilotPreparedAnswer(createSampleGraph({ now: NOW }), prompt, NOW);
      assert.match(prepared?.narrative ?? "", pattern, prompt);
    }
  });

  it("keeps counts stable across days and keeps simulated writes", async () => {
    let now = new Date(NOW.getTime());
    const graph = createSampleGraph({ clock: () => new Date(now.getTime()) });
    const stalePrompt = "Which managed devices have not synced in the last 7 days?";
    const first = await computeSampleTenantAnswer(graph, stalePrompt, now);
    const before = (await graph.request({
      method: "GET",
      path: "/deviceManagement/managedDevices/managed-device-002",
    })) as Record<string, unknown>;
    await graph.request({
      method: "PATCH",
      path: "/users/user-075",
      body: { accountEnabled: false },
    });

    now = new Date(NOW.getTime() + 3 * DAY_MS);
    const later = await computeSampleTenantAnswer(graph, stalePrompt, now);
    const after = (await graph.request({
      method: "GET",
      path: "/deviceManagement/managedDevices/managed-device-002",
    })) as Record<string, unknown>;
    const user = (await graph.request({ method: "GET", path: "/users/user-075" })) as Record<string, unknown>;

    assert.equal(first?.facts.count, 17);
    assert.equal(later?.facts.count, 17);
    assert.equal(first?.facts.oldestDays, later?.facts.oldestDays);
    assert.equal(
      Date.parse(String(after.lastSyncDateTime)) - Date.parse(String(before.lastSyncDateTime)),
      3 * DAY_MS,
    );
    assert.equal(user.accountEnabled, false);
  });
});
