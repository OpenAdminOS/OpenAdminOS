import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatRetrievedContext } from "./retrieval.js";

describe("documentation grounding in prompts", () => {
  it("numbers passages and keeps the source path with each one", () => {
    const rendered = formatRetrievedContext([
      { file: "intune/compliance.md", title: "Compliance policies", text: "Policies evaluate on check-in.", score: 0.9 },
      { file: "entra/ca.md", text: "Conditional Access evaluates per sign-in.", score: 0.8 },
    ]);
    // The citation markers and the file paths are what let an admin
    // verify a claim, so both must survive into the prompt.
    assert.match(rendered, /\[1\] Compliance policies - intune\/compliance\.md/);
    assert.match(rendered, /\[2\] entra\/ca\.md/);
    assert.match(rendered, /Policies evaluate on check-in\./);
  });

  it("renders nothing when no passages were retrieved", () => {
    assert.equal(formatRetrievedContext([]), "");
  });
});
