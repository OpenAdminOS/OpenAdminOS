import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Navigate, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";

import Agents from "./Agents";
import Marketplace from "./Marketplace";
import { createMockAgent, createMockAppState, makeMockBridge, mockProviders, renderRoute } from "../test/test-utils";
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
    expect(within(list).getByText("Needs Defender")).toBeInTheDocument();
    expect(within(list).getByText("Needs Entra")).toBeInTheDocument();

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
    expect(within(row("Secure score prioritizer")).getByText("Needs Defender, not connected")).toBeInTheDocument();
    expect(within(row("Sign-in failures")).getByRole("button", { name: "Add sign-in logs" })).toBeInTheDocument();
    expect(within(row("Sign-in failures")).getByText("Needs Entra; Entra sign-in logs, not granted")).toBeInTheDocument();
    // Missing access is a dashed neutral chip, never amber (design round).
    const missingPart = within(row("Sign-in failures")).getByText("Sign-in logs, not granted");
    expect(missingPart).toHaveAttribute("data-state", "missing");
    const missingService = within(row("Secure score prioritizer")).getByText("Defender, not connected");
    expect(missingService.querySelector(".svc-mark")).toHaveAttribute("data-off", "true");
    expect(row("Secure score prioritizer").innerHTML).not.toContain("color-warning");
    // No shield tile and no usage boilerplate on the row.
    expect(row("Guest review").querySelector(".calm-row-icon")).toBeNull();
    expect(within(row("Guest review")).getByRole("button", { name: "Run" })).toBeInTheDocument();
    expect(within(row("Script draft")).getAllByText("No service needed")[0]).toHaveClass("sr-only");
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
    const bridge = makeMockBridge({ listConnectors: vi.fn(async () => [connectorSummary("slack", "connected", { defaultChannel: "C1" })]) }, noOrganizationState([draft]));
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge });
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(dialog).toHaveTextContent("It reads no service data.");
    await waitFor(() => expect(dialog).toHaveTextContent("Saved delivery rules can send its report to Slack."));
    expect(dialog).toHaveTextContent("Microsoft Teams is skipped: it posts with an organization's Microsoft sign-in.");
    expect(dialog).not.toHaveTextContent("cannot reach any service");
    expect(dialog).not.toHaveTextContent("Discord");
  });

  it("says when no delivery rule sends the report", async () => {
    const draft = createMockAgent({ id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [] });
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge: makeMockBridge({}, noOrganizationState([draft])) });
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    await waitFor(() => expect(dialog).toHaveTextContent("No saved delivery rule sends its report."));
  });

  it("uses no-organization wording for a hosted provider", async () => {
    const draft = createMockAgent({ id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [] });
    const state = { ...noOrganizationState([draft]), activeProviderId: "openai" as const };
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge: makeMockBridge({}, state) });
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    expect(dialog).toHaveTextContent("Prompts and agent context are sent through the Codex CLI to OpenAI and leave this device. No organization is active, so no tenant data is included.");
    expect(dialog).not.toHaveTextContent("Tenant prompts");
  });

  it("keeps the tenant wording for a hosted provider in an organization", async () => {
    const agent = createMockAgent({ id: "devices", slug: "devices", name: "Inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] });
    renderRoute(<Agents startRunOnOpen />, {
      path: "/agents/:slug/confirm",
      route: "/agents/devices/confirm",
      bridge: makeMockBridge({}, createMockAppState({ activeProviderId: "openai", installedAgents: [agent] })),
    });
    expect(await screen.findByRole("dialog", { name: /Review run/ })).toHaveTextContent("Tenant prompts and agent context are sent through the Codex CLI to OpenAI and leave this device.");
  });
});

