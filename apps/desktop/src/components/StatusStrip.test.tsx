import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusStrip } from "./StatusStrip";
import {
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  renderWithAppState,
} from "../test/test-utils";

describe("StatusStrip external proposals", () => {
  it("links to a pending external proposal from the persistent status surface", async () => {
    const run = createAwaitingConfirmationRun({
      id: "run-external-1",
      agentSlug: "external-proposal",
      origin: "external-proposal",
      external: {
        clientName: "Claude Code",
        requiredScopes: ["Policy.ReadWrite.ConditionalAccess"],
      },
    });
    const bridge = makeMockBridge(
      {},
      createMockAppState({ installedAgents: [], runs: [run] }),
    );

    renderWithAppState(<StatusStrip />, { bridge });

    expect(
      await screen.findByRole("link", { name: "1 external proposal" }),
    ).toHaveAttribute("href", "/runs/run-external-1");
  });
});
