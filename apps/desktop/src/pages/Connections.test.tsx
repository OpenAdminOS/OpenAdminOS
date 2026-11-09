import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Connections, { REACH_STACK_BELOW, buildReachModel, reachDescription, reachLayout, reachLinks, reachPaths } from "./Connections";
import { reportDestinations, resultDestinations, targetlessDestinations } from "../shared/delivery-destinations";
import {
  createMockAgent,
  createMockAppState,
  createMockMcpServers,
  makeMockBridge,
  mockProviders,
  renderRoute,
} from "../test/test-utils";
import { CONNECTIONS_COPY, ORGANIZATION_COPY, SERVICE_COPY, SETUP_COPY, deriveToolHostsCopy } from "../copy";
import { chatToolHosts, deriveDataBoundary } from "../state";
import { hostedChannel } from "../shared/providers";
import { AppShell } from "../components/AppShell";
import { connectedServiceIds } from "../components/ServiceMark";
import { SERVICE_PARTS, type AppState, type ConnectorSummary } from "../shared/openAdminOS";

function connector(id: string, name: string, status: ConnectorSummary["status"] = "connected", config: Record<string, unknown> = {}): ConnectorSummary {
  return {
    descriptor: { id, name, version: "1.0.0", authSource: "external", scopes: [], capabilities: [], trust: { publisher: "OpenAdminOS", verified: true } } as unknown as ConnectorSummary["descriptor"],
    config,
    status,
  };
}

/** Teams with a saved default team and channel, so the host posts there. */
function teamsConnector(status: ConnectorSummary["status"] = "connected"): ConnectorSummary {
  return connector("teams", "Microsoft Teams", status, { defaultTeamId: "team-1", defaultChannelId: "channel-1" });
}

function render(state: AppState, overrides: Parameters<typeof makeMockBridge>[0] = {}, route = "/connections") {
  const bridge = makeMockBridge(overrides, state);
  renderRoute(<Connections />, { path: "/connections", route, bridge });
  return bridge;
}

/** Every Intune part granted, which also grants the Entra users part they share scopes with. */
const intuneScopes = [
  ...new Set(SERVICE_PARTS.filter((part) => part.service === "intune").flatMap((part) => part.scopes.map((scope) => `graph:${scope.name}`))),
];
const partialTenant = { ...createMockAppState().tenants[0]!, grantedScopes: intuneScopes };

