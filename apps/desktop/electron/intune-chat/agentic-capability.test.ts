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

    recordAgenticOutcome("ollama", model, false, "iteration-cap");
    const decision = resolveAgenticCapabilityForTest({
      mode: "auto",
      provider,
      providerId: "ollama",
      model,
    });
    assert.equal(decision.enabled, false, "repeated failures stop the retry");
    assert.equal(decision.reason, "capability-fallback");
    // The notice says what the model did, not that it broke a format it may have kept.
    assert.equal(decision.notice, "Answered from cached data without the tool loop: openadminos/openadmin-8b did not complete its last 2 tool-loop answers: it did not finish its plan once. Chat skips the tool loop for this model until OpenAdminOS restarts or another model is selected.");
  });

  it("names every failure since the last success, context overflows included", () => {
    const model = "small-context-model";
    recordAgenticOutcome("ollama", model, false, "context-too-small");
    recordAgenticOutcome("ollama", model, false, "context-too-small");
    recordAgenticOutcome("ollama", model, false, "malformed");
    const decision = resolveAgenticCapabilityForTest({ mode: "auto", provider, providerId: "ollama", model });
    assert.equal(decision.enabled, false);
    assert.equal(decision.notice, "Answered from cached data without the tool loop: small-context-model did not complete its last 3 tool-loop answers: the question and its data did not fit its context window twice; it did not return a valid tool request once. Chat skips the tool loop for this model until OpenAdminOS restarts or another model is selected.");
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

  it("uses plain runtime copy for models that cannot use investigative mode", () => {
    const decision = resolveAgenticCapabilityForTest({
      mode: "auto",
      provider,
      providerId: "ollama",
      model: "tiny-2b",
    });

    assert.equal(
      decision.notice,
      "tiny-2b is too small for tool use. Chat answers from cached tenant data only and Marketplace tools are off. Use a model of 8B or larger.",
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
