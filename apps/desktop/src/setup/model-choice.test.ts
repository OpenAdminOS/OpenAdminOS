import { describe, expect, it } from "vitest";

import type { ModelScanProbe, ProviderId, ProviderSummary } from "../shared/openAdminOS";
import { mockProviders } from "../test/test-utils";
import { actionLabel, actionNote, optionsFromProbes, optionsFromProviders, preselect } from "./model-choice";

const probe = (providerId: ProviderId, where: "local" | "hosted", rest: Partial<ModelScanProbe> = {}): ModelScanProbe => ({
  providerId, name: providerId, where, target: providerId, state: "found", summary: "Signed in", facts: [], ready: true, models: [], ...rest,
});

describe("the choice of what answers in Chat (design round, B)", () => {
  it("lists found tools local first, never a tool that is not here or an endpoint outside this device", () => {
    const options = optionsFromProbes([
      probe("anthropic", "hosted"),
      probe("lm-studio", "local", { state: "not-found", summary: "Not installed", ready: false }),
      probe("ollama", "local", { summary: "Installed, not running", ready: false }),
      probe("openai", "hosted", { state: "could-not-check", summary: "Endpoint outside this device", ready: false, notContacted: true }),
    ], { kind: "hosted-detected", providerIds: ["anthropic"] });
    expect(options.map((option) => [option.providerId, option.name, option.state, option.action])).toEqual([
      ["ollama", "Ollama", "Not running", "start"],
      ["anthropic", "Claude Code", "Signed in", "use"],
    ]);
    expect(options[1]!.whereLine).toBe("Prompts go to Anthropic API · US");
  });

  it("preselects the first local option that can answer or be started, and never a hosted one", () => {
    const hostedOnly = optionsFromProbes([probe("anthropic", "hosted"), probe("openai", "hosted")], undefined);
    expect(preselect(hostedOnly)).toBeNull();
    const mixed = optionsFromProbes([
      probe("anthropic", "hosted"),
      probe("ollama", "local", { summary: "Running, no model loaded", ready: false }),
      probe("lm-studio", "local", { summary: "Installed, not running", ready: false }),
    ], undefined);
    expect(preselect(mixed)).toBe("lm-studio");
    expect(preselect(optionsFromProbes([probe("ollama", "local", { summary: "Running, no model loaded", ready: false })], undefined))).toBe("ollama");
  });

  it("labels the one button by the choice", () => {
    const [ollama, lm, claude] = optionsFromProbes([
      probe("ollama", "local", { summary: "Running, 1 model", models: ["openadminos/openadmin-8b:latest"] }),
      probe("lm-studio", "local", { summary: "Installed, not running", ready: false }),
      probe("anthropic", "hosted"),
    ], { kind: "local-ready", providerId: "ollama", model: "openadminos/openadmin-8b:latest" });
    expect(actionLabel(ollama, "ollama")).toBe("Open Chat");
    expect(actionLabel(ollama, "anthropic")).toBe("Use OpenAdmin 8B");
    expect(actionLabel(lm)).toBe("Start LM Studio and open Chat");
    expect(actionNote(lm)).toBe("LM Studio keeps running after you quit OpenAdminOS.");
    expect(actionLabel(claude)).toBe("Use Claude Code");
    expect(actionNote(claude)).toBe("Uses your Claude Code sign-in. No API key is stored.");
    expect(actionLabel(undefined)).toBe("Choose a model");
    const [noModel] = optionsFromProbes([probe("ollama", "local", { summary: "Running, no model loaded", ready: false })], undefined);
    expect(noModel!.state).toBe("No model yet");
    expect(actionLabel(noModel)).toBe("Get OpenAdmin 8B");
  });

  it("builds the same rows from the provider list for Chat", () => {
    const providers: ProviderSummary[] = mockProviders.map((provider) =>
      provider.id === "ollama" ? { ...provider, status: "not-installed" as const, installed: true, models: [] } : provider,
    );
    const options = optionsFromProviders(providers);
    expect(options[0]).toMatchObject({ providerId: "ollama", name: "Ollama", state: "Not running", action: "start" });
    for (const option of options.filter((entry) => entry.where === "hosted")) {
      expect(option.whereLine).toMatch(/^Prompts go to /);
    }
  });
});