it("names the Azure OpenAI API, not a local CLI, in the run review", async () => {
  const azure = { ...mockProviders.find((provider) => provider.id === "azure-openai")!, status: "available" as const, models: ["gpt-4o"], defaultModel: "gpt-4o" };
  const agent = createMockAgent({ id: "devices", slug: "devices", name: "Inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] });
  renderRoute(<Agents startRunOnOpen />, {
    path: "/agents/:slug/confirm",
    route: "/agents/devices/confirm",
    bridge: makeMockBridge({}, createMockAppState({
      activeProviderId: "azure-openai",
      providers: mockProviders.map((provider) => (provider.id === "azure-openai" ? azure : provider)),
      installedAgents: [agent],
    })),
  });
  const dialog = await screen.findByRole("dialog", { name: /Review run/ });
  expect(dialog).toHaveTextContent("sent through the Azure OpenAI API to your deployment");
  expect(dialog).not.toHaveTextContent("local CLI");
});

it("gives screen readers the service needs as text, not a label on a span", async () => {
  const agent = createMockAgent({ id: "score", slug: "score", name: "Secure score prioritizer", mode: "read", scopes: ["SecurityEvents.Read.All"], services: ["defender"] });
  renderRoute(<Agents />, { path: "/agents", route: "/agents", bridge: makeMockBridge({}, createMockAppState({ tenants: [intuneOnlyTenant], installedAgents: [agent] })) });
  const text = await screen.findByText("Needs Defender, not connected");
  expect(text).toHaveClass("sr-only");
  expect(text.closest("[aria-hidden='true']")).toBeNull();
  // The row button's accessible name includes the needs.
  expect(screen.getByRole("button", { name: /Secure score prioritizer.*Needs Defender, not connected/ })).toBeInTheDocument();
  expect(document.querySelector("span[aria-label^='Needs']")).toBeNull();
});

function connectorSummary(
  id: string,
  status: "connected" | "needs-setup" | "unknown" | "error" = "connected",
  config: Record<string, unknown> = {},
) {
  return {
    descriptor: { id, name: id, version: "1.0.0", authSource: "external", scopes: [], capabilities: [], trust: {} },
    config,
    status,
  } as never;
}

it("says nothing is sent only where the host sends nothing, whatever the health status (review round 4)", async () => {
  const draft = createMockAgent({
    id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [],
    delivery: {
      // A saved token with no global configuration and a channel on the rule: the host posts.
      slack: { enabled: true, useDefaultChannel: false, channel: "C999" },
      // A stale error status does not stop the host from sending.
      discord: { enabled: true },
      // A default recipient that was never saved: the host sends nothing.
      signal: { enabled: true, useDefaultRecipient: true },
    },
  });
  const { activeTenantId: _none, ...state } = createMockAppState({ installedAgents: [draft] });
  const bridge = makeMockBridge(
    {
      listConnectors: vi.fn(async () => [
        connectorSummary("slack", "unknown"),
        connectorSummary("discord", "error"),
        connectorSummary("signal", "connected"),
      ]),
    },
    { ...state, tenants: [] },
  );
  renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge });
  const dialog = await screen.findByRole("dialog", { name: /Review run/ });
  await waitFor(() => expect(dialog).toHaveTextContent("Saved delivery rules can send its report to Slack and Discord."));
  expect(dialog).toHaveTextContent("Signal has no destination set, so nothing is sent there.");
  expect(dialog).not.toHaveTextContent("Slack has no destination");
});