describe("Connections reach map", () => {
  it("lists the same reference hosts as the status strip and the saved delivery rules", () => {
    const state = createMockAppState({
      tenants: [partialTenant],
      mcpServers: createMockMcpServers({
        "kql-search": { installed: true, enabled: true },
        "microsoft-learn": { installed: true, enabled: true },
        // Installed but off: Chat sends it nothing.
        intuneautomation: { installed: true, enabled: false },
      }),
      installedAgents: [
        createMockAgent({ id: "a", slug: "a", delivery: { teams: { enabled: true } } }),
        createMockAgent({ id: "b", slug: "b", delivery: { slack: { enabled: false } } }),
      ],
    });
    const model = buildReachModel(state, [teamsConnector()]);
    expect(model.referenceHosts).toEqual(chatToolHosts(state));
    expect(model.referenceHosts).toEqual(["learn.microsoft.com", "www.kqlsearch.com"]);
    expect(model.reportDestinations).toEqual(["Microsoft Teams"]);
    expect(model.model.kind).toBe("local");
    expect(model.services.map((service) => [service.title, service.status])).toEqual([
      ["Intune", "connected"],
      ["Entra", "partial"],
      ["Defender", "missing"],
    ]);
  });

  it("gives the map a text alternative that names everything that leaves the device", async () => {
    const state = createMockAppState({
      tenants: [partialTenant],
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
      installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })],
    });
    render(state, { listConnectors: vi.fn(async () => [teamsConnector()]) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    const description = reachDescription(buildReachModel(state, [teamsConnector()]));
    await waitFor(() => expect(map).toHaveAccessibleDescription(description));
    expect(description).toMatch(
      /^Contoso IT reads Intune, connected, Entra, \d of 6 parts and Defender, not connected into this device\. The model runs on this device: llama3\.1, local\. Words from questions go to www\.kqlsearch\.com\. Run reports and agent messages can go to Microsoft Teams under saved delivery rules and agent steps\.$/,
    );
    expect(within(map).getByText(CONNECTIONS_COPY.map.promptsLocal)).toBeInTheDocument();
  });

  it("names the hosted provider and its documented API location", async () => {
    const hosted = mockProviders.find((provider) => !provider.isLocal && provider.status === "connected")!;
    const state = createMockAppState({ activeProviderId: hosted.id });
    const model = buildReachModel(state);
    expect(model.model.kind).toBe("hosted");
    render(state);
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    // The row names where prompts go and the model; the channel is its hint.
    const row = within(map).getByText("OpenAI API · US");
    expect(row).toHaveAttribute("title", expect.stringContaining(`${hosted.name}, through the Codex CLI`));
    expect(within(map).getByText(model.model.modelName!)).toBeInTheDocument();
    expect(reachDescription(model)).toContain("Prompts and tenant data go through the Codex CLI to OpenAI. Prompts go to OpenAI API · US.");
    expect(reachDescription(model)).not.toContain("Region not reported");
  });

  it("shows an empty state with Connect Microsoft 365 and no services list when no organization is active", async () => {
    const user = userEvent.setup();
    const { activeTenantId: _none, ...state } = createMockAppState({ tenants: [] });
    render({ ...state, tenants: [] });
    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.pageTitle })).toBeInTheDocument();
    expect(screen.getByText(CONNECTIONS_COPY.ledeNone)).toBeInTheDocument();
    expect(screen.queryByText(CONNECTIONS_COPY.lede)).not.toBeInTheDocument();
    const empty = screen.getByRole("region", { name: CONNECTIONS_COPY.emptyTitle });
    expect(within(empty).getByText(CONNECTIONS_COPY.emptyBody)).toBeInTheDocument();
    // The figure keeps its text alternative.
    const figure = within(empty).getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(figure).toHaveAccessibleDescription(/^No organization reads no service into this device\./);
    // One filled button: Connect Microsoft 365. Sample data is the secondary way in.
    expect(within(empty).getByRole("button", { name: ORGANIZATION_COPY.previewSample })).toBeInTheDocument();
    // No services list with Not connected rows, and no empty map.
    expect(screen.queryByRole("region", { name: CONNECTIONS_COPY.servicesHeading })).not.toBeInTheDocument();
    expect(screen.queryByText(SERVICE_COPY.status.missing)).not.toBeInTheDocument();
    expect(document.querySelector(".reach-map")).toBeNull();
    const leaves = screen.getByRole("region", { name: CONNECTIONS_COPY.leavesNowHeading });
    expect(within(leaves).getByText(CONNECTIONS_COPY.map.promptsNoOrganization)).toBeInTheDocument();
    expect(within(leaves).getByRole("button", { name: CONNECTIONS_COPY.changeModel })).toBeInTheDocument();
    await user.click(within(empty).getByRole("button", { name: CONNECTIONS_COPY.connectMicrosoft365 }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("names the hosted destination in amber with no organization and opens sample data", async () => {
    const user = userEvent.setup();
    const { activeTenantId: _none, ...state } = createMockAppState({
      tenants: [],
      activeProviderId: "openai",
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
    });
    const bridge = render({ ...state, tenants: [] });
    const leaves = await screen.findByRole("region", { name: CONNECTIONS_COPY.leavesNowHeading });
    const prompts = within(leaves).getByText("OpenAI API · US, through Codex");
    expect(prompts.className).toContain("--color-warning");
    expect(within(leaves).getByText("www.kqlsearch.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: ORGANIZATION_COPY.previewSample }));
    await waitFor(() => expect(bridge.addSampleTenant).toHaveBeenCalled());
  });
});

describe("reach map connectors and layout", () => {
  it("makes only the line that carries prompts to a hosted provider amber", () => {
    const hosted = createMockAppState({
      activeProviderId: "openai",
      tenants: [partialTenant],
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
      installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })],
    });
    const links = reachLinks(buildReachModel(hosted, [teamsConnector()]));
    expect(links.map((link) => [link.id, link.direction, link.tone])).toEqual([
      ["service:intune", "in", "default"],
      ["service:entra", "in", "default"],
      // A missing service is drawn in the border colour, never amber.
      ["service:defender", "in", "missing"],
      ["prompts", "out", "hosted"],
      ["host:www.kqlsearch.com", "out", "default"],
      ["report:Microsoft Teams", "out", "default"],
    ]);
    expect(links.filter((link) => link.tone === "hosted").map((link) => link.id)).toEqual(["prompts"]);
  });

  it("draws no prompts line for a local model", () => {
    const links = reachLinks(buildReachModel(createMockAppState({ tenants: [partialTenant] }), []));
    expect(links.some((link) => link.id === "prompts" || link.tone === "hosted")).toBe(false);
  });

  it("curves each row to the tile and fans the ends 9 px apart at the tile edge", () => {
    const box = { left: 0, right: 900, top: 0, height: 300 };
    const tile = { left: 400, right: 472, top: 100, height: 72 };
    const rows = new Map([
      ["a", { left: 24, right: 300, top: 40, height: 32 }],
      ["b", { left: 24, right: 300, top: 72, height: 32 }],
      ["c", { left: 600, right: 880, top: 40, height: 32 }],
    ]);
    const paths = reachPaths(box, tile, rows, [
      { id: "a", direction: "in", tone: "default" },
      { id: "b", direction: "in", tone: "missing" },
      { id: "c", direction: "out", tone: "hosted" },
    ]);
    expect(paths.map((path) => path.d)).toEqual([
      "M310 56 C352 56, 352 131.5, 394 131.5",
      "M310 88 C352 88, 352 140.5, 394 140.5",
      "M478 136 C534 136, 534 56, 590 56",
    ]);
  });

  it(`stacks the map below ${REACH_STACK_BELOW} px of content width`, () => {
    expect(reachLayout(REACH_STACK_BELOW - 1)).toBe("stacked");
    expect(reachLayout(630)).toBe("stacked");
    expect(reachLayout(REACH_STACK_BELOW)).toBe("wide");
    expect(reachLayout(938)).toBe("wide");
    // Not laid out yet: keep the wide figure.
    expect(reachLayout(0)).toBe("wide");
  });

  it("renders the wide layout with the device tile and its caption", async () => {
    render(createMockAppState({ tenants: [partialTenant] }));
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAttribute("data-layout", "wide");
    expect(map.querySelector(".device-tile")).not.toBeNull();
    expect(within(map).getByText(CONNECTIONS_COPY.map.deviceStays)).toBeInTheDocument();
    expect(within(map).getByText(/^\d of 6 parts$/)).toBeInTheDocument();
  });
});

