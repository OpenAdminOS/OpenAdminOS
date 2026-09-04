import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recordAgenticOutcome, resolveAgenticCapabilityForTest } from "./service.js";

const provider = { id: "ollama", isLocal: true } as never;

describe("agentic capability routing", () => {
  it("keeps trying a model until it has failed repeatedly", () => {
    const model = "openadminos/openadmin-8b";
    recordAgenticOutcome("ollama", model, true); // reset any prior state
    assert.equal(
      resolveAgenticCapabilityForTest({ mode: "auto", provider, providerId: "ollama", model })
        .enabled,
      true,
      "an 8B model is not pre-judged by its name",
    );

    recordAgenticOutcome("ollama", model, false);
    assert.equal(
      resolveAgenticCapabilityForTest({ mode: "auto", provider, providerId: "ollama", model })
        .enabled,
      true,
      "one failure could be transient, so keep trying",
    );

    recordAgenticOutcome("ollama", model, false);
    const decision = resolveAgenticCapabilityForTest({
      mode: "auto",
      provider,
      providerId: "ollama",
      model,
    });
    assert.equal(decision.enabled, false, "repeated failures stop the retry");
    assert.equal(decision.reason, "capability-fallback");
    assert.match(decision.notice ?? "", /investigative format/i);
  });

  it("recovers when the model succeeds again", () => {
    const model = "recovering-model";
    recordAgenticOutcome("ollama", model, false);
    recordAgenticOutcome("ollama", model, false);
    assert.equal(
      resolveAgenticCapabilityForTest({ mode: "auto", provider, providerId: "ollama", model })
        .enabled,
      false,
    );
    recordAgenticOutcome("ollama", model, true);
    assert.equal(
      resolveAgenticCapabilityForTest({ mode: "auto", provider, providerId: "ollama", model })
        .enabled,
      true,
      "a success clears the failure record",
    );
  });

  it("never overrides an explicit user setting", () => {
    const model = "always-failing-model";
    recordAgenticOutcome("ollama", model, false);
    recordAgenticOutcome("ollama", model, false);
    assert.equal(
      resolveAgenticCapabilityForTest({
        mode: "always-agentic",
        provider,
        providerId: "ollama",
        model,
      }).enabled,
      true,
      "the user asked for agentic mode explicitly",
    );
  });
});