it("names the organization of a resumed run's tenant, not the active one (Muse round 2)", async () => {
  const fabrikam = { ...createMockAppState().tenants[0]!, id: "tenant-2", displayName: "Fabrikam" };
  const agent = createMockAgent({ id: "devices", slug: "devices", name: "Inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] });
  const state = createMockAppState({ tenants: [createMockAppState().tenants[0]!, fabrikam], installedAgents: [agent] });
  const intent = { kind: "agent-run", slug: "devices", tenantId: "tenant-2", returnTo: "/agents/devices", createdAt: new Date().toISOString() };
  const bridge = makeMockBridge({}, state);
  renderRoute(
    <Routes>
      <Route path="/start" element={<Navigate to="/agents/devices" state={{ resumePendingIntent: intent }} />} />
      <Route path="/agents/:slug" element={<Agents />} />
    </Routes>,
    { path: "*", route: "/start", bridge },
  );
  const dialog = await screen.findByRole("dialog", { name: /Review run/ });
  expect(within(dialog).getByText("Fabrikam")).toBeInTheDocument();
  expect(within(dialog).queryByText("Contoso IT")).not.toBeInTheDocument();
  expect(within(dialog).getByRole("alert")).toHaveTextContent("This run is set up for Fabrikam, which is not the active organization.");
  expect(within(dialog).getByRole("button", { name: "Start run" })).toBeDisabled();
});

it("shows a pilot agent's services as connected in the sample organization (Muse round 2)", async () => {
  const sample = { ...createMockAppState().tenants[0]!, id: "openadminos-sample-tenant", displayName: "Contoso (pilot)", kind: "sample" as const };
  const agent = createMockAgent({ id: "find-inactive-devices", slug: "find-inactive-devices", name: "Find inactive devices", mode: "read", scopes: ["DeviceManagementManagedDevices.Read.All"], services: ["intune"] });
  renderRoute(<Agents />, {
    path: "/agents/:slug",
    route: "/agents/find-inactive-devices",
    bridge: makeMockBridge({}, createMockAppState({ tenants: [sample], activeTenantId: sample.id, installedAgents: [agent] })),
  });
  expect(await screen.findByText("Needs Intune")).toHaveClass("sr-only");
  expect(screen.queryByText(/Intune, not connected/)).not.toBeInTheDocument();
});

describe("start errors inside the run review (review round 3)", () => {
  const draft = () => createMockAgent({ id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [] });

  it("checks the provider without an organization and offers provider settings", async () => {
    const unready = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, status: "error" as const, detail: "Ollama isn't running. Start it with `ollama serve`." } : provider));
    const { activeTenantId: _none, ...state } = createMockAppState({ installedAgents: [draft()], providers: unready });
    const bridge = makeMockBridge({}, { ...state, tenants: [] });
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge });
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    const notReady = within(dialog).getAllByRole("alert").find((element) => element.textContent?.includes("is not ready to run this agent"))!;
    expect(notReady).toHaveTextContent("Ollama isn't running. Start it with `ollama serve`.");
    expect(within(notReady).getByRole("button", { name: "Open provider settings" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Start run" })).toBeDisabled();
    expect(bridge.startRun).not.toHaveBeenCalled();
  });

  it("shows a refused start inside the review with Try again", async () => {
    const user = userEvent.setup();
    const { activeTenantId: _none, ...state } = createMockAppState({ installedAgents: [draft()] });
    const startRun = vi
      .fn()
      .mockRejectedValueOnce(new Error("Ollama isn't reachable. Start it with `ollama serve`, then try again."))
      .mockResolvedValueOnce({ id: "run-2", agentSlug: "draft", status: "queued", queuedAt: "2026-11-09T00:00:00.000Z", steps: [], logs: [] });
    const bridge = makeMockBridge({ startRun }, { ...state, tenants: [] });
    renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge });
    const dialog = await screen.findByRole("dialog", { name: /Review run/ });
    await user.click(within(dialog).getByRole("button", { name: "Start run" }));
    const failure = await within(dialog).findByText("The run did not start.");
    const alert = failure.closest("[role='alert']") as HTMLElement;
    expect(alert).toHaveTextContent("Ollama isn't reachable. Start it with `ollama serve`, then try again.");
    expect(within(alert).getByRole("button", { name: "Open provider settings" })).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(startRun).toHaveBeenCalledTimes(2));
  });
});

it("says the report destinations could not be checked when the connector list fails (Muse round 3)", async () => {
  const draft = createMockAgent({
    id: "draft", slug: "draft", name: "Script draft", mode: "read", scopes: [], services: [],
    delivery: { slack: { enabled: true } },
  });
  const { activeTenantId: _none, ...state } = createMockAppState({ installedAgents: [draft] });
  const bridge = makeMockBridge(
    { listConnectors: vi.fn(async () => { throw new Error("The connector list could not be read."); }) },
    { ...state, tenants: [] },
  );
  renderRoute(<Agents startRunOnOpen />, { path: "/agents/:slug/confirm", route: "/agents/draft/confirm", bridge });
  const dialog = await screen.findByRole("dialog", { name: /Review run/ });
  await waitFor(() => expect(dialog).toHaveTextContent("Where its report goes could not be checked: saved delivery rules may still send it."));
  expect(dialog).not.toHaveTextContent("No saved delivery rule sends its report.");
  expect(dialog).not.toHaveTextContent("so nothing is sent there");
});
