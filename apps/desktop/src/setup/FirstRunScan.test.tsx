import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";

import { MODEL_SCAN_COPY } from "../copy";
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
    finish: () => finish?.(),
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

const reducedMotion = () => {
  beforeEach(() => document.documentElement.setAttribute("data-reduced-motion", ""));
  afterEach(() => document.documentElement.removeAttribute("data-reduced-motion"));
};

describe("first-launch model scan screen", () => {
  reducedMotion();

  it("shows before anything else on a fresh install, with every check running and the target it touches", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);

    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title })).toBeInTheDocument();
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { busy: true });
    expect(await within(list).findByText("localhost:11434")).toBeInTheDocument();
    expect(within(list).getByText("claude --version, claude auth status")).toBeInTheDocument();
    expect(screen.getByText("0 of 4 checked")).toBeInTheDocument();

    finish();
    expect(await screen.findByRole("heading", { level: 1, name: "Claude Code is signed in on this device" })).toBeInTheDocument();
    expect(screen.getByText("What ran: localhost:11434; localhost:1234; claude --version, claude auth status; copilot --version. The Claude Code and Codex sign-in status commands may check with their provider. No prompt was sent to any model.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Scan finished\./));
  });

  it("shows the settled state with no motion under reduced motion", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    const { container } = renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-motion", "reduced");
    finish();
    await screen.findByRole("heading", { level: 1, name: "Claude Code is signed in on this device" });
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-phase", "settled");
    // The stage is decorative; the list is the accessible source.
    expect(container.querySelector(".scan-stage")).toHaveAttribute("aria-hidden", "true");
  });

  it("leads with a signed-in hosted tool and its residency line, and selects it only on one click", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    await screen.findByRole("heading", { level: 1, name: "Claude Code is signed in on this device" });
    expect(screen.getByText("Prompts go to Anthropic API · US")).toBeInTheDocument();
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
    // A local runtime that is installed but stopped is the secondary choice.
    expect(screen.getByText("To keep everything on this device, start Ollama.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use Claude Code" }));
    await waitFor(() => expect(bridge.setActiveProvider).toHaveBeenCalledWith("anthropic"));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/chat");
  });

  it("names a ready local model large and says nothing leaves the device", async () => {
    const user = userEvent.setup();
    const local = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 2 models", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true })];
    const { bridge, finish } = scanBridge({ kind: "local-selected", providerId: "ollama", model: "openadminos/openadmin-8b:latest" }, local);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    expect(await screen.findByRole("heading", { name: "OpenAdmin 8B is ready on this device" })).toBeInTheDocument();
    expect(screen.getByText(MODEL_SCAN_COPY.nothingLeaves)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.openChat }));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
  });

  it("starts an installed Ollama for the admin and leads with it once it answers", async () => {
    const user = userEvent.setup();
    const stopped = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped);
    const running = probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 1 model", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true });
    vi.mocked(bridge.startLocalRuntime!).mockResolvedValue({
      started: true,
      scan: { probes: [running], outcome: { kind: "local-selected", providerId: "ollama", model: "openadminos/openadmin-8b:latest" }, startedAt: "", finishedAt: "later" },
    });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    expect(await screen.findByRole("heading", { level: 1, name: "Ollama is installed on this device" })).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Start Ollama" })[0]!);
    await waitFor(() => expect(bridge.startLocalRuntime).toHaveBeenCalledWith("ollama"));
    expect(await screen.findByRole("heading", { level: 1, name: "OpenAdmin 8B is ready on this device" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Ollama started."));
  });

  it("shows a designed failure when the runtime does not start, naming the command to run", async () => {
    const user = userEvent.setup();
    const stopped = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped);
    vi.mocked(bridge.startLocalRuntime!).mockResolvedValue({
      started: false,
      message: "Ollama did not answer within 12 seconds. Start it yourself with `ollama serve`, then scan again.",
      scan: { probes: stopped, outcome: { kind: "nothing" }, startedAt: "", finishedAt: "later" },
    });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    await user.click((await screen.findAllByRole("button", { name: "Start Ollama" }))[0]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("Ollama did not answer within 12 seconds. Start it yourself with ollama serve, then scan again.");
    expect(screen.getAllByRole("button", { name: "Start Ollama" }).length).toBeGreaterThan(0);
  });

  it("offers OpenAdmin 8B, all providers and sample data when nothing is found", async () => {
    const user = userEvent.setup();
    const none = [probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, none);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    expect(await screen.findByRole("heading", { name: MODEL_SCAN_COPY.nothingTitle })).toBeInTheDocument();
    expect(screen.getByText(MODEL_SCAN_COPY.installCommand)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MODEL_SCAN_COPY.setUpOpenAdminAction })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MODEL_SCAN_COPY.allProviders })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.previewLink }));
    await waitFor(() => expect(bridge.addSampleTenant).toHaveBeenCalledOnce());
    expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce();
  });

  it("shows a check that could not finish with Retry, and announces the new result", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    expect(await screen.findByText(/did not answer within 2\.5 seconds/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check GitHub Copilot CLI again" }));
    await waitFor(() => expect(bridge.retryModelScanProbe).toHaveBeenCalledWith("copilot"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("GitHub Copilot CLI: Signed in."), { timeout: 3000 });
  });

  it("leads with a hosted tool a Retry found, when the first scan found no model", async () => {
    const user = userEvent.setup();
    const timedOut = [
      probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false }),
      probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status", { state: "could-not-check", summary: "Could not check", ready: false, facts: ["Claude Code did not answer within 2.5 seconds. Retry to check again."] }),
    ];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, timedOut);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();
    expect(await screen.findByRole("heading", { name: MODEL_SCAN_COPY.nothingTitle })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Check Claude Code again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Claude Code is signed in on this device" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Claude Code" })).toBeInTheDocument();
  });

  it("does not promise local processing while the admin's own hosted choice stays selected", async () => {
    const user = userEvent.setup();
    const both = [
      probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 1 model", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true }),
      probe("anthropic", "Claude Code", "hosted", "claude --version, claude auth status"),
    ];
    const { bridge, finish } = scanBridge({ kind: "local-available", providerId: "ollama", model: "openadminos/openadmin-8b:latest", selectedProviderId: "anthropic" }, both);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    expect(await screen.findByRole("heading", { level: 1, name: "OpenAdmin 8B is ready on this device, not selected" })).toBeInTheDocument();
    expect(screen.getByText("It runs in Ollama. Chat keeps answering with Claude Code, your choice, until you switch.")).toBeInTheDocument();
    expect(screen.queryByText(MODEL_SCAN_COPY.nothingLeaves)).not.toBeInTheDocument();
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

  it("shows a failed Start of the secondary runtime beside its row (round 2, item 8)", async () => {
    const user = userEvent.setup();
    const stopped = [
      probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false }),
      probe("lm-studio", "LM Studio", "local", "localhost:1234", { summary: "Installed, not running", ready: false }),
    ];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped);
    vi.mocked(bridge.startLocalRuntime!).mockResolvedValue({ started: false, message: "LM Studio was not found on this device. Start it yourself with `lms server start`, then scan again." });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();
    expect(await screen.findByRole("heading", { level: 1, name: "Ollama is installed on this device" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start LM Studio" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("LM Studio was not found on this device. Start it yourself with lms server start, then scan again.");
    // A failed start does not rescan or replace the result.
    expect(screen.getByRole("heading", { level: 1, name: "Ollama is installed on this device" })).toBeInTheDocument();
    expect(screen.getAllByText("LM Studio keeps running after you quit OpenAdminOS.").length).toBeGreaterThan(0);
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
    finish();
    await screen.findByRole("heading", { name: MODEL_SCAN_COPY.nothingTitle });
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
    expect(await screen.findByRole("heading", { level: 1, name: "Codex is signed in on this device" })).toBeInTheDocument();
    // A later answer numbered before the one shown never replaces it.
    const again = await screen.findByRole("button", { name: "Check Claude Code again" });
    await waitFor(() => expect(again).toBeEnabled());
    await user.click(again);
    resolvers[1]!(older);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(screen.getByRole("heading", { level: 1, name: "Codex is signed in on this device" })).toBeInTheDocument();
  });

  it("does not claim nothing leaves when a public reference is enabled (round 2, item 9)", async () => {
    const local = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 1 model", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true })];
    const withReference = createMockAppState({ mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true } }) });
    const { bridge, finish } = scanBridge({ kind: "local-ready", providerId: "ollama", model: "openadminos/openadmin-8b:latest" }, local, withReference);
    renderGate(bridge);
    await userEvent.setup().click(await screen.findByRole("button", { name: MODEL_SCAN_COPY.scanAgain }));
    finish();
    await screen.findByRole("heading", { level: 1, name: "OpenAdmin 8B is ready on this device" });
    expect(screen.queryByText(MODEL_SCAN_COPY.nothingLeaves)).not.toBeInTheDocument();
    expect(screen.getByText("Runs on this device. Your references get tool queries to learn.microsoft.com.")).toBeInTheDocument();
  });

  it("can be left before it settles, completing the first run without selecting anything (round 2, item N)", async () => {
    const user = userEvent.setup();
    const { bridge } = scanBridge({ kind: "nothing" });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.continueToChat }));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
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
    finish();
    const ledger = await screen.findByText(/^What ran:/);
    expect(ledger.textContent).toContain("What ran: claude --version, claude auth status.");
    expect(ledger.textContent).toContain("Not contacted, set outside this device: 10.0.0.5:11434.");
  });

  it("renders what the first-run screenshot capture waits for once settled (review round 4, item 4)", async () => {
    // electron/first-run-capture.ts waits for the settled phase and these two exits by their exact labels.
    const { bridge, finish } = scanBridge({ kind: "nothing" });
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();
    await waitFor(() => expect(document.querySelector('[data-phase="settled"]')).not.toBeNull());
    expect(screen.getByRole("button", { name: "Continue to Chat without a model" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview with sample data" })).toBeInTheDocument();
  });

  it("keeps every exit disabled while a Start is polling (Muse round 3, M2)", async () => {
    const user = userEvent.setup();
    const stopped = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, stopped);
    vi.mocked(bridge.startLocalRuntime!).mockReturnValue(new Promise(() => undefined));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();
    await user.click((await screen.findAllByRole("button", { name: "Start Ollama" }))[0]!);
    await waitFor(() => expect(bridge.startLocalRuntime).toHaveBeenCalledOnce());
    // Every exit, "Show all providers" included (review round 4, item 3).
    for (const name of [MODEL_SCAN_COPY.continueWithoutModel, MODEL_SCAN_COPY.previewLink, MODEL_SCAN_COPY.allProviders]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.continueWithoutModel }));
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.allProviders }));
    expect(bridge.completeFirstRunScan).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { level: 1, name: "Ollama is installed on this device" })).toBeInTheDocument();
  });

  it("locks every exit and action while a Retry runs, and Retry while a Start runs (Muse round 4, A)", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    vi.mocked(bridge.retryModelScanProbe!).mockReturnValue(new Promise(() => undefined));
    vi.mocked(bridge.startLocalRuntime!).mockReturnValue(new Promise(() => undefined));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();
    await user.click(await screen.findByRole("button", { name: MODEL_SCAN_COPY.retryLabel("GitHub Copilot CLI") }));
    await waitFor(() => expect(bridge.retryModelScanProbe).toHaveBeenCalledOnce());
    for (const name of [MODEL_SCAN_COPY.continueWithoutModel, MODEL_SCAN_COPY.previewLink, "Use Claude Code"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    for (const button of screen.getAllByRole("button", { name: "Start Ollama" })) expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.continueWithoutModel }));
    expect(bridge.completeFirstRunScan).not.toHaveBeenCalled();
    expect(bridge.startLocalRuntime).not.toHaveBeenCalled();
  });

  it("locks the row Retry while a Start runs (Muse round 4, A)", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "nothing" });
    vi.mocked(bridge.startLocalRuntime!).mockReturnValue(new Promise(() => undefined));
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();
    await user.click((await screen.findAllByRole("button", { name: "Start Ollama" }))[0]!);
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
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce();
  });

  it("focuses the heading on open and on settle (round 2, item L)", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);
    const heading = await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    await waitFor(() => expect(heading).toHaveFocus());
    finish();
    const settled = await screen.findByRole("heading", { level: 1, name: "Claude Code is signed in on this device" });
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
    finish();
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
    finish();
    // Results are paced, so right after the scan returns nothing has settled yet.
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-phase", "scanning");
    await userEvent.keyboard("{Escape}");
    expect(await screen.findByRole("heading", { level: 1, name: "Claude Code is signed in on this device" })).toBeInTheDocument();
    expect(container.querySelector(".scan-screen")).toHaveAttribute("data-phase", "settled");
  });
});
