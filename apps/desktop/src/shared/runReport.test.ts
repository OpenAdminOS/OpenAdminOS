import { describe, expect, it } from "vitest";

import type { RunRecord } from "./openAdminOS.js";
import { aiGeneratedNote, runReportMarkdown, runReportPlaintext } from "./runReport.js";

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    agentSlug: "find-inactive-devices",
    status: "completed",
    queuedAt: "2026-10-31T10:00:00.000Z",
    steps: [],
    logs: [],
    ...overrides,
  } as RunRecord;
}

describe("run report AI-generated note", () => {
  it("names the provider and model", () => {
    expect(aiGeneratedNote(run({ providerId: "ollama", model: "llama3.1:8b" }))).toBe(
      "This report includes AI-generated text, produced in OpenAdminOS with ollama (llama3.1:8b).",
    );
  });

  it("names the provider when the model is unknown", () => {
    expect(aiGeneratedNote(run({ providerId: "ollama" }))).toBe(
      "This report includes AI-generated text, produced in OpenAdminOS with ollama.",
    );
  });

  it("says no model was used for pilot runs", () => {
    const pilot = run({ pilot: true, model: "pilot-prepared", summary: "Prepared sample report." });
    expect(aiGeneratedNote(pilot)).toBe(
      "This report uses prepared sample text. No model was used.",
    );
    const plain = runReportPlaintext(pilot, { sampleData: true });
    expect(plain).toContain("Provider: Pilot (prepared)");
    expect(plain).toContain("Data: Pilot mode sample data from a fictional company");
    expect(plain).not.toContain("AI-generated");
    expect(runReportMarkdown(pilot)).toContain("**Provider:** Pilot (prepared)");
    expect(runReportMarkdown(pilot)).not.toContain("AI-generated");
  });

  it("is omitted for runs without a provider", () => {
    const deterministic = run();
    expect(aiGeneratedNote(deterministic)).toBeUndefined();
    expect(runReportPlaintext(deterministic)).not.toContain("AI-generated");
    expect(runReportMarkdown(deterministic)).not.toContain("AI-generated");
  });

  it("ends the plaintext and Markdown reports", () => {
    const withModel = run({ providerId: "ollama", model: "llama3.1:8b", summary: "3 devices." });
    expect(runReportPlaintext(withModel).split("\n").at(-1)).toBe(aiGeneratedNote(withModel));
    expect(runReportMarkdown(withModel).split("\n").at(-1)).toBe(`_${aiGeneratedNote(withModel)}_`);
  });
});