describe("Connections services", () => {
  it("shows each service as Connected, Partial or Not connected and names what to add", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ tenants: [partialTenant] });
    const addTenantAccess = vi.fn(async () => state);
    render(state, { addTenantAccess });

    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.title("Contoso IT") })).toBeInTheDocument();
    const services = screen.getByRole("region", { name: "Contoso IT services" });
    const rows = within(services).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent(/Intune.*Connected/);
    expect(rows[1]).toHaveTextContent(/Entra.*\d of 6 parts/);
    expect(rows[1]).not.toHaveTextContent("Partial");
    expect(rows[2]).toHaveTextContent(/Defender.*Not connected/);
    // The shared app never offers Check again; consent adds access.
    expect(within(services).queryByRole("button", { name: SERVICE_COPY.checkAgain })).not.toBeInTheDocument();
    expect(within(rows[2]!).getByRole("button", { name: "Add Defender access" })).toHaveTextContent("Connect");

    await user.click(within(rows[2]!).getByRole("button", { name: "Add Defender access" }));
    const dialog = screen.getByRole("dialog", { name: "Add Defender access" });
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() => expect(addTenantAccess).toHaveBeenCalledWith("tenant-1", ["defender.incidents", "defender.score"]));
  });

  it("adds a single missing part from its row", async () => {
    const user = userEvent.setup();
    const tenant = {
      ...partialTenant,
      grantedScopes: [
        ...new Set([
          ...intuneScopes,
          ...SERVICE_PARTS.filter((part) => part.service === "entra" && part.id !== "entra.signins").flatMap((part) => part.scopes.map((scope) => `graph:${scope.name}`)),
        ]),
      ],
    };
    const state = createMockAppState({ tenants: [tenant] });
    const addTenantAccess = vi.fn(async () => state);
    render(state, { addTenantAccess });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    const entra = within(services).getAllByRole("listitem")[1]!;
    // The missing part is a hollow dot that adds it; the button names what it adds.
    expect(within(entra).getByRole("button", { name: SERVICE_COPY.addPartLabel("Entra sign-in logs") })).toHaveTextContent("Sign-in logs");
    expect(within(entra).getByRole("button", { name: "Add Entra access" })).toHaveTextContent("Add sign-in logs");
    await user.click(within(entra).getByRole("button", { name: "Add Entra access" }));
    const dialog = screen.getByRole("dialog", { name: "Add Entra access" });
    expect(within(dialog).getByRole("checkbox", { name: "Sign-in logs" })).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() => expect(addTenantAccess).toHaveBeenCalledWith("tenant-1", ["entra.signins"]));
  });

  it("adds a missing part from its chip", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ tenants: [partialTenant] });
    const addTenantAccess = vi.fn(async () => state);
    render(state, { addTenantAccess });

    await user.click(await screen.findByRole("button", { name: SERVICE_COPY.addPartLabel("Entra sign-in logs") }));
    const dialog = screen.getByRole("dialog", { name: "Add Entra access" });
    expect(within(dialog).getByRole("checkbox", { name: "Sign-in logs" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Conditional Access and policies" })).not.toBeChecked();
  });

  it("lists missing permissions for an own registration with the extend script and Check again", async () => {
    const user = userEvent.setup();
    const clientId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const tenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: { kind: "custom" as const, clientId },
      grantedScopes: ["graph:User.Read.All", "graph:GroupMember.Read.All", "graph:Organization.Read.All"],
    };
    const state = createMockAppState({ tenants: [tenant] });
    const refreshTenantGrants = vi.fn(async () => state);
    const bridge = render(state, { refreshTenantGrants });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    expect(within(services).getByText(/Missing: SecurityAlert\.Read\.All, SecurityIncident\.Read\.All, SecurityEvents\.Read\.All/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: SERVICE_COPY.checkAgain }));
    await waitFor(() => expect(refreshTenantGrants).toHaveBeenCalledWith("tenant-1"));

    await user.click(within(services).getByRole("button", { name: "Add Defender permissions" }));
    const dialog = screen.getByRole("dialog", { name: "Add Defender permissions" });
    await user.click(within(dialog).getByRole("button", { name: "Copy script" }));
    const script = vi.mocked(bridge.writeClipboardText).mock.calls.at(-1)?.[0] ?? "";
    expect(script).toContain(`$clientId = '${clientId}'`);
    expect(script).toContain("'SecurityAlert.Read.All'");
  });

  it("keeps the disconnect confirmation open and surfaces deletion failures", async () => {
    const user = userEvent.setup();
    const disconnectTenant = vi.fn(async () => {
      throw new Error("The local state file could not be written.");
    });
    render(createMockAppState(), { disconnectTenant });

    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    expect(dialog).toHaveTextContent("unassigned, until you assign them to another organization");
    await user.click(within(dialog).getByRole("checkbox", { name: ORGANIZATION_COPY.disconnectConfirmLocal("Contoso IT") }));
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The local state file could not be written.");
    expect(screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ })).toBeInTheDocument();
  });

  it("keeps permissions, rename and disconnect in the Manage menu, with no plain Disconnect button", async () => {
    const user = userEvent.setup();
    const renameOrganization = vi.fn(async (id: string, name: string) => ({
      ...createMockAppState(),
      organizations: [{ id, name, createdAt: "2026-11-01T00:00:00.000Z", connections: { microsoft365: { tenantId: "tenant-1" } } }],
    }));
    render(createMockAppState(), { renameOrganization });
    const manage = await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 });
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Permissions" })).not.toBeInTheDocument();
    expect(screen.getByText("contoso.example, signed in as admin@contoso.example")).toBeInTheDocument();

    await user.click(manage);
    const menu = screen.getByRole("menu", { name: CONNECTIONS_COPY.manageMicrosoft365 });
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      CONNECTIONS_COPY.permissions,
      CONNECTIONS_COPY.renameOrganization,
      CONNECTIONS_COPY.disconnect,
    ]);
    expect(within(menu).getByRole("separator")).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: CONNECTIONS_COPY.renameOrganization }));
    const dialog = screen.getByRole("dialog", { name: CONNECTIONS_COPY.renameOrganization });
    const field = within(dialog).getByRole("textbox", { name: ORGANIZATION_COPY.renameLabel });
    // The dialog keeps focus on the field after the menu hands focus back.
    await waitFor(() => expect(field).toHaveFocus());
    await new Promise((done) => window.requestAnimationFrame(() => done(undefined)));
    await waitFor(() => expect(field).toHaveFocus());
    await user.clear(field);
    await user.type(field, "Contoso");
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.renameSave }));
    await waitFor(() => expect(renameOrganization).toHaveBeenCalledWith("org-tenant-1", "Contoso"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CONNECTIONS_COPY.renameOrganization })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    expect(screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from/ })).toBeInTheDocument();
  });

  it("offers the Marketplace for other services and lists public references with their hosts", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true } }),
    });
    const bridge = render(state);
    expect(await screen.findByText(CONNECTIONS_COPY.addService)).toBeInTheDocument();
    const references = screen.getByRole("region", { name: CONNECTIONS_COPY.referencesHeading });
    expect(within(references).getByText("KQL Search")).toBeInTheDocument();
    expect(within(references).getByText("www.kqlsearch.com")).toBeInTheDocument();
    expect(within(references).queryByText("Microsoft Learn")).not.toBeInTheDocument();
    await user.click(within(references).getByRole("button", { name: `${CONNECTIONS_COPY.referenceTurnOff} KQL Search` }));
    await waitFor(() => expect(bridge.setMcpServerEnabled).toHaveBeenCalledWith("kql-search", false));
  });

  it("says no reference is added when none is installed", async () => {
    render(createMockAppState({ mcpServers: createMockMcpServers() }));
    expect(await screen.findByText(CONNECTIONS_COPY.referencesEmpty)).toBeInTheDocument();
  });

  it("never promises that nothing leaves the device while a delivery rule sends reports (review round 5)", async () => {
    const state = createMockAppState({
      mcpServers: createMockMcpServers(),
      installedAgents: [createMockAgent({ delivery: { slack: { enabled: true, useDefaultChannel: false, channel: "C999" } } })],
    });
    render(state, { listConnectors: vi.fn(async () => [connector("slack", "Slack", "unknown")]) });
    const references = await screen.findByText(CONNECTIONS_COPY.referencesEmpty);
    expect(references).not.toHaveTextContent(/nothing leaves this device/i);
    expect(await screen.findByTestId("result-destinations")).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Slack"]));
  });
});

