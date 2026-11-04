import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import Agents from "./Agents";
import { createMockAgent, createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import type { RegistryAgentSummary } from "../shared/openAdminOS";

function registryAgent(overrides: Partial<RegistryAgentSummary>): RegistryAgentSummary {
  const { installedAt: _installedAt, ...agent } = createMockAgent({ mode: "read" });
  return { ...agent, registryId: agent.slug, ...overrides } as RegistryAgentSummary;
}

const intuneOnlyTenant = {
  ...createMockAppState().tenants[0]!,
  grantedScopes: [
    "graph:User.Read.All",
    "graph:GroupMember.Read.All",
    "graph:Organization.Read.All",
    "graph:DeviceManagementManagedDevices.Read.All",
  ],
};

describe("agents by service", () => {
  it("shows service chips in the hub and filters by service", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      registryAgents: [
        registryAgent({ id: "devices", slug: "devices", name: "Inactive devices", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] }),
        registryAgent({ id: "score", slug: "score", name: "Secure score prioritizer", scopes: ["SecurityEvents.Read.All"], services: ["defender"] }),
        // No declaration: derived from the scopes.
        registryAgent({ id: "guests", slug: "guests", name: "Stale guests", scopes: ["User.Read.All", "AuditLog.Read.All"] }),
      ],
    });
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents?source=hub",
      bridge: makeMockBridge({}, state),
    });

    const hub = await screen.findByLabelText("Agent hub");
    expect(within(hub).getByLabelText("Services: Defender")).toBeInTheDocument();
    expect(within(hub).getByLabelText("Services: Entra")).toBeInTheDocument();
    expect(within(hub).getByText("Inactive devices")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(screen.getByRole("menuitem", { name: "Needs Defender" }));
    expect(within(hub).getByText("Secure score prioritizer")).toBeInTheDocument();
    expect(within(hub).queryByText("Inactive devices")).not.toBeInTheDocument();
    expect(within(hub).queryByText("Stale guests")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 hub agents")).toBeInTheDocument();
  });

  it("names a service that is not connected on the agent detail", async () => {
    const agent = createMockAgent({
      id: "score",
      slug: "score",
      name: "Secure score prioritizer",
      mode: "read",
      scopes: ["SecurityEvents.Read.All"],
      services: ["defender"],
    });
    const state = createMockAppState({ tenants: [intuneOnlyTenant], installedAgents: [agent] });
    renderRoute(<Agents />, {
      path: "/agents/:slug",
      route: "/agents/score",
      bridge: makeMockBridge({}, state),
    });

    expect(await screen.findByText("Needs Defender, not connected.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Defender" })).toBeInTheDocument();
  });

  it("disables Start run in the run review while the service is not connected", async () => {
    const user = userEvent.setup();
    const agent = createMockAgent({
      id: "score",
      slug: "score",
      name: "Secure score prioritizer",
      mode: "read",
      scopes: ["SecurityEvents.Read.All"],
      services: ["defender"],
    });
    const state = createMockAppState({ tenants: [intuneOnlyTenant], installedAgents: [agent] });
    renderRoute(<Agents startRunOnOpen />, {
      path: "/agents/:slug/confirm",
      route: "/agents/score/confirm",
      bridge: makeMockBridge({}, state),
    });

    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(within(dialog).getByText("Needs Defender, not connected.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Start run" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Add Defender" }));
    expect(screen.getByRole("dialog", { name: "Add Defender access" })).toBeInTheDocument();
  });

  it("says runs are blocked in Permissions when the service is not connected", async () => {
    const agent = createMockAgent({
      id: "score",
      slug: "score",
      name: "Secure score prioritizer",
      mode: "read",
      scopes: ["SecurityEvents.Read.All"],
      services: ["defender"],
    });
    const state = createMockAppState({ tenants: [intuneOnlyTenant], installedAgents: [agent] });
    renderRoute(<Agents />, {
      path: "/agents/:slug",
      route: "/agents/score",
      bridge: makeMockBridge({}, state),
    });

    expect(
      await screen.findByText(
        `Runs are blocked until Defender is connected for ${intuneOnlyTenant.displayName}. Add it in Settings, Tenants.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/requested before the first run/)).not.toBeInTheDocument();
  });

  it("says missing scopes of a connected service are requested when the run starts", async () => {
    const agent = createMockAgent({
      id: "devices",
      slug: "devices",
      name: "Inactive devices",
      mode: "read",
      scopes: ["DeviceManagementManagedDevices.Read.All", "DeviceManagementConfiguration.Read.All"],
      services: ["intune"],
    });
    const state = createMockAppState({ tenants: [intuneOnlyTenant], installedAgents: [agent] });
    renderRoute(<Agents />, {
      path: "/agents/:slug",
      route: "/agents/devices",
      bridge: makeMockBridge({}, state),
    });

    expect(
      await screen.findByText(
        `Scopes not yet granted for ${intuneOnlyTenant.displayName} are requested when the run starts.`,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Needs Intune, not connected.")).not.toBeInTheDocument();
  });

  it("says every scope is granted when nothing is missing", async () => {
    const agent = createMockAgent({
      id: "devices",
      slug: "devices",
      name: "Inactive devices",
      mode: "read",
      scopes: ["DeviceManagementManagedDevices.Read.All"],
      services: ["intune"],
    });
    const state = createMockAppState({ tenants: [intuneOnlyTenant], installedAgents: [agent] });
    renderRoute(<Agents />, {
      path: "/agents/:slug",
      route: "/agents/devices",
      bridge: makeMockBridge({}, state),
    });

    expect(
      await screen.findByText(`Every scope listed here is granted for ${intuneOnlyTenant.displayName}.`),
    ).toBeInTheDocument();
  });
});
