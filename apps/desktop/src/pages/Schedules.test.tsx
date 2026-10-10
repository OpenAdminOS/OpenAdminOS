import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Agents from "./Agents";
import type { OfficePersona } from "../shared/openAdminOS";
import {
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";

describe("Agents schedule actions", () => {
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

  it("uses query-addressable Installed, Hub, and scheduled filters without a Schedules tab", async () => {
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?source=hub&filter=scheduled",
      bridge: makeMockBridge(),
    });

    expect(await screen.findByRole("radio", { name: "Hub" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByPlaceholderText("Search hub…")).toBeInTheDocument();
    expect(screen.getByText("Scheduled only")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Schedules" })).not.toBeInTheDocument();
  });

  it("opens the URL-addressable agent drawer and targets its schedule section", async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
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
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    } finally {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
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

  it("opens a persona drawer from its consolidated Team URL", async () => {
    const persona: OfficePersona = {
      id: "policy-watcher",
      name: "Policy Watcher",
      responsibility: "Review policy changes",
      avatar: "robot",
      color: "amber",
      tenantId: "tenant-1",
      providerId: "ollama",
      agentSlugs: ["device-offboard"],
      intervalMinutes: null,
      maxMinutes: 30,
      enabled: true,
      createdAt: "2026-09-10T10:00:00Z",
      updatedAt: "2026-09-10T10:00:00Z",
    };
    const state = createMockAppState({
      office: { personas: [persona], missions: [] },
    });

    renderRoute(<Agents />, {
      path: "/agents/team/:personaId",
      route: "/agents/team/policy-watcher",
      bridge: makeMockBridge({}, state),
    });

    const drawer = await screen.findByRole("dialog", { name: "Policy Watcher" });
    expect(within(drawer).getByRole("heading", { name: "Assignment" })).toBeInTheDocument();
    expect(within(drawer).getByRole("heading", { name: "Work order" })).toBeInTheDocument();
    expect(within(drawer).getByRole("button", { name: "Run first assignment" })).toBeInTheDocument();
  });
});