describe("Connections results and organizations", () => {
  it("opens and closes a connector drawer from its URL", async () => {
    const user = userEvent.setup();
    render(createMockAppState(), { listConnectors: vi.fn(async () => [teamsConnector()]) }, "/connections?connector=teams");
    expect(await screen.findByRole("dialog", { name: "Microsoft Teams" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Microsoft Teams" })).not.toBeInTheDocument());
  });

  it("lists only shipped connectors in Results go to, never planned ones (decision of 2026-11-04)", async () => {
    render(createMockAppState(), { listConnectors: vi.fn(async () => [teamsConnector()]) }, "/connections?connector=jira");
    const results = await screen.findByRole("region", { name: CONNECTIONS_COPY.resultsHeading });
    await waitFor(() => expect(within(results).getByText("Microsoft Teams")).toBeInTheDocument());
    for (const planned of ["Considering", "Planned", "Designed", "View details", "Jira", "ServiceNow", "SharePoint", "Generic webhook"]) {
      expect(within(results).queryByText(planned)).not.toBeInTheDocument();
    }
    // An old link to a planned connector opens nothing.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renames an organization and shows a failed rename next to the field", async () => {
    const user = userEvent.setup();
    const renameOrganization = vi
      .fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos:rename-organization': Error: Enter a name for the organization."))
      .mockImplementationOnce(async (id: string, name: string) => ({
        ...createMockAppState(),
        organizations: [{ id, name, createdAt: "2026-11-01T00:00:00.000Z", connections: { microsoft365: { tenantId: "tenant-1" } } }],
      }));
    render(createMockAppState(), { renameOrganization }, "/connections?view=organizations");

    const list = await screen.findByRole("region", { name: CONNECTIONS_COPY.organizationsHeading });
    await user.click(within(list).getByRole("button", { name: "Rename Contoso IT" }));
    const field = within(list).getByRole("textbox", { name: ORGANIZATION_COPY.renameLabel });
    await user.clear(field);
    await user.type(field, "Contoso");
    await user.click(within(list).getByRole("button", { name: ORGANIZATION_COPY.renameSave }));
    expect(await within(list).findByRole("alert")).toHaveTextContent("The name was not saved. Enter a name for the organization. Try again.");
    await user.click(within(list).getByRole("button", { name: ORGANIZATION_COPY.renameSave }));
    await waitFor(() => expect(renameOrganization).toHaveBeenLastCalledWith("org-tenant-1", "Contoso"));
    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.title("Contoso") })).toBeInTheDocument();
  });

  it("labels the sample organization and keeps its name", async () => {
    const user = userEvent.setup();
    const sample = { ...createMockAppState().tenants[0]!, id: "openadminos-sample-tenant", displayName: "Contoso (pilot)", kind: "sample" as const };
    render(createMockAppState({ tenants: [sample], activeTenantId: sample.id }));
    expect(await screen.findByText(CONNECTIONS_COPY.sampleOrganization)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: CONNECTIONS_COPY.organizationsTab }));
    const list = screen.getByRole("region", { name: CONNECTIONS_COPY.organizationsHeading });
    expect(within(list).getByText(ORGANIZATION_COPY.sampleLabel)).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Rename/ })).not.toBeInTheDocument();
  });

  it("shows each tenant's app registration and removes a saved registration", async () => {
    const user = userEvent.setup();
    const customTenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: { kind: "custom" as const, clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", label: "Contoso admin app" },
    };
    const state = createMockAppState({
      tenants: [customTenant],
      savedAppRegistrations: [
        { clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", label: "Contoso admin app", lastUsedAt: "2026-11-03T10:00:00.000Z" },
        { clientId: "11111111-2222-4333-8444-555555555555", directoryTenantId: "fabrikam.onmicrosoft.com", lastUsedAt: "2026-11-01T10:00:00.000Z" },
      ],
    });
    const bridge = render(state);

    expect(await screen.findByText(/Own app registration · Contoso admin app/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("tab", { name: CONNECTIONS_COPY.organizationsTab }));
    const saved = screen.getByRole("region", { name: SETUP_COPY.savedRegistrationsSettingsTitle });
    expect(within(saved).getByText("fabrikam.onmicrosoft.com")).toBeInTheDocument();
    await user.click(
      within(saved).getByRole("button", { name: SETUP_COPY.removeSavedRegistration("11111111-2222-4333-8444-555555555555") }),
    );
    expect(bridge.removeSavedAppRegistration).toHaveBeenCalledWith("11111111-2222-4333-8444-555555555555", "fabrikam.onmicrosoft.com");
    await waitFor(() => expect(within(saved).queryByText("fabrikam.onmicrosoft.com")).not.toBeInTheDocument());
  });

  it("surfaces a failed removal of a saved registration with a recovery path", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      savedAppRegistrations: [{ clientId: "11111111-2222-4333-8444-555555555555", lastUsedAt: "2026-11-01T10:00:00.000Z" }],
    });
    render(state, {
      removeSavedAppRegistration: vi.fn(async () => {
        throw new Error("The local state file could not be written.");
      }),
    }, "/connections?view=organizations");
    await user.click(await screen.findByRole("button", { name: SETUP_COPY.removeSavedRegistration("11111111-2222-4333-8444-555555555555") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/The saved registration was not removed\. .*Try again\./);
  });
});

