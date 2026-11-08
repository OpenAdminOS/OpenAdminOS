import { screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import MenuBarCompanion from "./MenuBarCompanion";
import { makeMockBridge, renderRoute } from "../test/test-utils";

it("labels a planned result in companion activity without treating it as failed or pending", async () => {
  const bridge = makeMockBridge();
  const snapshot = await bridge.getCompanionSnapshot();
  snapshot.recentActivity = [{ id: "dry", label: "Dry run test", status: "planned", route: "/runs/dry", queuedAt: "2026-10-31T12:00:00Z" }];
  bridge.getCompanionSnapshot = vi.fn(async () => snapshot);
  renderRoute(<MenuBarCompanion />, { path: "/companion", route: "/companion", bridge });
  expect(await screen.findByText("Dry run: not applied")).toBeInTheDocument();
  expect(screen.queryByText("Awaiting confirmation")).not.toBeInTheDocument();
});

it("reports other organizations' schedules as waiting, not as failures, after Run due", async () => {
  const user = (await import("@testing-library/user-event")).default.setup();
  const bridge = makeMockBridge();
  const snapshot = await bridge.getCompanionSnapshot();
  snapshot.upcomingSchedules = [{ agentSlug: "a", agentName: "A", mode: "read", nextRunAt: "2026-01-01T00:00:00Z", intervalSeconds: 3600, route: "/agents/a" }];
  bridge.getCompanionSnapshot = vi.fn(async () => snapshot);
  bridge.runDueReadSchedules = vi.fn(async () => ({ queued: 1, skippedWrite: 0, skippedInFlight: 0, skippedNotDue: 0, waitingOtherOrganization: 2, errors: [] }));
  const openMainWindow = vi.fn(async () => undefined);
  bridge.openMainWindow = openMainWindow as never;
  renderRoute(<MenuBarCompanion />, { path: "/companion", route: "/companion", bridge });
  await user.click(await screen.findByRole("button", { name: /Run due \(1\)/ }));
  expect(await screen.findByText("1 read schedule queued. 2 wait for another organization or an assignment.")).toBeInTheDocument();
  expect(openMainWindow).not.toHaveBeenCalled();
});
