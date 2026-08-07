import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Schedules from "./Schedules";
import {
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";

describe("scheduled batch contextual setup", () => {
  it("resumes a due batch only after the final explicit setup action", async () => {
    const user = userEvent.setup();
    const scheduledAgent = createMockAgent({
      schedule: {
        enabled: true,
        intervalSeconds: 900,
        lastScheduledRunAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const emptyState = createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      installedAgents: [scheduledAgent],
    });
    const connectedState = createMockAppState({ installedAgents: [scheduledAgent] });
    const bridge = makeMockBridge(
      { connectTenant: vi.fn(async () => connectedState) },
      emptyState,
    );

    renderRoute(<Schedules />, {
      path: "/agents/schedules",
      route: "/agents/schedules",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "Run due (1)" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );
    expect(
      await screen.findByRole("button", { name: "Run due schedules" }),
    ).toBeInTheDocument();
    expect(bridge.startRun).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Run due schedules" }));
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledOnce());
  });
});