describe("Organizations tab", () => {
  const twoOrganizations = () =>
    createMockAppState({
      tenants: [
        createMockAppState().tenants[0]!,
        { ...createMockAppState().tenants[0]!, id: "tenant-2", displayName: "Fabrikam", username: "admin@fabrikam.example" },
      ],
      savedAppRegistrations: [{ clientId: "11111111-2222-4333-8444-555555555555", label: "Fabrikam admin app", lastUsedAt: "2026-11-01T10:00:00.000Z" }],
    });

  it("keeps organizations and saved registrations out of the organization's own view", async () => {
    render(twoOrganizations());
    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.title("Contoso IT") })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Contoso IT" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("region", { name: CONNECTIONS_COPY.organizationsHeading })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: SETUP_COPY.savedRegistrationsSettingsTitle })).not.toBeInTheDocument();
    expect(screen.queryByText("Fabrikam admin app")).not.toBeInTheDocument();
    // The organization switcher adds organizations; the page header does not.
    expect(screen.queryByRole("button", { name: ORGANIZATION_COPY.addOrganization })).not.toBeInTheDocument();
  });

  it("lists every organization and saved registration in the Organizations tab, by keyboard too", async () => {
    const user = userEvent.setup();
    render(twoOrganizations());
    const first = await screen.findByRole("tab", { name: "Contoso IT" });
    first.focus();
    await user.keyboard("{ArrowRight}");
    const tab = screen.getByRole("tab", { name: CONNECTIONS_COPY.organizationsTab });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(tab).toHaveFocus();
    const panel = screen.getByRole("tabpanel", { name: CONNECTIONS_COPY.organizationsTab });
    const list = within(panel).getByRole("region", { name: CONNECTIONS_COPY.organizationsHeading });
    expect(within(list).getByText("Contoso IT")).toBeInTheDocument();
    expect(within(list).getByText("Fabrikam")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: `${CONNECTIONS_COPY.makeActive}, Fabrikam` })).toBeInTheDocument();
    const saved = within(panel).getByRole("region", { name: SETUP_COPY.savedRegistrationsSettingsTitle });
    expect(within(saved).getByText("Fabrikam admin app")).toBeInTheDocument();
    expect(screen.queryByRole("figure", { name: CONNECTIONS_COPY.map.label })).not.toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label })).toBeInTheDocument();
  });

  it("opens the Organizations tab from its URL", async () => {
    render(twoOrganizations(), {}, "/connections?view=organizations");
    expect(await screen.findByRole("tab", { name: CONNECTIONS_COPY.organizationsTab })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("region", { name: CONNECTIONS_COPY.organizationsHeading })).toBeInTheDocument();
  });
});

