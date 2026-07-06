import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import Home from "./Home";
import {
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";

describe("Home first-run checklist", () => {
  it("renders the checklist before the first successful result", async () => {
    const listIntuneChatConversations = vi.fn(async () => []);
    const bridge = makeMockBridge(
      {
        listIntuneChatConversations,
      },
      createMockAppState({
        installedAgents: [],
        runs: [],
      }),
    );

    renderRoute(<Home />, {
      path: "/",
      route: "/",
      bridge,
    });

    expect(
      await screen.findByRole("heading", { name: "Start with one result" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Tenant connected")).toBeInTheDocument();
    expect(screen.getByText("Local model active")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Ask about devices, users, policies, or sign-ins"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Runs this week")).not.toBeInTheDocument();
    expect(screen.queryByText("Recent runs")).not.toBeInTheDocument();
    expect(screen.queryByText("Try a write agent")).not.toBeInTheDocument();
    expect(listIntuneChatConversations).toHaveBeenCalledTimes(1);
  });

  it("renders the dashboard when a completed run exists", async () => {
    const listIntuneChatConversations = vi.fn(async () => []);
    const bridge = makeMockBridge(
      {
        listIntuneChatConversations,
      },
      createMockAppState({
        runs: [
          createAwaitingConfirmationRun({
            id: "run-completed-1",
            agentSlug: "compliance-overview",
            status: "completed",
            summary: "Compliance overview completed.",
            finishedAt: "2026-07-05T10:04:00.000Z",
            plan: undefined,
          }),
        ],
      }),
    );

    renderRoute(<Home />, {
      path: "/",
      route: "/",
      bridge,
    });

    expect(await screen.findByText("Runs this week")).toBeInTheDocument();
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByText("Try a write agent")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Start with one result" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(listIntuneChatConversations).not.toHaveBeenCalled();
    });
  });
});
