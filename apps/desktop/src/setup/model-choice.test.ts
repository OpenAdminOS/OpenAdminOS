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
    expect(options[1]!.whereLine).toBe("Prompts leave this device through Claude Code; location set by your account");
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
    // In Chat the admin is already there.
    expect(actionLabel(lm, undefined, "chat")).toBe("Start LM Studio");
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
      expect(option.whereLine).toMatch(/^Prompts (go to|leave this device through) /);
    }
  });

  it("never offers a running runtime without a model as ready, and gives it the scan's recovery (PR #175 onboarding round review, 3)", () => {
    const base = mockProviders.filter((provider) => provider.id === "ollama" || provider.id === "lm-studio");
    const running = (id: ProviderId, models: string[]): ProviderSummary => ({ ...base.find((provider) => provider.id === id)!, status: "connected", installed: true, models });
    const options = optionsFromProviders([running("ollama", []), running("lm-studio", [])]);
    expect(options.map((option) => [option.providerId, option.state, option.action])).toEqual([
      ["ollama", "No model yet", "get-model"],
      ["lm-studio", "No model yet", "rescan"],
    ]);
    expect(options[1]!.whereLine).toBe("On this device. Load a model in LM Studio, then scan again.");
    expect(actionLabel(options[1], undefined, "chat")).toBe("Scan again");
    // The same rows the send path accepts: a loaded model makes it ready.
    expect(optionsFromProviders([running("lm-studio", ["qwen3-8b"])])[0]).toMatchObject({ action: "open", state: "Ready", model: "qwen3-8b" });
  });
});

describe("Lemonade in the choice", () => {
  it("offers Scan again, never Start, for a stopped Lemonade and one without a chat model", () => {
    const options = optionsFromProbes([
      probe("lemonade", "local", { summary: "Installed, not running", ready: false }),
    ], undefined);
    expect(options).toEqual([
      expect.objectContaining({ providerId: "lemonade", name: "Lemonade", state: "Not running", action: "rescan", whereLine: "On this device. Start Lemonade Server, then scan again." }),
    ]);
    expect(actionLabel(options[0])).toBe("Scan again");

    // The scan's command for this OS, when it has one.
    const darwin = optionsFromProbes([probe("lemonade", "local", { summary: "Installed, not running", ready: false, facts: ["Start it with sudo launchctl kickstart -k system/ai.lemonadeserver.server, then scan again."] })], undefined);
    expect(darwin[0]!.whereLine).toBe("On this device. Start it with sudo launchctl kickstart -k system/ai.lemonadeserver.server, then scan again.");

    const empty = optionsFromProbes([probe("lemonade", "local", { summary: "Running, no chat model", ready: false })], undefined);
    expect(empty[0]).toMatchObject({ action: "rescan", state: "No model yet", whereLine: "On this device. Download a chat model in Lemonade, then scan again." });
  });

  it("reads the same rows from the provider list, after LM Studio and before Apple Intelligence", () => {
    const lemonade: ProviderSummary = { id: "lemonade", name: "Lemonade", description: "", isLocal: true, status: "connected", models: ["Qwen3-0.6B-GGUF"], defaultModel: "Qwen3-0.6B-GGUF" };
    const lmStudio: ProviderSummary = { id: "lm-studio", name: "LM Studio", description: "", isLocal: true, status: "connected", models: ["m"], defaultModel: "m" };
    const apple: ProviderSummary = { id: "apple-foundation", name: "Apple Intelligence", description: "", isLocal: true, status: "connected", models: ["SystemLanguageModel.default"] };
    expect(optionsFromProviders([apple, lemonade, lmStudio]).map((option) => [option.providerId, option.action])).toEqual([
      ["lm-studio", "open"],
      ["lemonade", "open"],
      ["apple-foundation", "open"],
    ]);
    expect(optionsFromProviders([{ ...lemonade, models: [], defaultModel: undefined }])[0]).toMatchObject({ action: "rescan", state: "No model yet" });
    expect(optionsFromProviders([{ ...lemonade, status: "not-installed", models: [], defaultModel: undefined, installed: true, detail: "Start it with sudo systemctl start lemond, then scan again." }])[0]).toMatchObject({
      action: "rescan",
      state: "Not running",
      whereLine: "On this device. Start it with sudo systemctl start lemond, then scan again.",
    });
    expect(optionsFromProviders([{ ...lemonade, status: "not-installed", models: [], defaultModel: undefined }])).toEqual([]);
  });
});