describe("one destination list for the map and Results (review round 1)", () => {
  it("lists connectors a rule or a step may send to, and names rules with no destination", () => {
    const agents = [
      createMockAgent({ id: "a", slug: "a", delivery: { slack: { enabled: true }, teams: { enabled: true } } }),
      createMockAgent({ id: "b", slug: "b", connectors: [{ id: "discord" }] as never }),
      createMockAgent({ id: "c", slug: "c", delivery: { outlook: { enabled: false } } }),
    ];
    const connectors = [teamsConnector(), connector("discord", "Discord"), connector("slack", "Slack", "needs-setup"), connector("outlook", "Outlook")];
    const destinations = resultDestinations(agents, connectors);
    // Slack's rule uses the default channel and none is saved, so the host sends nothing there.
    expect(reportDestinations(destinations)).toEqual(["Microsoft Teams", "Discord"]);
    expect(targetlessDestinations(destinations)).toEqual(["Slack"]);
    // Before the connector list loads, a saved default channel is not ruled out.
    expect(reportDestinations(resultDestinations(agents, undefined))).toEqual(["Microsoft Teams", "Slack", "Discord"]);
  });

  it("shows the same destinations in the map and the Results section", async () => {
    const state = createMockAppState({
      installedAgents: [
        createMockAgent({ id: "a", slug: "a", delivery: { slack: { enabled: true }, teams: { enabled: true } } }),
        createMockAgent({ id: "b", slug: "b", connectors: [{ id: "discord" }] as never }),
      ],
    });
    render(state, {
      listConnectors: vi.fn(async () => [teamsConnector(), connector("discord", "Discord"), connector("slack", "Slack", "needs-setup")]),
    });
    const results = await screen.findByTestId("result-destinations");
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Microsoft Teams", "Discord"]));
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsUnset(["Slack"]));
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAccessibleDescription(/Run reports and agent messages can go to Microsoft Teams and Discord under saved delivery rules and agent steps\./);
    expect(map).not.toHaveAccessibleDescription(/Slack/);
  });

  it("dedupes reference hosts in the map, its text alternative and the strip", async () => {
    const state = createMockAppState({
      mcpServers: createMockMcpServers({
        "release-communications": { installed: true, enabled: true, host: "www.microsoft.com" },
        "microsoft-learn": { installed: true, enabled: true, host: "www.microsoft.com" },
      }),
    });
    expect(chatToolHosts(state)).toEqual(["www.microsoft.com"]);
    render(state);
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(within(map).getAllByText("www.microsoft.com")).toHaveLength(1);
    expect(map).toHaveAccessibleDescription(/Words from questions go to www\.microsoft\.com\./);
  });
});

describe("map and status strip agree (review rounds 1 and 2)", () => {
  // Every case feeds the same state to the strip's own function and to the
  // reach model; nothing is compared against hard-coded values.
  const unready = mockProviders.map((provider) => (provider.id === "ollama" ? { ...provider, status: "error" as const } : provider));
  const cases: Array<[string, AppState]> = [
    ["local model", createMockAppState({ tenants: [partialTenant] })],
    ["hosted model", createMockAppState({ activeProviderId: "openai", tenants: [partialTenant] })],
    ["no model ready", createMockAppState({ providers: unready })],
    ["hosted model with references", createMockAppState({
      activeProviderId: "openai",
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true }, "microsoft-learn": { installed: true, enabled: true } }),
    })],
    ["no organization", (() => { const { activeTenantId: _none, ...state } = createMockAppState(); return state; })()],
  ];
  for (const [label, state] of cases) {
    it(`names the same model, provider, hosts and services for ${label}`, () => {
      const strip = deriveDataBoundary(state);
      const model = buildReachModel(state);
      expect(model.model.kind).toBe(strip.kind);
      if (strip.kind !== "none") {
        const provider = state.providers.find((entry) => entry.id === state.activeProviderId)!;
        // A hosted strip names where prompts go; a local one names the runtime.
        expect(strip.label).toContain(strip.kind === "hosted" ? model.model.location! : model.model.providerName!);
        expect(model.model.providerName).toBe(provider.name);
        expect(model.model.name).toBe(`${strip.model ?? provider.name}, ${strip.kind}`);
      }
      // The strip names its first host and a count; the map lists the same set.
      expect(model.referenceHosts).toEqual(chatToolHosts(state));
      const stripHosts = strip.kind === "none" ? undefined : strip.toolHosts;
      if (model.referenceHosts.length > 0 && strip.kind !== "none") {
        expect(stripHosts).toBe(deriveToolHostsCopy(model.referenceHosts)?.strip);
      } else {
        expect(stripHosts).toBeUndefined();
      }
      // Services the map reads are the ones the organization switcher marks.
      const tenant = state.tenants.find((entry) => entry.id === state.activeTenantId);
      expect(model.services.filter((service) => service.status !== "missing").map((service) => service.serviceId)).toEqual(
        connectedServiceIds(tenant),
      );
    });
  }

  it("shows the strip's provider in the rendered map next to the rendered strip", async () => {
    const state = createMockAppState({ activeProviderId: "openai", tenants: [partialTenant] });
    renderRoute(
      <AppShell>
        <Connections />
      </AppShell>,
      { path: "*", route: "/connections", bridge: makeMockBridge({}, state) },
    );
    const strip = deriveDataBoundary(state);
    const rendered = await screen.findByRole("status", { name: new RegExp(strip.label) });
    expect(rendered).toHaveAccessibleName(expect.stringContaining(strip.model!));
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAccessibleDescription(new RegExp(`The model is hosted: ${strip.model}, hosted\\.`));
  });
});

