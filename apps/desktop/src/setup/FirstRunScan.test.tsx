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
      retryModelScanProbe: vi.fn(async (id: ProviderId) => ({ ...probes.find((entry) => entry.providerId === id)!, state: "found" as const, summary: "Signed in", ready: true, facts: [] })),
      completeFirstRunScan: vi.fn(async () => ({ ...state, firstRunScanPending: undefined })),
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

describe("first-launch model scan screen", () => {
  // Reduced motion shows every result as soon as it arrives, with the same text.
  beforeEach(() => document.documentElement.setAttribute("data-reduced-motion", ""));
  afterEach(() => document.documentElement.removeAttribute("data-reduced-motion"));

  it("shows before anything else on a fresh install, with every check running and the target it touches", async () => {
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);

    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.title })).toBeInTheDocument();
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
    expect(await screen.findByText("localhost:11434")).toBeInTheDocument();
    expect(screen.getByText("claude auth status")).toBeInTheDocument();
    expect(screen.getByText("0 of 4 checked")).toBeInTheDocument();
    expect(screen.getByRole("list", { busy: true })).toBeInTheDocument();
    expect(bridge.startModelScan).toHaveBeenCalledOnce();

    finish();
    expect(await screen.findByRole("heading", { level: 1, name: MODEL_SCAN_COPY.titleDone })).toBeInTheDocument();
    expect(screen.getByText("4 of 4 checked")).toBeInTheDocument();
    expect(screen.getByText(/Checked here: localhost:11434, localhost:1234, claude auth status, copilot sign-in status\. Nothing was sent to a model or a provider\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Scan finished\./));
  });

  it("offers a signed-in hosted tool with its residency line and selects it only on one click", async () => {
    const user = userEvent.setup();
    const { bridge, finish } = scanBridge({ kind: "hosted-detected", providerIds: ["anthropic"] });
    renderGate(bridge);
    await screen.findByText("localhost:11434");
    finish();

    const outcome = await screen.findByRole("region", { name: MODEL_SCAN_COPY.hostedTitle });
    expect(within(outcome).getByText("Prompts go to Anthropic API · US")).toBeInTheDocument();
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
    await user.click(within(outcome).getByRole("button", { name: "Use Claude Code" }));
    await waitFor(() => expect(bridge.setActiveProvider).toHaveBeenCalledWith("anthropic"));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/chat");
  });

  it("says a ready local model was selected and that nothing leaves the device", async () => {
    const user = userEvent.setup();
    const local = [probe("ollama", "Ollama", "local", "localhost:11434", { summary: "Running, 2 models", models: ["openadminos/openadmin-8b:latest"], hasOpenAdmin8B: true })];
    const { bridge, finish } = scanBridge({ kind: "local-selected", providerId: "ollama", model: "openadminos/openadmin-8b:latest" }, local);
    renderGate(bridge);
    await screen.findByText("localhost:11434");
    finish();

    expect(await screen.findByRole("heading", { name: "OpenAdmin 8B is ready on this device" })).toBeInTheDocument();
    expect(screen.getByText(MODEL_SCAN_COPY.nothingLeaves)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: MODEL_SCAN_COPY.openChat }));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce());
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();
  });

  it("offers OpenAdmin 8B, all providers and sample data when nothing is found", async () => {
    const user = userEvent.setup();
    const none = [probe("lm-studio", "LM Studio", "local", "localhost:1234", { state: "not-found", summary: "Not installed", ready: false })];
    const { bridge, finish } = scanBridge({ kind: "nothing" }, none);
    renderGate(bridge);
    await screen.findByText("localhost:1234");
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
    await screen.findByText("localhost:11434");
    finish();

    expect(await screen.findByText(/did not answer within 2\.5 seconds/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Check GitHub Copilot CLI again" }));
    await waitFor(() => expect(bridge.retryModelScanProbe).toHaveBeenCalledWith("copilot"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("GitHub Copilot CLI: Signed in."));
    expect(screen.queryByText(/did not answer within/)).not.toBeInTheDocument();
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
    // Opened from Settings, the scan does not record a first run.
    expect(bridge.completeFirstRunScan).not.toHaveBeenCalled();
  });
});
