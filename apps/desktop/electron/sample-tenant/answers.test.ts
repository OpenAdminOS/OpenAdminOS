import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CHAT_SUGGESTED_PROMPTS } from "../../src/shared/chat-prompts.js";
import { buildSampleTenantSuggestedPromptAnswer } from "./answers.js";
import { createSampleGraph } from "./graph.js";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const FOOTER = "In production, answers come from your tenant and the model you choose.";

const scenarios = [
  ["Which managed devices have not synced in the last 7 days?", "17 managed devices"],
  ["Which devices are stale in Intune but still active in Entra?", "17 devices"],
  ["Which devices are both stale and noncompliant?", "2 managed devices"],
  ["Which Windows devices are not encrypted?", "5 managed Windows devices"],
  ["Which user accounts are disabled?", "4 user accounts"],
  ["Which guest users have not signed in recently?", "7 guest users"],
  ["Which users are linked to noncompliant managed devices?", "9 users"],
  ["Which users appear in recent directory audit events?", "12 users"],
  ["Which required apps are assigned but not installed on targeted devices?", "6 targeted device installs"],
  ["Which app deployments appear tied to the primary user?", "6 app deployment records"],
  ["Which superseded apps are still detected on devices?", "1 superseded app is still detected on 7 devices"],
  ["Which app assignments target empty or stale groups?", "2 app assignments"],
  ["Which compliance policies were modified most recently?", "2 compliance policies"],
  ["Which Conditional Access policies are disabled or report-only?", "2 Conditional Access policies"],
  ["Which configuration policies have the highest setting counts?", "5 configuration policies"],
  ["Which policies changed recently?", "6 policies"],
  ["Which recent sign-ins failed because of Conditional Access?", "12 recent sign-ins"],
  ["Which users have repeated failed sign-ins?", "3 users"],
  ["Which risky sign-ins need review?", "4 risky sign-ins"],
  ["Which applications have the most sign-in failures?", "3 applications"],
  ["Which Entra devices are not managed in Intune?", "8 Entra devices"],
  ["Which app registration secrets or certificates expire soon?", "1 app registration credential"],
  ["Which users hold privileged directory roles?", "6 users hold 6 assignments"],
  ["Which Conditional Access policies exclude guest or external identities?", "1 Conditional Access policy"],
  ["Which high-severity Defender incidents are open?", "2 high-severity Defender incidents"],
  ["Which Defender alerts were raised this week?", "5 Defender alerts"],
  ["How has Secure Score changed over the last 90 days?", "increased by 14.0 points"],
  ["Which Secure Score improvement actions rank highest?", "12 Secure Score improvement actions"],
] as const;

describe("sample tenant suggested answers", () => {
  assert.deepEqual(
    scenarios.map(([prompt]) => prompt),
    CHAT_SUGGESTED_PROMPTS,
    "Every renderer suggestion must have one answer test in the same order.",
  );

  for (const [prompt, expectedCount] of scenarios) {
    it(`computes planted evidence for: ${prompt}`, async () => {
      const answer = await buildSampleTenantSuggestedPromptAnswer(
        createSampleGraph({ now: NOW }),
        prompt,
        NOW,
      );
      assert.ok(answer);
      assert.match(answer, new RegExp(escapeRegExp(expectedCount)));
      assert.match(answer, /\| .+ \|/);
      assert.ok(answer.endsWith(FOOTER));
    });
  }

  it("normalizes case, whitespace, and trailing punctuation", async () => {
    const answer = await buildSampleTenantSuggestedPromptAnswer(
      createSampleGraph({ now: NOW }),
      "  WHICH   USER ACCOUNTS ARE DISABLED???  ",
      NOW,
    );
    assert.match(answer ?? "", /4 user accounts/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
