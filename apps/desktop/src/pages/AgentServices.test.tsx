import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";

import Agents from "./Agents";
import Marketplace from "./Marketplace";
import { createMockAgent, createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import { SERVICE_PARTS, type RegistryAgentSummary } from "../shared/openAdminOS";

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
  it("shows service chips in the Marketplace agent catalog", async () => {
    const state = createMockAppState({
      registryAgents: [
        registryAgent({ id: "devices", slug: "devices", name: "Inactive devices", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] }),
        registryAgent({ id: "score", slug: "score", name: "Secure score prioritizer", scopes: ["SecurityEvents.Read.All"], services: ["defender"] }),
        // No declaration: derived from the scopes.
        registryAgent({ id: "guests", slug: "guests", name: "Stale guests", scopes: ["User.Read.All", "AuditLog.Read.All"] }),
      ],
    });
    renderRoute(<Marketplace />, {
      path: "/marketplace",
      route: "/marketplace?kind=agents",
      bridge: makeMockBridge({}, state),
    });

    const catalog = await screen.findByLabelText("Agent catalog");
    expect(within(catalog).getByLabelText("Services: Defender")).toBeInTheDocument();
    expect(within(catalog).getByLabelText("Services: Entra")).toBeInTheDocument();
    expect(within(catalog).getByText("Inactive devices")).toBeInTheDocument();
  });

  it("filters installed agents by service", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      installedAgents: [
        createMockAgent({ id: "devices", slug: "devices", name: "Inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] }),
        createMockAgent({ id: "score", slug: "score", name: "Secure score prioritizer", mode: "read", scopes: ["SecurityEvents.Read.All"], services: ["defender"] }),
        // No declaration: derived from the scopes.
        createMockAgent({ id: "guests", slug: "guests", name: "Stale guests", mode: "read", scopes: ["User.Read.All", "AuditLog.Read.All"] }),
      ],
    });
    renderRoute(<Agents />, {
      path: "/agents",
      route: "/agents",
      bridge: makeMockBridge({}, state),
    });

    const list = await screen.findByLabelText("Installed agents");
    expect(within(list).getByLabelText("Needs Defender")).toBeInTheDocument();
    expect(within(list).getByLabelText("Needs Entra")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByRole("menuitemradio", { name: "All services" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "Needs Defender" }));
    expect(within(list).getByText("Secure score prioritizer")).toBeInTheDocument();
    expect(within(list).queryByText("Inactive devices")).not.toBeInTheDocument();
    expect(within(list).queryByText("Stale guests")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 3 installed agents")).toBeInTheDocument();
    // The selected filter is shown by its checked state, not a mark in the label.
    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.getByRole("menuitemradio", { name: "Needs Defender" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "All services" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("menuitemcheckbox", { name: "Scheduled only" })).toHaveAttribute("aria-checked", "false");
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

  it("blocks the run review when the declared services do not cover the scopes", async () => {
    const agent = createMockAgent({
      id: "devices",
      slug: "devices",
      name: "Device and group report",
      mode: "read",
      scopes: ["Group.Read.All", "DeviceManagementManagedDevices.Read.All"],
      services: ["entra"],
    });
    const entraTenant = {
      ...createMockAppState().tenants[0]!,
      grantedScopes: ["graph:User.Read", "graph:Group.Read.All", "graph:GroupMember.Read.All"],
    };
    const state = createMockAppState({ tenants: [entraTenant], installedAgents: [agent] });
    renderRoute(<Agents startRunOnOpen />, {
      path: "/agents/:slug/confirm",
      route: "/agents/devices/confirm",
      bridge: makeMockBridge({}, state),
    });

    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "This agent uses DeviceManagementManagedDevices.Read.All, which its declared service Entra does not cover. It cannot run until the agent also declares Intune. Report it to the agent author.",
    );
    expect(within(dialog).getByRole("button", { name: "Start run" })).toBeDisabled();
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
        `Runs are blocked until Defender is connected for ${intuneOnlyTenant.displayName}. Add it in Connections.`,
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

const entraNoSignIns = {
  ...createMockAppState().tenants[0]!,
  grantedScopes: [
    ...new Set(
      SERVICE_PARTS.filter((part) => part.service === "entra" && part.id !== "entra.signins").flatMap((part) =>
        part.scopes.map((scope) => `graph:${scope.name}`),
      ),
    ),
  ],
};

function noOrganizationState(installedAgents: ReturnType<typeof createMockAgent>[]) {
  const { activeTenantId: _none, ...state } = createMockAppState({ installedAgents });
  return { ...state, tenants: [] };
}

describe("agents with service needs", () => {
  it("names what is missing in the row action and runs a service-free agent anywhere", async () => {
    const state = createMockAppState({
      tenants: [entraNoSignIns],
      installedAgents: [
        createMockAgent({ id: "score", slug: "score", name: "Secure score prioritizer", mode: "read", scopes: ["SecurityEvents.Read.All"], services: ["defender"] }),
        createMockAgent({ id: "risky", slug: "risky", name: "Sign-in failures", mode: "read", scopes: ["AuditLog.Read.All"], services: ["entra"] }),
        createMockAgent({ id: "guests", slug: "guests", name: "Guest review", mode: "read", scopes: ["User.Read.All"], services: ["entra"] }),
        createMockAgent({ id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [] }),
      ],
    });
    renderRoute(<Agents />, { path: "/agents", route: "/agents", bridge: makeMockBridge({}, state) });

    const list = await screen.findByLabelText("Installed agents");
    const row = (name: string) => within(list).getByText(name).closest(".calm-list-row") as HTMLElement;
    expect(within(row("Secure score prioritizer")).getByRole("button", { name: "Connect Defender" })).toBeInTheDocument();
    expect(within(row("Secure score prioritizer")).getByLabelText("Needs Defender, not connected")).toBeInTheDocument();
    expect(within(row("Sign-in failures")).getByRole("button", { name: "Add sign-in logs" })).toBeInTheDocument();
    expect(within(row("Sign-in failures")).getByLabelText("Needs Entra; Entra sign-in logs, not connected")).toBeInTheDocument();
    expect(within(row("Guest review")).getByRole("button", { name: "Run" })).toBeInTheDocument();
    expect(within(row("Script draft")).getByLabelText("No service needed")).toBeInTheDocument();
    expect(within(row("Script draft")).getByRole("button", { name: "Run" })).toBeInTheDocument();
  });

  it("opens the service dialog for the missing part from the row action", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      tenants: [entraNoSignIns],
      installedAgents: [createMockAgent({ id: "risky", slug: "risky", name: "Sign-in failures", mode: "read", scopes: ["AuditLog.Read.All"], services: ["entra"] })],
    });
    const bridge = makeMockBridge({}, state);
    renderRoute(<Agents />, { path: "/agents", route: "/agents", bridge });
    await user.click(await screen.findByRole("button", { name: "Add sign-in logs" }));
    const dialog = screen.getByRole("dialog", { name: "Add Entra access" });
    expect(within(dialog).getByRole("checkbox", { name: "Sign-in logs" })).toBeChecked();
    expect(bridge.startRun).not.toHaveBeenCalled();
  });

  it("opens the preflight without an organization, names the services and starts nothing", async () => {
    const user = userEvent.setup();
    const devices = createMockAgent({ id: "devices", slug: "devices", name: "Inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] });
    const bridge = makeMockBridge({}, noOrganizationState([devices]));
    renderRoute(
      <Routes>
        <Route path="/agents" element={<Agents />} />
        <Route path="/agents/:slug/confirm" element={<Agents startRunOnOpen />} />
      </Routes>,
      { path: "*", route: "/agents", bridge },
    );

    await user.click(await screen.findByRole("button", { name: "Connect Intune" }));
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Inactive devices needs Intune.");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("No organization is active.");
    expect(within(dialog).getByText("No organization")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Start run" })).toBeDisabled();
    // Connect opens setup instead of a run.
    await user.click(within(dialog).getByRole("button", { name: "Connect Intune" }));
    expect(await screen.findByRole("radio", { name: "OpenAdminOS app" })).toBeInTheDocument();
    expect(bridge.startRun).not.toHaveBeenCalled();
  });

  it("still needs an organization for an agent with services: [] and only the sign-in scope", async () => {
    const whoami = createMockAgent({ id: "whoami", slug: "whoami", name: "Who am I", mode: "read", scopes: ["User.Read"], services: [] });
    const bridge = makeMockBridge({}, noOrganizationState([whoami]));
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/whoami/confirm", bridge });

    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Who am I needs the Microsoft 365 sign-in.");
    expect(within(dialog).getByRole("button", { name: "Start run" })).toBeDisabled();
  });

  it("runs an agent that calls no service API with no organization", async () => {
    const user = userEvent.setup();
    const draft = createMockAgent({ id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [] });
    const bridge = makeMockBridge({}, noOrganizationState([draft]));
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge });

    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(within(dialog).getByRole("status")).toHaveTextContent("No organization needed.");
    expect(within(dialog).getByText("None needed")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Start run" }));
    await waitFor(() => expect(bridge.startRun).toHaveBeenCalledWith("draft", expect.not.objectContaining({ tenantId: expect.anything() })));
  });
});

describe("preflight without an organization (review round 1)", () => {
  it("says no service data is read and lists where the report goes", async () => {
    const draft = createMockAgent({
      id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [],
      delivery: {
        slack: { enabled: true },
        teams: { enabled: true },
        discord: { enabled: true, includeManualRuns: false },
      },
    });
    const bridge = makeMockBridge({}, noOrganizationState([draft]));
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge });
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(dialog).toHaveTextContent("It reads no service data.");
    expect(dialog).toHaveTextContent("Saved delivery rules send its report to Slack.");
    expect(dialog).toHaveTextContent("Microsoft Teams is skipped: it posts with an organization's Microsoft sign-in.");
    expect(dialog).not.toHaveTextContent("cannot reach any service");
    expect(dialog).not.toHaveTextContent("Discord");
  });

  it("says when no delivery rule sends the report", async () => {
    const draft = createMockAgent({ id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [] });
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge: makeMockBridge({}, noOrganizationState([draft])) });
    expect(await screen.findByRole("dialog", { name: /Review run/ })).toHaveTextContent("No saved delivery rule sends its report.");
  });

  it("uses no-organization wording for a hosted provider", async () => {
    const draft = createMockAgent({ id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [] });
    const state = { ...noOrganizationState([draft]), activeProviderId: "openai" as const };
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge: makeMockBridge({}, state) });
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(dialog).toHaveTextContent(/Prompts and agent context are sent through OpenAI.*No organization is active, so no tenant data is included\./);
    expect(dialog).not.toHaveTextContent("Tenant prompts");
  });

  it("keeps the tenant wording for a hosted provider in an organization", async () => {
    const agent = createMockAgent({ id: "devices", slug: "devices", name: "Inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] });
    renderRoute(<Agents startRunOnOpen />, {
      path: "/agents/:slug/confirm",
      route: "/agents/devices/confirm",
      bridge: makeMockBridge({}, createMockAppState({ activeProviderId: "openai", installedAgents: [agent] })),
    });
    expect(await screen.findByRole("dialog", { name: /Review run/ })).toHaveTextContent("Tenant prompts and agent context are sent through");
  });
});
