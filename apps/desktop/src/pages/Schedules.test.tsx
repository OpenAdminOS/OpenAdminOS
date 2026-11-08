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

  it("shows why schedules are paused and switches to the most recently used organization", async () => {
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
      displayName: "Contoso (pilot)",
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
      route: "/agents",
      bridge,
    });

    expect(
      await screen.findByText(
        "Schedules are paused while the sample organization is active. Switch to one of your organizations to resume.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to Contoso Production" }));
    await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith(`org-${realTenant.id}`));
  });

  it("says schedules are paused while no organization is active", async () => {
    const user = userEvent.setup();
    const scheduledAgent = createMockAgent({
      schedule: { enabled: true, intervalSeconds: 900 },
    });
    const realTenant = {
      id: "real-tenant",
      displayName: "Contoso Production",
      username: "admin@contoso.invalid",
      homeAccountId: "real-account",
      addedAt: "2026-10-20T12:00:00.000Z",
    };
    const state = createMockAppState({
      tenants: [realTenant],
      activeTenantId: undefined,
      installedAgents: [scheduledAgent],
    });
    const bridge = makeMockBridge({}, state);
    renderRoute(<Schedules />, { path: "/schedules", route: "/schedules", bridge });

    expect(
      await screen.findByText(
        "Schedules are paused while no organization is active. Choose an organization to resume its schedules.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Switch to Contoso Production" }));
    await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith(`org-${realTenant.id}`));
  });

  it("shows the production page for the Schedules tab in pilot mode", async () => {
    const state = createMockAppState({
      tenants: [{
        id: "openadminos-sample-tenant",
        kind: "sample" as const,
        displayName: "Contoso (pilot)",
        username: "admin@contoso-sample.invalid",
        homeAccountId: "openadminos-sample-account",
        addedAt: "2026-10-26T12:00:00.000Z",
      }],
      activeTenantId: "openadminos-sample-tenant",
    });
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?filter=scheduled",
      bridge: makeMockBridge({}, state),
    });
    expect(
      await screen.findByText("Schedules are available in production. Connect your tenant to use them."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Schedules" })).not.toBeInTheDocument();
  });

  it("runs due schedules of the active organization only and waits on the others", async () => {
    const user = userEvent.setup();
    const due = { enabled: true, intervalSeconds: 900, lastScheduledRunAt: "2026-01-01T00:00:00.000Z" };
    const mine = createMockAgent({ id: "mine", slug: "mine", name: "Mine", schedule: { ...due, organizationId: "org-tenant-1" } });
    const other = createMockAgent({ id: "other", slug: "other", name: "Other", schedule: { ...due, organizationId: "org-tenant-2" } });
    const loose = createMockAgent({ id: "loose", slug: "loose", name: "Loose", schedule: due });
    const second = { ...createMockAppState().tenants[0]!, id: "tenant-2", displayName: "Fabrikam" };
    const state = createMockAppState({
      tenants: [createMockAppState().tenants[0]!, second],
      installedAgents: [mine, other, loose],
    });
    const bridge = makeMockBridge({}, state);
    renderRoute(<Agents />, { path: "/agents", route: "/agents?filter=scheduled", bridge });

    expect(
      await screen.findByText(
        "1 schedule is unassigned and paused. Assign it to an organization on the agent page. 1 schedule belongs to another organization and runs only while that organization is active.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Every 15m · in Contoso IT/)).toBeInTheDocument();
    expect(screen.getByText(/Every 15m · in Fabrikam/)).toBeInTheDocument();
    expect(screen.getByText(/Every 15m · Unassigned, paused/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Schedule actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Run due now (1)" }));
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledOnce());
    expect(vi.mocked(bridge.startRun).mock.calls[0]?.[0]).toBe("mine");
  });

  it("says where schedules went when they moved to organizations, until dismissed", async () => {
    const user = userEvent.setup();
    const agent = createMockAgent({ schedule: { enabled: true, intervalSeconds: 900, organizationId: "org-tenant-1" } });
    const state = createMockAppState({
      installedAgents: [agent],
      organizationMigration: { assignedCount: 2, assignedOrganizationId: "org-tenant-1", unassignedCount: 0 },
    });
    const bridge = makeMockBridge({}, state);
    renderRoute(<Schedules />, { path: "/schedules", route: "/schedules", bridge });
    expect(
      await screen.findByText(
        "Schedules now belong to organizations. 2 schedules moved to Contoso IT and run only while it is active.",
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(bridge.dismissOrganizationMigrationNotice).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText(/Schedules now belong to organizations/)).not.toBeInTheDocument());
  });

  it("says why schedules stayed unassigned and assigns one from its card", async () => {
    const user = userEvent.setup();
    const agent = createMockAgent({ id: "loose", slug: "loose", name: "Loose", schedule: { enabled: true, intervalSeconds: 900 } });
    const state = createMockAppState({
      installedAgents: [agent],
      organizationMigration: { assignedCount: 0, unassignedCount: 1, unassignedReason: "pilot-active" },
    });
    const bridge = makeMockBridge({}, state);
    renderRoute(<Agents />, { path: "/agents/:slug", route: "/agents/loose?action=schedule", bridge });
    expect(
      (await screen.findAllByText(
        "Schedules now belong to organizations. 1 schedule stays paused and unassigned because the sample organization was active. Assign each one on its agent page.",
      )).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText("Unassigned. This schedule is paused until you assign it to an organization.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() => expect(bridge.assignAgentSchedule).toHaveBeenCalledWith("loose", "org-tenant-1"));
    expect(await screen.findByText(/Contoso IT\. Runs only while Contoso IT is active\./)).toBeInTheDocument();
  });

  it("uses query-addressable Installed and Schedules tabs for installed agents only", async () => {
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?filter=scheduled",
      bridge: makeMockBridge(),
    });

    expect(await screen.findByRole("tab", { name: "Schedules" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Installed" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Browse" })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search installed agents…")).toBeInTheDocument();
    expect(screen.getByText("Scheduled only")).toBeInTheDocument();
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