describe("hosted channel per provider type (review round 1)", () => {
  it("names a vendor CLI or an API, never a CLI for an API provider", () => {
    expect(hostedChannel({ id: "anthropic", name: "Anthropic" })).toBe("the Claude Code CLI to Anthropic");
    expect(hostedChannel({ id: "openai", name: "OpenAI Codex" })).toBe("the Codex CLI to OpenAI");
    expect(hostedChannel({ id: "azure-openai", name: "Azure OpenAI" })).toBe("the Azure OpenAI API to your deployment");
    expect(hostedChannel({ id: "azure-openai", name: "Azure OpenAI" })).not.toMatch(/CLI/);
  });

  it("shows the Azure OpenAI API in the map, not a CLI", () => {
    const azure = { ...mockProviders.find((provider) => provider.id === "azure-openai")!, status: "available" as const, models: ["gpt-4o"], defaultModel: "gpt-4o" };
    const state = createMockAppState({
      activeProviderId: "azure-openai",
      providers: mockProviders.map((provider) => (provider.id === "azure-openai" ? azure : provider)),
    });
    const model = buildReachModel(state);
    expect(reachDescription(model)).toContain("Prompts and tenant data go through the Azure OpenAI API to your deployment.");
    expect(reachDescription(model)).not.toMatch(/CLI/);
  });
});

describe("hosted reach copy with no organization (Muse round 2)", () => {
  it("says prompts and agent context leave and no tenant data is included", async () => {
    const { activeTenantId: _none, ...state } = createMockAppState({ activeProviderId: "openai" });
    const model = buildReachModel(state);
    const description = reachDescription(model);
    expect(description).toContain("Prompts and agent context go through the Codex CLI to OpenAI. No tenant data is included, because no organization is active.");
    expect(description).not.toContain("tenant data go");
    render(state);
    const leaves = await screen.findByRole("region", { name: CONNECTIONS_COPY.leavesNowHeading });
    expect(within(leaves).getByText(CONNECTIONS_COPY.map.promptsNoOrganization)).toBeInTheDocument();
    expect(screen.queryByText(CONNECTIONS_COPY.map.prompts)).not.toBeInTheDocument();
  });

  it("keeps the tenant wording when an organization is active", () => {
    const description = reachDescription(buildReachModel(createMockAppState({ activeProviderId: "openai" })));
    expect(description).toContain("Prompts and tenant data go through the Codex CLI to OpenAI.");
    expect(description).not.toContain("No tenant data is included");
  });
});

describe("report destinations while connectors load (Muse round 2)", () => {
  it("says the destinations are being checked until the connector list resolves", async () => {
    let resolve!: (value: ConnectorSummary[]) => void;
    const pending = new Promise<ConnectorSummary[]>((done) => (resolve = done));
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })] });
    render(state, { listConnectors: vi.fn(() => pending) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(within(map).getByText(CONNECTIONS_COPY.map.reportsLoading)).toBeInTheDocument();
    expect(map).toHaveAccessibleDescription(new RegExp(CONNECTIONS_COPY.map.reportsLoadingSentence));
    expect(map).not.toHaveAccessibleDescription(/Run reports and agent messages go nowhere/);
    resolve([teamsConnector()]);
    await waitFor(() => expect(within(map).getByText("Microsoft Teams")).toBeInTheDocument());
    expect(within(map).queryByText(CONNECTIONS_COPY.map.reportsLoading)).not.toBeInTheDocument();
  });

  it("says the destinations could not be checked when the connector list fails", async () => {
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })] });
    render(state, { listConnectors: vi.fn(async () => { throw new Error("The connector list could not be read."); }) });
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    await waitFor(() => expect(within(map).getByText(CONNECTIONS_COPY.map.reportsFailed)).toBeInTheDocument());
    expect(map).not.toHaveAccessibleDescription(/Run reports and agent messages go nowhere/);
  });

  it("reports nowhere only once the list is known", () => {
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { slack: { enabled: true } } })] });
    expect(buildReachModel(state).reportDestinations).toBeNull();
    expect(buildReachModel(state, []).reportDestinations).toEqual([]);
  });
});

