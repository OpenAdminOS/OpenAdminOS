import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import Settings from "./Settings";
import {
  createMockAppState,
  makeMockBridge,
  mockProviders,
  renderRoute,
} from "../test/test-utils";

function provider(id: string) {
  const match = mockProviders.find((entry) => entry.id === id);
  if (!match) throw new Error(`Missing provider fixture: ${id}`);
  return match;
}

describe("Settings provider section", () => {
  it("renders implemented and coming-soon providers and sets the active provider", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge(
      {},
      createMockAppState({
        activeProviderId: "ollama",
        providers: [
          provider("ollama"),
          provider("lm-studio"),
          provider("openai"),
          provider("anthropic"),
          provider("azure-openai"),
        ],
      }),
    );

    renderRoute(<Settings />, {
      path: "/settings",
      route: "/settings",
      bridge,
    });

    expect(await screen.findByRole("heading", { name: "LLM Providers" })).toBeInTheDocument();
    expect(screen.getByText("Ollama")).toBeInTheDocument();
    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getAllByText("Connected")).toHaveLength(2);
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getAllByText("Not installed")).toHaveLength(2);
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    expect(screen.getByText("Hosted via local CLI")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Set active" }));

    await waitFor(() => {
      expect(bridge.setActiveProvider).toHaveBeenCalledWith("openai");
    });
  });
});
