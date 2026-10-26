import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Agents from "./Agents";
import Schedules from "./Schedules";
import {
  createMockAgent,
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";

describe("Agents schedule actions", () => {
  it("shows compact forecasts for active schedules and previews a new interval before enabling", async () => {
    const user = userEvent.setup();
    const scheduled = createMockAgent({ schedule: { enabled: true, intervalSeconds: 86400 } });
    const manual = createMockAgent({ id: "manual", slug: "manual", name: "Manual report", schedule: undefined });
    const state = createMockAppState({ installedAgents: [scheduled, manual] });
    const bridge = makeMockBridge({}, state);
    renderRoute(<Schedules />, { path: "/schedules", route: "/schedules", bridge });
    expect(await screen.findByText(/About 30 runs per 30 days/)).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Interval for Manual report" }), "900");
    expect(screen.getByText(/About 2,880 runs per 30 days/)).toBeInTheDocument();
    expect(bridge.updateAgentSchedule).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enable schedule" }));
    await waitFor(() => expect(bridge.updateAgentSchedule).toHaveBeenCalledWith("manual", expect.objectContaining({ intervalSeconds: 900, enabled: true })));
  });

  it("shows the forecast in the current Agents schedules list", async () => {
    const agent = createMockAgent({ schedule: { enabled: true, intervalSeconds: 86400 } });
    const state = createMockAppState({ installedAgents: [agent] });
    renderRoute(<Agents />, { path: "/agents", route: "/agents?filter=scheduled", bridge: makeMockBridge({}, state) });
    expect(await screen.findByText(/About 30 runs per 30 days/)).toBeInTheDocument();
  });

  it("shows why schedules are paused and switches to the most recently used real tenant", async () => {
    const user = userEvent.setup();
    const scheduledAgent = createMockAgent({
      schedule: {
        enabled: true,
        intervalSeconds: 900,
        lastScheduledRunAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const realTenant = {
      id: "real-tenant",
      displayName: "Contoso Production",
      username: "admin@contoso.invalid",
      homeAccountId: "real-account",
      addedAt: "2026-10-20T12:00:00.000Z",
      lastUsedAt: "2026-10-25T12:00:00.000Z",
    };
    const sampleTenant = {
      id: "openadminos-sample-tenant",
      kind: "sample" as const,
      displayName: "Contoso (sample data)",
      username: "admin@contoso-sample.invalid",
      homeAccountId: "openadminos-sample-account",
      addedAt: "2026-10-26T12:00:00.000Z",
      lastUsedAt: "2026-10-26T12:00:00.000Z",
    };
    const state = createMockAppState({
      tenants: [realTenant, sampleTenant],
      activeTenantId: sampleTenant.id,
      installedAgents: [scheduledAgent],
    });
    const bridge = makeMockBridge({}, state);

    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?filter=scheduled",
      bridge,
    });

    expect(
      await screen.findByText(
        "Schedules are paused while the sample tenant is active. Switch to a connected tenant to resume.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Schedule actions" }));
    expect(screen.getByRole("menuitem", { name: "Run due now (1)" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Switch to Contoso Production" }));
    await waitFor(() => expect(bridge.setActiveTenant).toHaveBeenCalledWith(realTenant.id));
  });

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

    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?filter=scheduled",
      bridge,
    });

    await user.click(await screen.findByRole("button", { name: "Schedule actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Run due now (1)" }));
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

  it("uses query-addressable Installed, Browse, and Schedules tabs", async () => {
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?source=hub&filter=scheduled",
      bridge: makeMockBridge(),
    });

    expect(await screen.findByRole("tab", { name: "Browse" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByPlaceholderText("Search hub…")).toBeInTheDocument();
    expect(screen.getByText("Scheduled only")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Schedules" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Team" })).not.toBeInTheDocument();
  });

  it("opens the URL-addressable agent drawer and targets its schedule section", async () => {
    const scrollTo = vi.fn();
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });

    try {
      renderRoute(<Agents />, {
        path: "/agents/:slug",
        route: "/agents/device-offboard?action=schedule",
        bridge: makeMockBridge(),
      });

      expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
      const drawer = await screen.findByRole("dialog", { name: "Device Offboard" });
      expect(within(drawer).getByRole("heading", { name: "Schedule" })).toBeInTheDocument();
      await waitFor(() => expect(scrollTo).toHaveBeenCalled());
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        configurable: true,
        value: originalScrollTo,
      });
    }
  });

  it("keeps the confirmation route on Agents and starts the existing preflight", async () => {
    renderRoute(<Agents startRunOnOpen />, {
      path: "/agents/:slug/confirm",
      route: "/agents/device-offboard/confirm",
      bridge: makeMockBridge(),
    });

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Review run" })).toBeInTheDocument();
    expect(screen.getAllByText("Device Offboard").length).toBeGreaterThan(0);
  });

});


it("offers Dry run for write agents through the normal preflight", async () => {
  const user = userEvent.setup();
  const bridge = makeMockBridge();
  renderRoute(<Agents />, { path: "/agents/:slug", route: "/agents/device-offboard", bridge });
  await user.click(await screen.findByRole("button", { name: "Dry run" }));
  await user.click(await screen.findByRole("button", { name: "Start dry run" }));
  await waitFor(() => expect(bridge.startRun).toHaveBeenCalledWith("device-offboard", { dryRun: true }));
});

it("renders a retained planned outcome without implying pending schedule approval", async () => {
  const agent = createMockAgent({ schedule: { enabled: true, intervalSeconds: 900 } });
  const run = createAwaitingConfirmationRun({ status: "planned", dryRun: true, trigger: "schedule" });
  renderRoute(<Schedules />, { path: "/schedules", route: "/schedules", bridge: makeMockBridge({}, createMockAppState({ installedAgents: [agent], runs: [run] })) });
  expect((await screen.findAllByText("Dry run: not applied")).length).toBeGreaterThan(0);
  expect(screen.queryByText("Needs confirmation")).not.toBeInTheDocument();
});
