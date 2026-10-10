import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusStrip } from "./StatusStrip";
import {
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  renderWithAppState,
} from "../test/test-utils";

describe("StatusStrip", () => {
  it("renders the three compact cells and links a running count to Runs", async () => {
    const bridge = makeMockBridge(
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
    );
    renderWithAppState(<StatusStrip />, { bridge });

    const strip = screen.getByRole("contentinfo", {
      name: "Current tenant, provider, and data boundary",
    });
    expect(strip).toHaveClass("h-7", "whitespace-nowrap", "overflow-hidden");
    expect(await screen.findByText("Contoso IT")).toBeInTheDocument();
    expect(screen.getByLabelText(/Ollama.*llama3.1.*local-only/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 running" })).toHaveAttribute(
      "href",
      "/runs",
    );
    expect(screen.queryByText(/external proposal/)).not.toBeInTheDocument();
  });

  it("hides the running cell at zero and derives the hosted destination", async () => {
    const bridge = makeMockBridge(
      {},
      createMockAppState({ activeProviderId: "openai" }),
    );
    renderWithAppState(<StatusStrip />, { bridge });

    expect(screen.queryByRole("link", { name: /running/ })).not.toBeInTheDocument();
    expect(
      await screen.findByLabelText(/hosted.*tenant context sent to OpenAI/),
    ).toBeInTheDocument();
  });

  it("states that hosted Nova voice sends audio to OpenAI", async () => {
    renderWithAppState(<StatusStrip voiceHosted />, {
      bridge: makeMockBridge({}, createMockAppState()),
    });

    expect(
      await screen.findByLabelText(/Nova voice.*audio and shared context sent to OpenAI/),
    ).toBeInTheDocument();
  });
});
