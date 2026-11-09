import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import Agents from "./Agents";
import Changes from "./Changes";
import Settings, { ChatSettingsSection } from "./Settings";
import { createMockAgent, createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";

/**
 * Hard constraint 3 (review round 1): work that always reads a service
 * keeps its gate. With organizations on the device but none active, it
 * opens setup or stays disabled, and never reaches the host.
 */
function noOrganization(overrides: Parameters<typeof createMockAppState>[0] = {}) {
  const { activeTenantId: _none, ...state } = createMockAppState(overrides);
  return state;
}

describe("gates that still need an organization", () => {
  it("Changes shows No organization and opens setup instead of reading drift", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, noOrganization());
    renderRoute(<Changes />, { path: "/changes", route: "/changes", bridge });
    expect(await screen.findByText("No organization is active")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Connect Microsoft 365" }));
    expect(await screen.findByRole("radio", { name: "OpenAdminOS app" })).toBeInTheDocument();
  });

  it("the Data cache refresh opens setup instead of refreshing", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, noOrganization());
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/data", bridge });
    const data = await screen.findByRole("region", { name: "Data" });
    await user.click(within(data).getAllByRole("button", { name: "Refresh now" })[0]!);
    expect(await screen.findByRole("radio", { name: "OpenAdminOS app" })).toBeInTheDocument();
    expect(bridge.refreshGraphCache).not.toHaveBeenCalled();
  });

  it("the Chat settings cache refresh opens setup instead of refreshing", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, noOrganization());
    renderRoute(<ChatSettingsSection />, { path: "*", route: "/settings/chat", bridge });
    await user.click(await screen.findByRole("button", { name: "Refresh now" }));
    expect(await screen.findByRole("radio", { name: "OpenAdminOS app" })).toBeInTheDocument();
    expect(bridge.refreshGraphCache).not.toHaveBeenCalled();
  });

  it("schedules cannot be run in a batch with no organization", async () => {
    const user = userEvent.setup();
    const scheduled = createMockAgent({
      schedule: { enabled: true, intervalSeconds: 900, lastScheduledRunAt: "2026-01-01T00:00:00.000Z", organizationId: "org-tenant-1" },
    });
    const bridge = makeMockBridge({}, noOrganization({ installedAgents: [scheduled] }));
    renderRoute(<Agents />, { path: "/agents", route: "/agents?filter=scheduled", bridge });
    await user.click(await screen.findByRole("button", { name: "Schedule actions" }));
    expect(screen.getByRole("menuitem", { name: /Run due now/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Run all scheduled" })).toBeDisabled();
    expect(bridge.startRun).not.toHaveBeenCalled();
  });
});
