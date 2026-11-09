import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";

import { MODEL_SCAN_COPY } from "../copy";
import type { ModelScanOutcome, ModelScanProbe, ModelScanResult, ProviderId } from "../shared/openAdminOS";
import { createMockAppState, makeMockBridge, renderWithAppState } from "../test/test-utils";
import { ModelScanGate, ScanAgainButton } from "./FirstRunScan";

const probe = (providerId: ProviderId, name: string, where: "local" | "hosted", target: string, rest: Partial<ModelScanProbe> = {}): ModelScanProbe => ({
  providerId, name, where, target, state: "found", summary: "Signed in", facts: [], ready: true, models: [], ...rest,
});
const PROBES: ModelScanProbe[] = [
  probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Installed, not running", ready: false, facts: ["Start it with `ollama serve`, then scan again."] }),
  probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false }),
  probe("anthropic", "Claude Code", "hosted", "claude auth status", { facts: ["Version 2.1.0"] }),
  probe("copilot", "GitHub Copilot CLI", "hosted", "copilot sign-in status", { state: "could-not-check", summary: "Could not check", ready: false, facts: ["GitHub Copilot CLI did not answer within 2.5 seconds. Retry to check again."] }),
];

function scanBridge(outcome: ModelScanOutcome, probes: ModelScanProbe[] = PROBES, state = createMockAppState({ tenants: [], activeTenantId: undefined, firstRunScanPending: true })) {
  let listener: ((probe: ModelScanProbe) => void) | undefined;
  let finish: (() => void) | undefined;
  const result: ModelScanResult = { probes, outcome, startedAt: "2026-11-09T09:00:00.000Z", finishedAt: "2026-11-09T09:00:00.120Z" };
  const bridge = makeMockBridge(
    {
      onModelScanProgress: vi.fn((next: (probe: ModelScanProbe) => void) => {
        listener = next;
        return () => { listener = undefined; };
      }),
      startModelScan: vi.fn(() => new Promise<ModelScanResult>((resolve) => {
        for (const entry of probes) listener?.({ ...entry, state: "checking", summary: "Checking", facts: [] });
        finish = () => {
          for (const entry of probes) listener?.(entry);
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
    },
    state,
  );
  return { bridge, finish: () => finish?.() };
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
    expect(within(list).getByText("claude auth status")).toBeInTheDocument();
    expect(screen.getByText("0 of 4 checked")).toBeInTheDocument();

    finish();
    expect(await screen.findByRole("heading", { level: 1, name: "Claude Code is signed in on this device" })).toBeInTheDocument();
    expect(screen.getByText(/Checked here: localhost:11434, localhost:1234, claude auth status, copilot sign-in status\. Nothing was sent to a model or a provider\./)).toBeInTheDocument();
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
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("GitHub Copilot CLI: Signed in."));
  });

  it("leads with a hosted tool a Retry found, when the first scan found no model", async () => {
    const user = userEvent.setup();
    const timedOut = [
      probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false }),
      probe("anthropic", "Claude Code", "hosted", "claude auth status", { state: "could-not-check", summary: "Could not check", ready: false, facts: ["Claude Code did not answer within 2.5 seconds. Retry to check again."] }),
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
      probe("anthropic", "Claude Code", "hosted", "claude auth status"),
    ];
    const { bridge, finish } = scanBridge({ kind: "local-available", providerId: "ollama", model: "openadminos/openadmin-8b:latest", selectedProviderId: "anthropic" }, both);
    renderGate(bridge);
    await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title });
    finish();

    expect(await screen.findByRole("heading", { level: 1, name: "OpenAdmin 8B is ready on this device, not selected" })).toBeInTheDocument();
    expect(screen.getByText("It runs in Ollama. Chat keeps answering with Claude Code, your choice, until you switch.")).toBeInTheDocument();
    expect(screen.queryByText(MODEL_SCAN_COPY.nothingLeaves)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Use OpenAdmin 8B" }));
    await waitFor(() => expect(bridge.setActiveProvider).toHaveBeenCalledWith("ollama"));
    await waitFor(() => expect(bridge.setActiveModel).toHaveBeenCalledWith("ollama", "openadminos/openadmin-8b:latest"));
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