describe("destinations follow what the host sends (review round 4)", () => {
  it("lists Slack for a saved token with no global configuration and a channel on the agent rule", async () => {
    const state = createMockAppState({
      installedAgents: [createMockAgent({ delivery: { slack: { enabled: true, useDefaultChannel: false, channel: "C999" } } })],
    });
    render(state, { listConnectors: vi.fn(async () => [connector("slack", "Slack", "unknown")]) });
    const results = await screen.findByTestId("result-destinations");
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Slack"]));
    expect(results).not.toHaveTextContent(CONNECTIONS_COPY.resultsNone);
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(within(map).getByText("Slack")).toBeInTheDocument();
    expect(map).toHaveAccessibleDescription(/Run reports and agent messages can go to Slack/);
  });

  it("keeps a connector with a stale error or needs-setup status in the list", () => {
    const agents = [createMockAgent({ delivery: { slack: { enabled: true }, discord: { enabled: true } } })];
    const destinations = resultDestinations(agents, [
      connector("slack", "Slack", "error", { defaultChannel: "C123" }),
      connector("discord", "Discord", "needs-setup"),
    ]);
    expect(reportDestinations(destinations)).toEqual(["Slack", "Discord"]);
    expect(targetlessDestinations(destinations)).toEqual([]);
  });
});

describe("hosted voice in the map (review round 5)", () => {
  it("shows hosted Nova voice as leaving the device while the Chat model stays local, like the strip", () => {
    const state = createMockAppState({ mcpServers: createMockMcpServers() });
    const strip = deriveDataBoundary(state, true);
    expect(strip.isVoiceHosted).toBe(true);
    const model = buildReachModel(state, [], true);
    // The provider is structured data on the boundary, never parsed from its label (Muse round 6).
    expect(strip.kind === "hosted" ? strip.voiceProvider : undefined).toBe("OpenAI");
    expect(model.voice?.provider).toBe("OpenAI");
    expect(reachDescription(model)).toContain(CONNECTIONS_COPY.map.voiceSentence(model.voice!.provider));
    const quiet = buildReachModel(state, [], false);
    expect(quiet.voice).toBeUndefined();
    expect(reachDescription(quiet)).not.toContain("Nova voice");
  });
});

describe("saving a Teams default updates every disclosure (review round 7)", () => {
  it("lists Microsoft Teams in the map and Results after the first default team and channel are saved", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ installedAgents: [createMockAgent({ delivery: { teams: { enabled: true } } })] });
    let saved: Record<string, unknown> = {};
    render(
      state,
      {
        listConnectors: vi.fn(async () => [connector("teams", "Microsoft Teams", "connected", saved)]),
        listConnectorTeams: vi.fn(async () => [{ id: "team-1", displayName: "IT Ops" }] as never),
        listConnectorChannels: vi.fn(async () => [{ id: "channel-1", displayName: "Device alerts" }] as never),
        setConnectorConfig: vi.fn(async (_id: string, config: Record<string, unknown>) => {
          saved = { ...saved, ...config };
        }) as never,
      },
      "/connections?connector=teams",
    );
    const results = await screen.findByTestId("result-destinations");
    expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsUnset(["Microsoft Teams"]));
    const team = await screen.findByRole("combobox", { name: "Team" });
    await waitFor(() => expect(within(team).getByRole("option", { name: "IT Ops" })).toBeInTheDocument());
    await user.selectOptions(team, "team-1");
    const channel = screen.getByRole("combobox", { name: "Channel" });
    await waitFor(() => expect(within(channel).getByRole("option", { name: "Device alerts" })).toBeInTheDocument());
    await user.selectOptions(channel, "channel-1");
    await waitFor(() => expect(results).toHaveTextContent(CONNECTIONS_COPY.resultsSent(["Microsoft Teams"])), { timeout: 3000 });
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAccessibleDescription(/Run reports and agent messages can go to Microsoft Teams/);
  });
});

describe("disconnect confirmation (enterprise round)", () => {
  it("names what is deleted and what stays in Entra, links the revoke steps, and needs explicit consent to delete local data", async () => {
    const user = userEvent.setup();
    const disconnectTenant = vi.fn(async () => createMockAppState({ tenants: [] }));
    const bridge = render(createMockAppState(), { disconnectTenant });
    await user.click(await screen.findByRole("button", { name: CONNECTIONS_COPY.manageMicrosoft365 }));
    await user.click(screen.getByRole("menuitem", { name: CONNECTIONS_COPY.disconnect }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    for (const item of ORGANIZATION_COPY.disconnectDeletes) expect(dialog).toHaveTextContent(item);
    expect(dialog).toHaveTextContent("The OpenAdminOS enterprise application and the admin consent granted to it stay in the tenant.");
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectRevokeLink }));
    expect(bridge.openExternal).toHaveBeenCalledWith("https://docs.openadminos.com/trust-model/authentication#disconnecting-and-revoking");
    const confirm = within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByRole("checkbox", { name: ORGANIZATION_COPY.disconnectConfirmLocal("Contoso IT") }));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(disconnectTenant).toHaveBeenCalledWith("tenant-1"));
  });
});
