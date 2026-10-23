import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";
import { DataBoundaryProvider, useDataBoundary } from "../state";
import { AppShell } from "./AppShell";

describe("shell chrome", () => {
  it("keeps tenant, model boundary, and running work visible without a status strip", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(
        {},
        createMockAppState({
          runs: [
            createAwaitingConfirmationRun({
              id: "run-active",
              status: "running",
              origin: undefined,
              external: undefined,
            }),
          ],
        }),
      ),
    });

    expect(await screen.findByRole("button", { name: /Switch tenant, Contoso IT/ })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /Local · Ollama.*llama3.1/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 run in progress" })).toHaveAttribute("href", "/runs");
    expect(screen.queryByRole("contentinfo", { name: /Current tenant/ })).not.toBeInTheDocument();
  });

  it("shows an honest hosted destination and the nightly brand tag", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(
        {},
        createMockAppState({
          activeProviderId: "openai",
          appVersion: "0.7.1-nightly.20261023141500",
        }),
      ),
    });

    expect(
      await screen.findByRole("status", { name: /Hosted · OpenAI.*gpt-5/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nightly")).toBeInTheDocument();
  });

  it("keeps updater errors and recovery in the sidebar", async () => {
    const user = userEvent.setup();
    const checkForUpdatesNow = vi.fn(async () => ({ status: "checking" as const }));
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({
        getUpdateState: vi.fn(async () => ({
          status: "error" as const,
          message: "Update check failed. Network unavailable.",
        })),
        checkForUpdatesNow,
      }),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(checkForUpdatesNow).toHaveBeenCalledTimes(1);
  });

  it("lets an active hosted voice session override a local provider boundary", async () => {
    const user = userEvent.setup();
    renderRoute(
      <DataBoundaryProvider>
        <BoundaryProbe />
      </DataBoundaryProvider>,
      { path: "*", route: "/chat", bridge: makeMockBridge() },
    );

    expect(screen.getByTestId("boundary-kind")).toHaveTextContent("local:Local · Ollama");
    await user.click(screen.getByRole("button", { name: "Start hosted voice" }));
    expect(screen.getByTestId("boundary-kind")).toHaveTextContent(
      "hosted:Voice · OpenAI",
    );
  });
});

function BoundaryProbe() {
  const { boundary, setVoiceHosted } = useDataBoundary();
  return (
    <>
      <div data-testid="boundary-kind">{boundary.kind}:{boundary.label}</div>
      <button type="button" onClick={() => setVoiceHosted(true)}>
        Start hosted voice
      </button>
    </>
  );
}
