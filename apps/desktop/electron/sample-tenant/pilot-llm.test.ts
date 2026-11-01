import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { parseAgentTemplate } from "@openadminos/runtime";

import { PILOT_AGENT_SLUGS, PILOT_COPY } from "../../src/shared/pilot-mode.js";
import { createPilotLlm, PILOT_PREPARED_STEPS, parsePilotPrompt } from "./pilot-llm.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

interface ManifestStep {
  id: string;
  format: string;
  settings?: { prompt?: string; do?: ManifestStep[] };
}

function llmSteps(steps: ManifestStep[]): ManifestStep[] {
  return steps.flatMap((step) => [
    ...(step.format === "llm" ? [step] : []),
    ...llmSteps(step.settings?.do ?? []),
  ]);
}

describe("pilot LLM", () => {
  it("has a prepared step for every LLM step of the three pilot agents", async () => {
    for (const slug of PILOT_AGENT_SLUGS) {
      const source = await readFile(join(repoRoot, "agents", slug, "manifest.yaml"), "utf8");
      const manifest = parseAgentTemplate(source);
      const steps = llmSteps(manifest.skills as unknown as ManifestStep[]);
      assert.ok(steps.length > 0, slug);
      for (const step of steps) {
        const prepared = PILOT_PREPARED_STEPS.find(
          (entry) => entry.agentSlug === slug && entry.stepId === step.id,
        );
        assert.ok(prepared, `${slug} step ${step.id} has no prepared output`);
        assert.ok(
          String(step.settings?.prompt ?? "").startsWith(prepared.promptPrefix),
          `${slug} step ${step.id} prompt no longer starts with "${prepared.promptPrefix}"`,
        );
      }
    }
  });

  it("refuses prompts it has no prepared text for", async () => {
    const llm = createPilotLlm({ agentSlug: "find-inactive-devices" });
    await assert.rejects(
      () => llm.complete({ prompt: "Write a poem about devices." }),
      /Pilot mode has no prepared text for this step/,
    );
    await assert.rejects(
      () => createPilotLlm({ agentSlug: "compliance-overview" }).complete({ prompt: "Total managed devices: 3." }),
      /Pilot mode has no prepared text/,
    );
  });

  it("reads tenant data fences back into values", () => {
    const parsed = parsePilotPrompt(
      'Guest <tenant_data source="template:guest.displayName" nonce="abcdef0123456789">\nAda \\u003cAdmin\\u003e\n</tenant_data nonce="abcdef0123456789">.',
    );
    assert.equal(parsed.values.get("guest.displayName"), "Ada <Admin>");
    assert.equal(parsed.text, "Guest Ada <Admin>.");
  });

  it("writes the per-guest rationale from the guest facts and the shared clock", async () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    const llm = createPilotLlm({ agentSlug: "stale-guest-cleanup", clock: () => now });
    const fence = (path: string, value: string) =>
      `<tenant_data source="template:${path}" nonce="0123456789abcdef">\n${value}\n</tenant_data nonce="0123456789abcdef">`;
    const completion = await llm.complete({
      prompt: `Guest ${fence("guest.displayName", "Rosa Lindqvist")} (${fence("guest.userPrincipalName", "rosa_fabrikam-partner.invalid#EXT#@contoso-sample.invalid")}),\nexternal state: ${fence("guest.externalUserState", "PendingAcceptance")},\nlast sign-in: ${fence("guest.signInActivity.lastSignInDateTime", "2026-06-28T12:00:00.000Z")}.`,
    });
    assert.equal(completion.model, PILOT_COPY.preparedModel);
    assert.match(completion.text, /^Prepared sample report\. Rosa Lindqvist has not signed in for 120 days; the invitation was never accepted/);
  });
});
