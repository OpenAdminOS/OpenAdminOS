import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";

import { MICROSOFT_STEP_COPY, MODEL_SCAN_COPY } from "../copy";
import type { ModelScanOutcome, ModelScanProbe, ModelScanResult, ProviderId } from "../shared/openAdminOS";
import { createMockAppState, createMockMcpServers, makeMockBridge, renderWithAppState } from "../test/test-utils";
import { ModelScanGate, ScanAgainButton } from "./FirstRunScan";

const probe = (providerId: ProviderId, name: string, where: "local" | "hosted", target: string, rest: Partial<ModelScanProbe> = {}): ModelScanProbe => ({
  providerId, name, where, target, state: "found", summary: "Signed in", facts: [], ready: true, models: [], ...rest,
});
const PROBES: ModelScanProbe[] = [
  probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false, facts: ["Start it with `ollama serve`, then scan again."] }),
  probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false }),
  probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status", { facts: ["Version 2.1.0"] }),
  probe("copilot", "GitHub Copilot CLI", "hosted", "copilot --version", { state: "could-not-check", summary: "Could not check", ready: false, facts: ["GitHub Copilot CLI did not answer within 2.5 seconds. Retry to check again."] }),
];

function scanBridge(outcome: ModelScanOutcome, probes: ModelScanProbe[] = PROBES, state = createMockAppState({ tenants: [], activeTenantId: undefined, firstRunScanPending: true })) {
  let listener: ((probe: ModelScanProbe, scanId?: string) => void) | undefined;
  let currentScanId: string | undefined;
  let finish: (() => void) | undefined;
  const result: ModelScanResult = { probes, outcome, startedAt: "2026-11-09T09:00:00.000Z", finishedAt: "2026-11-09T09:00:00.120Z" };
  const bridge = makeMockBridge(
    {
      onModelScanProgress: vi.fn((next: (probe: ModelScanProbe, scanId?: string) => void) => {
        listener = next;
        return () => { listener = undefined; };
      }),
      startModelScan: vi.fn((scanId?: string) => new Promise<ModelScanResult>((resolve) => {
        currentScanId = scanId;
        for (const entry of probes) listener?.({ ...entry, state: "checking", summary: "Checking", facts: [] }, scanId);
        finish = () => {
          for (const entry of probes) listener?.(entry, scanId);
          resolve(result);
        };
      })),
      retryModelScanProbe: vi.fn(async (id: ProviderId): Promise<ModelScanResult> => {
        const retried = probes.map((entry) => (entry.providerId === id ? { ...entry, state: "found" as const, summary: "Signed in", ready: true, facts: [] } : entry));
        const hosted = retried.filter((entry) => entry.where === "hosted" && entry.ready).map((entry) => entry.providerId);
        return { ...result, probes: retried, outcome: hosted.length > 0 ? { kind: "hosted-detected", providerIds: hosted } : outcome, finishedAt: "retried" };
      }),
      completeFirstRunScan: vi.fn(async () => ({ ...state, firstRunScanPending: undefined })),
      startLocalRuntime: vi.fn(async () => ({ started: true, scan: result })),
      setActiveProviderAndModel: vi.fn(async () => state),
    },
    state,
  );
  return {
    bridge,
    /**
     * Completes the scan the window started. It waits for the window to call
     * `startModelScan` and fails loudly when it never does, so no test
     * finishes a scan that has not begun (review round 5, item 2).
     */
    finish: async (timeout = 3000) => {
      await waitFor(() => {
        if (!finish) throw new Error("finish() was called before the window started the scan (startModelScan was not called).");
      }, { timeout });
      finish!();
    },
    /** Sends a progress event as an older scan run would. */
    emitForeign: (entry: ModelScanProbe) => listener?.(entry, `${currentScanId}-older`),
  };
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function renderGate(bridge: ReturnType<typeof makeMockBridge>) {
  return renderWithAppState(
    <ModelScanGate>
      <Routes>
        <Route path="*" element={<div>App content<ScanAgainButton /><Where /></div>} />
      </Routes>
    </ModelScanGate>,
    { route: "/chat", bridge },
  );
}

/** The second onboarding step follows the scan on a fresh install; Not now opens Chat. */
async function leaveMicrosoftStep(user: ReturnType<typeof userEvent.setup>) {
  expect(await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.title })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.notNow }));
}