describe("a provider whose check failed in Chat's choice (PR #191 follow-up)", () => {
  const local = (id: ProviderId, name: string, rest: Partial<ProviderSummary> = {}): ProviderSummary => ({ id, name, description: "", isLocal: true, status: "error", checkFailed: true, models: [], ...rest });

  it("shows every local runtime whose check failed as could not check with its reason, never as missing or without a model", () => {
    const options = optionsFromProviders([
      local("ollama", "Ollama", { detail: "Ollama on http://127.0.0.1:11434 did not answer in time." }),
      local("lm-studio", "LM Studio", { detail: "LM Studio answered HTTP 500." }),
      local("lemonade", "Lemonade", { detail: "Lemonade asks for an API key." }),
      local("apple-foundation", "Apple Intelligence"),
    ]);
    expect(options.map((option) => [option.providerId, option.state, option.unavailable, option.whereLine])).toEqual([
      ["ollama", "Could not check", true, "Ollama on http://127.0.0.1:11434 did not answer in time."],
      ["lm-studio", "Could not check", true, "LM Studio answered HTTP 500."],
      ["lemonade", "Could not check", true, "Lemonade asks for an API key."],
      ["apple-foundation", "Could not check", true, "Apple Intelligence did not answer. Retry to check it again."],
    ]);
    expect(preselect(options)).toBeNull();
  });

  it("shows a hosted tool whose check failed the same way, and never preselects a failed row over a working one", () => {
    const hosted: ProviderSummary = { id: "anthropic", name: "Claude Code", description: "", isLocal: false, status: "error", checkFailed: true, detail: "spawn EINVAL", models: [] };
    const ready = local("lm-studio", "LM Studio", { status: "connected", checkFailed: undefined, models: ["qwen3-8b"] });
    const options = optionsFromProviders([hosted, local("ollama", "Ollama"), ready]);
    expect(options.map((option) => [option.providerId, option.where, option.state, option.unavailable ?? false])).toEqual([
      ["ollama", "local", "Could not check", true],
      ["lm-studio", "local", "Ready", false],
      ["anthropic", "hosted", "Could not check", true],
    ]);
    expect(preselect(options)).toBe("lm-studio");
  });

  it("shows a hosted CLI whose status request failed as could not check, from the summary the CLI check builds (Muse round 1, P1)", () => {
    // checkClaudeCode: installed, not ready, probe.failure "request-failed"; no checkFailed.
    const claude: ProviderSummary = {
      id: "anthropic", name: "Claude Code", description: "", isLocal: false, status: "error",
      detail: "claude auth status failed: getaddrinfo ENOTFOUND api.anthropic.com", models: [],
      cli: { binaryPath: "/usr/local/bin/claude", version: "2.1.0", state: "request-failed" },
    };
    expect(optionsFromProviders([claude])).toEqual([
      expect.objectContaining({ providerId: "anthropic", where: "hosted", state: "Could not check", unavailable: true, whereLine: "claude auth status failed: getaddrinfo ENOTFOUND api.anthropic.com" }),
    ]);
  });

  it("shows an endpoint the scan did not contact as not checked, off the device and without Retry (review round 1)", () => {
    // What the scan serves for an LM Studio set outside this device.
    const served: ProviderSummary = {
      id: "lm-studio", name: "LM Studio", description: "", isLocal: false, status: "error", checkFailed: true, notContacted: true, models: [],
      detail: "LM Studio is set to http://10.0.0.5:1234/v1. The scan only checks this device. Check it in Settings, Providers.",
    };
    const [row] = optionsFromProviders([served]);
    expect(row).toMatchObject({ where: "hosted", state: "Not checked", unavailable: true, notContacted: true, whereLine: served.detail });
    expect(optionsFromProviders([{ ...served, detail: undefined }])[0]!.whereLine).toBe(
      "LM Studio is set to an endpoint outside this device, so it was not checked here. Check it in Settings, Providers.",
    );
  });

  it("tells the admin that only a Test clears an earlier failed Gemini request (round 4)", () => {
    const gemini: ProviderSummary = { id: "gemini", name: "Gemini CLI", description: "", isLocal: false, status: "error", detail: "Gemini CLI request failed.", models: [], cli: { state: "request-failed" } };
    expect(optionsFromProviders([gemini])[0]!.whereLine).toBe("Gemini CLI request failed. A failed Gemini request clears only after a Test in Settings, Providers.");
  });

  it("leaves a completed check's row as it was", () => {
    // No text model is a completed check: the scan's recovery, not could not check.
    expect(optionsFromProviders([local("ollama", "Ollama", { checkFailed: undefined })])[0]).toMatchObject({ state: "No model yet", action: "get-model" });
    expect(optionsFromProviders([local("ollama", "Ollama", { checkFailed: undefined })])[0]!.unavailable).toBeUndefined();
  });
});
