import assert from "node:assert/strict";
import { it } from "node:test";

import type { RunLlmApi } from "@openadminos/agent-sdk";
import { estimateTokens } from "@openadminos/runtime";

import { withSelfTrainingOverlay } from "./state-helpers.js";

const base: RunLlmApi = {
  available: true,
  complete: async () => ({ text: "", model: "m" }),
  async *stream() {},
};

it("takes the self-training overlay off the context window the run's size check sees", async () => {
  const overlay = "Prefer the admin's naming. ".repeat(40);
  const wrapped = withSelfTrainingOverlay({ ...base, contextWindow: async () => 16_384 }, overlay);
  assert.equal(await wrapped.contextWindow?.(), 16_384 - estimateTokens(`\n\n${overlay}`));
});

it("keeps an unknown context window unknown", async () => {
  assert.equal(withSelfTrainingOverlay(base, "x").contextWindow, undefined);
  const unknown = withSelfTrainingOverlay({ ...base, contextWindow: async () => undefined }, "x");
  assert.equal(await unknown.contextWindow?.(), undefined);
});
