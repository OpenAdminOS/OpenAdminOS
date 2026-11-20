import assert from "node:assert/strict";
import { it } from "node:test";

import type { LlmOptions, RunLlmApi } from "@openadminos/agent-sdk";

import { withSelfTrainingOverlay } from "./state-helpers.js";

const overlay = "Prefer the admin's naming for device groups and keep the report short.";

function recording(contextWindow?: number): { llm: RunLlmApi; sent: LlmOptions[] } {
  const sent: LlmOptions[] = [];
  return {
    sent,
    llm: {
      available: true,
      complete: async (options) => {
        sent.push(options);
        return { text: "ok", model: "m" };
      },
      async *stream(options) {
        sent.push(options);
        yield { delta: "ok", accumulated: "ok", model: "m", done: true };
      },
      ...(contextWindow !== undefined ? { contextWindow: async () => contextWindow } : {}),
    },
  };
}

it("names the overlay as a system suffix the run's size check counts, and forwards the real window", async () => {
  const { llm, sent } = recording(16_384);
  const wrapped = withSelfTrainingOverlay(llm, overlay);
  assert.equal(wrapped.systemSuffix, overlay);
  assert.equal(await wrapped.contextWindow?.(), 16_384);
  await wrapped.complete({ prompt: "Summarize.", system: "Base." });
  assert.equal(sent[0]!.system, `Base.\n\n${overlay}`);
});

it("keeps an unknown context window unknown", () => {
  assert.equal(withSelfTrainingOverlay(recording().llm, overlay).contextWindow, undefined);
});