const reducedMotion = () => {
  beforeEach(() => document.documentElement.setAttribute("data-reduced-motion", ""));
  afterEach(() => document.documentElement.removeAttribute("data-reduced-motion"));
};

describe("the scan test fixture (review round 5, item 2)", () => {
  it("fails loudly when a test finishes a scan the window never started", async () => {
    const { finish } = scanBridge({ kind: "nothing" });
    await expect(finish(100)).rejects.toThrow(/before the window started the scan/);
  });
});

describe("first-launch model scan screen", () => {
  reducedMotion();
  const radio = (name: string) => screen.getByRole("radio", { name: new RegExp(`^${name}`) });

  it("shows before anything else on a fresh install, one line per check while it runs", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);

    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title })).toBeInTheDocument();
    expect(screen.getByText(MODEL_SCAN_COPY.subtitle)).toBeInTheDocument();
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { busy: true });
    expect(await within(list).findByText("Ollama")).toBeInTheDocument();
    // No buttons and no technical targets while it runs (design round, A).
    expect(within(list).queryByText("localhost:11434")).toBeNull();
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText("0 of 4 checked")).toBeInTheDocument();

    await finish();
    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle })).toBeInTheDocument();
    expect(screen.getByText("What ran: localhost:11434; localhost:1234; claude --version, claude auth status; copilot --version. The Claude Code and Codex sign-in status commands may check with their provider. No prompt was sent to any model.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Scan finished\./));
    // What ran says what each signed-in tool's location depends on (maintainer decision, 2026-11-09).
    expect(screen.getByText(/^Claude Code: Claude Code sends prompts to Anthropic, or to Amazon Bedrock or Google Vertex/)).toBeInTheDocument();
  });

  it("shows the settled state with no motion under reduced motion", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    const { container } = renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-motion", "reduced");
    await finish();
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-phase", "settled");
    // The stage is decorative; the lists are the accessible source.
    expect(container.querySelector(".scan-stage")).toHaveAttribute("aria-hidden", "true");
  });

  it("offers one choice, local first and preselected, with one button whose label follows it (design round, B)", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    const { container } = renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();

    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });
    const group = screen.getByRole("radiogroup", { name: "What answers in Chat" });
    const names = within(group).getAllByRole("radio").map((entry) => (entry as HTMLInputElement).value);
    expect(names).toEqual(["ollama", "anthropic", "copilot"]);
    expect(radio("Ollama")).toBeChecked();
    expect(radio("Claude Code")).not.toBeChecked();
    expect(within(group).getByText("Prompts leave this device through Claude Code; location set by your account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Ollama and open Chat" })).toBeInTheDocument();
    expect(screen.getByText("Ollama keeps running after you quit OpenAdminOS.")).toBeInTheDocument();
    // One filled button; the rest are quiet links.
    expect(container.querySelectorAll("[data-variant='primary'], .btn-primary").length).toBeLessThanOrEqual(1);
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();

    await user.click(radio("Claude Code"));
    expect(screen.getByText("Uses your Claude Code sign-in. No API key is stored.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use Claude Code" }));
    await waitFor(() => expect(bridge.setActiveProvider).toHaveBeenCalledWith("anthropic"));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
    await leaveMicrosoftStep(user);
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/chat");
  });

  it("never preselects a hosted tool: with only hosted tools found the button asks for a choice", async () => {
    const user = userEvent.setup();
    const hosted = [probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status"), probe("openai", "Codex", "hosted", "codex --version, codex login status")];
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic", "openai"] }, hosted);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });
    expect(radio("Claude Code")).not.toBeChecked();
    expect(radio("Codex")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Choose a model" })).toBeDisabled();
    await user.click(radio("Codex"));
    expect(screen.getByRole("button", { name: "Use Codex" })).toBeEnabled();
  });

  it("mirrors the choice in the orbit, and a found node selects its row", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    const { container } = renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });
    const node = (initials: string) => [...container.querySelectorAll<HTMLElement>(".scan-node")].find((entry) => entry.textContent?.startsWith(initials))!;
    expect(node("Ol")).toHaveAttribute("data-selected", "true");
    await user.click(radio("Claude Code"));
    expect(node("Cc")).toHaveAttribute("data-selected", "true");
    expect(node("Ol")).toHaveAttribute("data-selected", "false");
    await user.click(node("Ol"));
    expect(radio("Ollama")).toBeChecked();
  });

  it("names a ready local model large, says nothing leaves the device and opens Chat", async () => {
    const user = userEvent.setup();
    const local = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 2 models", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true })];
    const { bridge, finish } = scanBridge({ kind: "local-selected", providerId: "ollama", model: "openadminos/openadmin-8b:latest" }, local);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();

    expect(await screen.findByRole("heading", { name: "OpenAdmin 8B is ready on this device" })).toBeInTheDocument();
    expect(screen.getAllByText(MODEL_SCAN_COPY.nothingLeaves).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.openChat }));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
    expect(bridge.setActiveProviderAndModel).not.toHaveBeenCalled();
  });

  it("starts an installed Ollama, selects it and opens Chat once it answers with a model", async () => {
    const user = userEvent.setup();
    const stopped = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped, createMockAppState({ tenants: [], activeTenantId: undefined, firstRunScanPending: true, activeProviderId: "anthropic" }));
    const running = probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 1 model", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true });
    vi.mocked(bridge.startLocalRuntime!).mockResolvedValue({
      started: true,
      scan: { probes: [running], outcome: { kind: "local-ready", providerId: "ollama", model: "openadminos/openadmin-8b:latest" }, startedAt: "", finishedAt: "later" },
    });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();

    await user.click(await screen.findByRole("button", { name: "Start Ollama and open Chat" }));
    await waitFor(() => expect(bridge.startLocalRuntime).toHaveBeenCalledWith("ollama"));
    await waitFor(() => expect(bridge.setActiveProviderAndModel).toHaveBeenCalledWith("ollama", "openadminos/openadmin-8b:latest"));
    await leaveMicrosoftStep(user);
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/chat");
  });

  it("says No model yet and offers OpenAdmin 8B when a started Ollama has no model", async () => {
    const user = userEvent.setup();
    const stopped = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped);
    const empty = probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, no model loaded", ready: false, models: [] });
    vi.mocked(bridge.startLocalRuntime!).mockResolvedValue({ started: true, scan: { probes: [empty], outcome: { kind: "nothing" }, startedAt: "", finishedAt: "later", generation: 9 } });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await user.click(await screen.findByRole("button", { name: "Start Ollama and open Chat" }));
    expect(await screen.findByRole("button", { name: "Get OpenAdmin 8B" })).toBeInTheDocument();
    expect(within(screen.getByRole("radiogroup")).getByText("No model yet")).toBeInTheDocument();
    expect(bridge.completeFirstRunScan).not.toHaveBeenCalled();
  });

  it("writes a failed start under its row, naming the command to run", async () => {
    const user = userEvent.setup();
    const stopped = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped);
    vi.mocked(bridge.startLocalRuntime!).mockResolvedValue({
      started: false,
      message: "Ollama did not answer within 12 seconds. Start it yourself with `ollama serve`, then scan again.",
    });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();

    await user.click(await screen.findByRole("button", { name: "Start Ollama and open Chat" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Ollama did not answer within 12 seconds. Start it yourself with ollama serve, then scan again.");
    expect(alert.closest("[data-provider]")).toHaveAttribute("data-provider", "ollama");
    expect(screen.getByRole("button", { name: "Start Ollama and open Chat" })).toBeEnabled();
  });

  it("offers OpenAdmin 8B and all providers when nothing is found, and no sample data (maintainer decision, 2026-11-09)", async () => {
    const user = userEvent.setup();
    const none = [probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, none);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();

    expect(await screen.findByRole("heading", { name: MODEL_SCAN_COPY.nothingTitle })).toBeInTheDocument();
    expect(screen.getByText(MODEL_SCAN_COPY.installCommand)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MODEL_SCAN_COPY.allProviders })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sample data/i })).toBeNull();
    expect(bridge.addSampleTenant).not.toHaveBeenCalled();
    void user;
  });

  it("shows a check that could not finish with Retry, and announces the new result", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();

    expect(await screen.findByText(/did not answer within 2\.5 seconds/)).toBeInTheDocument();
    expect(radio("GitHub Copilot CLI")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Check GitHub Copilot CLI again" }));
    await waitFor(() => expect(bridge.retryModelScanProbe).toHaveBeenCalledWith("copilot"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("GitHub Copilot CLI: Signed in."), { timeout: 3000 });
  });

  it("offers a hosted tool a Retry found, when the first scan found no model", async () => {
    const user = userEvent.setup();
    const timedOut = [
      probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false }),
      probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status", { state: "could-not-check", summary: "Could not check", ready: false, facts: ["Claude Code did not answer within 2.5 seconds. Retry to check again."] }),
    ];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, timedOut);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });

    await user.click(screen.getByRole("button", { name: "Check Claude Code again" }));
    await waitFor(() => expect(radio("Claude Code")).toBeEnabled());
    expect(radio("Claude Code")).not.toBeChecked();
    await user.click(radio("Claude Code"));
    expect(screen.getByRole("button", { name: "Use Claude Code" })).toBeEnabled();
  });

  it("offers the local model while the admin's own hosted choice stays selected, and switches in one call", async () => {
    const user = userEvent.setup();
    const both = [
      probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 1 model", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true }),
      probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status"),
    ];
    const state = createMockAppState({ tenants: [], activeTenantId: undefined, firstRunScanPending: true, activeProviderId: "anthropic" });
    const { bridge, finish } = scanBridge({ kind: "local-available", providerId: "ollama", model: "openadminos/openadmin-8b:latest", selectedProviderId: "anthropic" }, both, state);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();

    // Nothing local is promised until the admin switches.
    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle })).toBeInTheDocument();
    await waitFor(() => expect(radio("Ollama")).toBeChecked());
    await user.click(screen.getByRole("button", { name: "Use OpenAdmin 8B" }));
    // Provider and model in one call, so a failed model never leaves a half switch (round 2, D).
    await waitFor(() => expect(bridge.setActiveProviderAndModel).toHaveBeenCalledWith("ollama", "openadminos/openadmin-8b:latest"));
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
  });

  it("ignores progress from another scan run (review round 1, finding L)", async () => {
    const { bridge, emitForeign } = scanBridge({ kind: "nothing" });
    renderGate(bridge);
    await screen.findByText("0 of 4 checked");
    emitForeign(probe("gemini", "Gemini CLI", "hosted", "gemini --version"));
    emitForeign({ ...PROBES[2]!, summary: "Signed out elsewhere" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByText("Gemini CLI")).not.toBeInTheDocument();
    expect(screen.queryByText("Signed out elsewhere")).not.toBeInTheDocument();
    expect(screen.getByText("0 of 4 checked")).toBeInTheDocument();
  });

  it("writes a failed Start of the second runtime under its own row (round 2, item 8)", async () => {
    const user = userEvent.setup();
    const stopped = [
      probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false }),
      probe("lm-studio", "LM Studio", "local", "localhost:1234", { summary: "Installed, not running", ready: false }),
    ];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped);
    vi.mocked(bridge.startLocalRuntime!).mockResolvedValue({ started: false, message: "LM Studio was not found on this device. Start it yourself with `lms server start`, then scan again." });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });
    await user.click(radio("LM Studio"));
    await user.click(screen.getByRole("button", { name: "Start LM Studio and open Chat" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("LM Studio was not found on this device. Start it yourself with lms server start, then scan again.");
    expect(alert.closest("[data-provider]")).toHaveAttribute("data-provider", "lm-studio");
    // A failed start does not rescan or replace the result.
    expect(screen.getByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle })).toBeInTheDocument();
  });

  it("never lets an older Retry overwrite a newer result (round 2, item 7)", async () => {
    const user = userEvent.setup();
    const timedOut = [
      probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status", { state: "could-not-check", summary: "Could not check", ready: false }),
      probe("openai", "Codex", "hosted", "codex --version, codex login status", { state: "could-not-check", summary: "Could not check", ready: false }),
    ];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, timedOut);
    const resolvers: Array<(scan: ModelScanResult) => void> = [];
    vi.mocked(bridge.retryModelScanProbe!).mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });
    await user.click(screen.getByRole("button", { name: "Check Claude Code again" }));
    // One Retry at a time (Muse round 4, A).
    expect(screen.getByRole("button", { name: "Check Codex again" })).toBeDisabled();
    // Codex is found by a scan numbered 5; Claude Code still could not be checked.
    const newer: ModelScanResult = {
      probes: timedOut.map((entry) => (entry.providerId === "openai" ? { ...entry, state: "found", summary: "Signed in", ready: true } : entry)),
      outcome: { kind: "hosted-detected", providerIds: ["openai"] }, startedAt: "", finishedAt: "b", generation: 5,
    };
    const older: ModelScanResult = { probes: timedOut, outcome: { kind: "nothing" }, startedAt: "", finishedAt: "a", generation: 4 };
    resolvers[0]!(newer);
    await waitFor(() => expect(radio("Codex")).toBeEnabled());
    // A later answer numbered before the one shown never replaces it.
    const again = await screen.findByRole("button", { name: "Check Claude Code again" });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    resolvers[1]!(older);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(radio("Codex")).toBeEnabled();
  });

  it("does not claim nothing leaves when a public reference is enabled (round 2, item 9)", async () => {
    const local = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 1 model", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true })];
    const withReference = createMockAppState({ mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true } }) });
    const { bridge, finish } = scanBridge({ kind: "local-ready", providerId: "ollama", model: "openadminos/openadmin-8b:latest" }, local, withReference);
    renderGate(bridge);
    await userEvent.setup().click(await screen.findByRole("button", { name: MODEL_SCAN_COPY.scanAgain }));
    await finish();
    await screen.findByRole("heading", { level: 1, name: "OpenAdmin 8B is ready on this device" });
    expect(screen.queryByText(MODEL_SCAN_COPY.nothingLeaves)).not.toBeInTheDocument();
    expect(screen.getAllByText("Runs on this device. Your references get tool queries to learn.microsoft.com.").length).toBeGreaterThan(0);
  });

  it("can be left before it settles, completing the first run without selecting anything (round 2, item N)", async () => {
    const user = userEvent.setup();
    const { bridge } = scanBridge({ kind: "nothing" });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.continueToChat }));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
    await leaveMicrosoftStep(user);
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
  });

  it("does not list a refused off-device endpoint as something that ran (Muse round 3, M3)", async () => {
    const probes = [
      probe("ollama", "Ollama", "local", "10.0.0.5:11434", { state: "could-not-check", summary: "Endpoint outside this device", ready: false, notContacted: true }),
      probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status"),
    ];
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] }, probes);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    const ledger = await screen.findByText(/^What ran:/);
    expect(ledger.textContent).toContain("What ran: claude --version, claude auth status.");
    expect(ledger.textContent).toContain("Not contacted, set outside this device: 10.0.0.5:11434.");
    // A refused endpoint is not a choice.
    expect(screen.queryByRole("radio", { name: /^Ollama/ })).toBeNull();
  });

  it("renders what the first-run screenshot capture waits for once settled (review round 4, item 4)", async () => {
    // electron/first-run-capture.ts waits for the settled phase and this exit by its exact label.
    const { bridge, finish } = scanBridge({ kind: "nothing" });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await waitFor(() => expect(document.querySelector('[data-phase="settled"]')).not.toBeNull());
    expect(screen.getByRole("button", { name: "Continue without a model" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sample data/i })).toBeNull();
  });

  it("keeps every exit and the choice disabled while a Start is polling (Muse round 3, M2)", async () => {
    const user = userEvent.setup();
    const stopped = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false }), probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status")];
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] }, stopped);
    vi.mocked(bridge.startLocalRuntime!).mockReturnValue(new Promise(() => undefined));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await user.click(await screen.findByRole("button", { name: "Start Ollama and open Chat" }));
    await waitFor(() => expect(bridge.startLocalRuntime).toHaveBeenCalledOnce());
    for (const name of [MODEL_SCAN_COPY.continueWithoutModel, MODEL_SCAN_COPY.scanAgain, "Start Ollama and open Chat"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(radio("Claude Code")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.continueWithoutModel }));
    expect(bridge.completeFirstRunScan).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle })).toBeInTheDocument();
  });

  it("locks every exit and action while a Retry runs (Muse round 4, A)", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    vi.mocked(bridge.retryModelScanProbe!).mockReturnValue(new Promise(() => undefined));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await user.click(await screen.findByRole("button", { name: MODEL_SCAN_COPY.retryLabel("GitHub Copilot CLI") }));
    await waitFor(() => expect(bridge.retryModelScanProbe).toHaveBeenCalledOnce());
    for (const name of [MODEL_SCAN_COPY.continueWithoutModel, "Start Ollama and open Chat"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    expect(radio("Claude Code")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.continueWithoutModel }));
    expect(bridge.completeFirstRunScan).not.toHaveBeenCalled();
    expect(bridge.startLocalRuntime).not.toHaveBeenCalled();
  });

  it("locks the row Retry while a Start runs (Muse round 4, A)", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    vi.mocked(bridge.startLocalRuntime!).mockReturnValue(new Promise(() => undefined));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await finish();
    await user.click(await screen.findByRole("button", { name: "Start Ollama and open Chat" }));
    await waitFor(() => expect(bridge.startLocalRuntime).toHaveBeenCalledOnce());
    const retry = screen.getByRole("button", { name: MODEL_SCAN_COPY.retryLabel("GitHub Copilot CLI") });
    expect(retry).toBeDisabled();
    await user.click(retry);
    expect(bridge.retryModelScanProbe).not.toHaveBeenCalled();
  });

  it("leaves once when Continue is pressed twice before it settles (Muse round 3, M2)", async () => {
    const user = userEvent.setup();
    const { bridge } = scanBridge({ kind: "nothing" });
    let complete: (() => void) | undefined;
    vi.mocked(bridge.completeFirstRunScan!).mockImplementation(() => new Promise((resolve) => { complete = () => resolve(createMockAppState()); }));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    const continueButton = screen.getByRole("button", { name: MODEL_SCAN_COPY.continueToChat });
    await user.click(continueButton);
    await waitFor(() => expect(continueButton).toBeDisabled());
    await user.click(continueButton);
    complete?.();
    await leaveMicrosoftStep(user);
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce();
  });

  it("focuses the heading on open and on settle (round 2, item L)", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);
    const heading = await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await waitFor(() => expect(heading).toHaveFocus());
    await finish();
    const settled = await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle });
    await waitFor(() => expect(settled).toHaveFocus());
  });

  it("does not show after the first launch, and opens again from Scan again", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "nothing" }, PROBES, createMockAppState());
    renderGate(bridge);

    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(bridge.startModelScan).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.scanAgain }));
    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title })).toBeInTheDocument();
    await finish();
    await user.click(await screen.findByRole("button", { name: MODEL_SCAN_COPY.continueWithoutModel }));
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(bridge.completeFirstRunScan).not.toHaveBeenCalled();
  });
});

describe("first-launch model scan with motion", () => {
  it("can be skipped with a key, showing every result and the settled result at once", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    const { container } = renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-motion", "full");
    await finish();
    // Results are paced, so right after the scan returns nothing has settled yet.
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-phase", "scanning");
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.chooseTitle })).toBeInTheDocument();
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-phase", "settled");
  });
});
