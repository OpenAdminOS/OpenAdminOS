import assert from "node:assert/strict";
import { it } from "node:test";

import { ContextTooSmallError, type LlmOptions, type RunLlmApi } from "@openadminos/agent-sdk";
import { checkPromptFit } from "@openadminos/runtime";

import { withSelfTrainingOverlay } from "./state-helpers.js";

function recording(contextWindow?: number): { llm: RunLlmApi; sent: LlmOptions[] } {
  const sent: LlmOptions[] = [];
  return {
    sent,
    llm: {
      available: true,
      defaultModel: "openadminos/openadmin-8b:latest",
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

const overlay = "Prefer the admin's naming for device groups and keep the report short. ".repeat(60);

it("refuses a request that fits on its own but not with the overlay, with the model's real limit", async () => {
  const limit = 4096;
  // A prompt that fits the window alone, but not once the overlay is added.
  let prompt = "word ";
  while (checkPromptFit({ prompt: prompt + "word ", maxTokens: 200, contextWindow: limit }).fits) prompt += "word ";
  const { llm, sent } = recording(limit);
  const wrapped = withSelfTrainingOverlay(llm, overlay);
  assert.equal(await wrapped.contextWindow?.(), limit);
  await assert.rejects(() => wrapped.complete({ prompt, maxTokens: 200 }), (error: unknown) => {
    assert.ok(error instanceof ContextTooSmallError);
    assert.equal(error.failure.limitTokens, limit);
    assert.ok(error.failure.promptTokens > checkPromptFit({ prompt }).promptTokens);
    return true;
  });
  assert.equal(sent.length, 0);
});

it("sends with the overlay when it fits, and never checks a provider without a window", async () => {
  const fits = recording(16_384);
  await withSelfTrainingOverlay(fits.llm, overlay).complete({ prompt: "Summarize.", maxTokens: 200 });
  assert.equal(fits.sent.length, 1);
  assert.ok(fits.sent[0]!.system?.endsWith(overlay));

  const hosted = recording();
  const wrapped = withSelfTrainingOverlay(hosted.llm, overlay);
  assert.equal(wrapped.contextWindow, undefined);
  for await (const _chunk of wrapped.stream({ prompt: "word ".repeat(100_000) })) { /* drain */ }
  assert.equal(hosted.sent.length, 1);
});
