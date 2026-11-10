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

describe("Chat documentation grounding", () => {
  it("retains documentation retrieval in all four Chat answer paths", async () => {
    const service = await readFile(
      new URL("../intune-chat/service.ts", import.meta.url),
      "utf8",
    );
    // Two deterministic paths (streaming and not) build their prompt via
    // buildAnswerPrompt; two agentic call sites pass `documentation`.
    // Voice research may omit broad documentation and use question-specific
    // tools instead. Ordinary Chat must retain retrieval in both paths.
    assert.equal(
      (service.match(/buildAnswerPrompt\(answerPack/g) ?? []).length,
      2,
      "both deterministic paths should build a grounded prompt",
    );
    // When a server is the chosen source or the model classifies, the index waits; a tenant question skips it.
    assert.equal(
      (service.match(/indexLater \|\| answerPlan\??\.sources\.kind === "tenant" \? \[\] : await this\.searchDocsIndex\(modelQuestion, steps\)/g) ?? []).length,
      2,
      "both agentic call sites should pass retrieved documentation",
    );
    assert.equal(
      (service.match(/documentationFallback: \(reason\?: string\) => this\.searchDocsIndex\(modelQuestion, steps, reason\)/g) ?? []).length,
      2,
      "both agentic call sites should fall back to the index when Learn is left out, fails, is blocked or returns nothing",
    );
    // The deterministic prompt and the tool loop prompt give the same rule about citing passages that do not apply.
    const loop = await readFile(new URL("../intune-chat/agentic-loop.ts", import.meta.url), "utf8");
    const rule = "A passage about another product or topic is not a source: do not cite it, also not to say that it does not apply.";
    assert.ok(service.includes(rule), "the deterministic answer prompt carries the citation rule");
    assert.ok(loop.includes(rule), "the tool loop prompt carries the citation rule");
  });
});
