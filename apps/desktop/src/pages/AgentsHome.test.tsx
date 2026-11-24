import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";

import { createAwaitingConfirmationRun, createMockAgent, createMockAppState, makeMockBridge, renderRoute, renderWithAppState } from "../test/test-utils";
import Agents from "./Agents";

function ScheduleReviewRoute() {
  const { search } = useLocation();
  return <p>{new URLSearchParams(search).get("action") === "schedule" ? "Schedule review opened" : "Agent opened"}</p>;
}

describe("Schedules banners", () => {
  it("shows a destination-review pause as a notice and opens the schedule", async () => {
    const user = userEvent.setup();
    const reason = "contoso-review:latest now runs on ollama.com. Review the schedule to continue.";
    const state = createMockAppState({
      installedAgents: [createMockAgent({
        slug: "compliance-overview",
        schedule: { enabled: true, intervalSeconds: 3600, lastSkipReason: `Skipped: ${reason}` },
      })],
    });

    renderWithAppState(
      <Routes>
        <Route path="/agents" element={<Agents />} />
        <Route path="/agents/compliance-overview" element={<ScheduleReviewRoute />} />
      </Routes>,
      { route: "/agents?filter=scheduled", bridge: makeMockBridge({}, state) },
    );

    const notice = (await screen.findByText(`Schedule paused: ${reason}`)).closest('[role="status"]')!;
    expect(notice).toBeInTheDocument();
    expect(screen.queryByText(/Latest scheduled run failed/)).toBeNull();
    await user.click(within(notice as HTMLElement).getByRole("button", { name: "Review schedule" }));
    expect(await screen.findByText("Schedule review opened")).toBeInTheDocument();
  });

  it("shows the failure alert and runs link for a genuine failure", async () => {
    const state = createMockAppState({
      installedAgents: [createMockAgent({ schedule: { enabled: true, intervalSeconds: 3600 } })],
      schedulerStatus: { supported: false, enabled: false, lastError: "Ollama is unavailable." },
    });

    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?filter=scheduled",
      bridge: makeMockBridge({}, state),
    });

    const alert = (await screen.findByText("Latest scheduled run failed: Ollama is unavailable.")).closest('[role="alert"]')!;
    expect(within(alert as HTMLElement).getByRole("link", { name: "Open runs" })).toHaveAttribute("href", "/runs?filter=failed");
    expect(screen.queryByRole("button", { name: "Review schedule" })).toBeNull();
  });

  it("links a reasoning-only scheduled failure to its run page", async () => {
    const run = createAwaitingConfirmationRun({
      id: "scheduled-reasoning", status: "failed", trigger: "schedule", providerId: "ollama",
      error: 'Ollama returned only reasoning from "llama3.1" and no answer.',
    });
    const state = createMockAppState({
      runs: [run],
      schedulerStatus: { supported: false, enabled: false, lastWakeAt: run.queuedAt, lastError: run.error! },
    });
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?filter=scheduled",
      bridge: makeMockBridge({}, state),
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Latest scheduled run failed: Model reasoned without answering.");
    expect(within(alert).getByRole("link", { name: "Open run" })).toHaveAttribute("href", "/runs/scheduled-reasoning");
    expect(within(alert).queryByRole("button")).toBeNull();
  });
});
