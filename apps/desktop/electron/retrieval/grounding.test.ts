import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

describe("every answer path is grounded", () => {
  it("passes documentation into all four chat answer paths", async () => {
    const service = await readFile(
      new URL("../intune-chat/service.ts", import.meta.url),
      "utf8",
    );
    // Two deterministic paths (streaming and not) build their prompt via
    // buildAnswerPrompt; two agentic call sites pass `documentation`.
    // Hosted providers always route agentic, so missing that side would
    // silently leave every hosted user ungrounded.
    assert.equal(
      (service.match(/buildAnswerPrompt\(answerPack/g) ?? []).length,
      2,
      "both deterministic paths should build a grounded prompt",
    );
    assert.equal(
      (service.match(/documentation: await this\.retrieveDocumentationSafely/g) ?? [])
        .length,
      2,
      "both agentic call sites should pass retrieved documentation",
    );
  });
});
