import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Connections, { buildReachModel, deliveryDestinations, reachDescription } from "./Connections";
import {
  createMockAgent,
  createMockAppState,
  createMockMcpServers,
  makeMockBridge,
  mockProviders,
  renderRoute,
} from "../test/test-utils";
import { CONNECTIONS_COPY, ORGANIZATION_COPY, SERVICE_COPY, SETUP_COPY } from "../copy";
import { chatToolHosts } from "../state";
import { SERVICE_PARTS, type AppState } from "../shared/openAdminOS";

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
    const model = buildReachModel(state);
    expect(model.referenceHosts).toEqual(chatToolHosts(state));
    expect(model.referenceHosts).toEqual(["learn.microsoft.com", "www.kqlsearch.com"]);
    expect(model.reportDestinations).toEqual(["Microsoft Teams"]);
    expect(deliveryDestinations(state.installedAgents)).toEqual(["Microsoft Teams"]);
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
    render(state);
    const map = await screen.findByRole("figure", { name: CONNECTIONS_COPY.map.label });
    const description = reachDescription(buildReachModel(state));
    expect(map).toHaveAccessibleDescription(description);
    expect(description).toMatch(
      /^Contoso IT reads Intune, connected, Entra, \d of 6 parts and Defender, not connected into this device\. The model runs on this device: llama3\.1, local\. Words from questions go to www\.kqlsearch\.com\. Run reports go to Microsoft Teams under saved delivery rules\.$/,
    );
    expect(within(map).getByText(CONNECTIONS_COPY.map.promptsLocal)).toBeInTheDocument();
  });

  it("names the hosted provider as the destination of prompts and tenant data", () => {
    const hosted = mockProviders.find((provider) => !provider.isLocal && provider.status === "connected")!;
    const state = createMockAppState({ activeProviderId: hosted.id });
    const model = buildReachModel(state);
    expect(model.model.kind).toBe("hosted");
    expect(reachDescription(model)).toContain(`Prompts and tenant data go to ${hosted.name}.`);
  });

  it("shows No organization with nothing read and a Connect action", async () => {
    const user = userEvent.setup();
    const { activeTenantId: _none, ...state } = createMockAppState({ tenants: [] });
    render({ ...state, tenants: [] });
    expect(await screen.findByRole("heading", { name: CONNECTIONS_COPY.pageTitle })).toBeInTheDocument();
    expect(screen.getByText(CONNECTIONS_COPY.noOrganization)).toBeInTheDocument();
    const map = screen.getByRole("figure", { name: CONNECTIONS_COPY.map.label });
    expect(map).toHaveAccessibleDescription(/^No organization reads no service into this device\./);
    await user.click(screen.getByRole("button", { name: CONNECTIONS_COPY.connectMicrosoft365 }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
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
    expect(rows[1]).toHaveTextContent(/Entra.*Partial/);
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
    expect(entra).toHaveTextContent("Sign-in logs not connected");
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
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain }));
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

    await user.click(await screen.findByRole("button", { name: "Disconnect" }));
    const dialog = screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ });
    expect(dialog).toHaveTextContent("unassigned, until you assign them to another organization");
    await user.click(within(dialog).getByRole("button", { name: ORGANIZATION_COPY.disconnectAction }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The local state file could not be written.");
    expect(screen.getByRole("dialog", { name: /Disconnect Microsoft 365 from Contoso IT/ })).toBeInTheDocument();
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
});

describe("Connections results and organizations", () => {
  it("opens and closes a connector drawer from its URL", async () => {
    const user = userEvent.setup();
    render(createMockAppState(), {}, "/connections?connector=jira");
    expect(await screen.findByRole("dialog", { name: "Jira" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close drawer" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Jira" })).not.toBeInTheDocument());
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
    render(createMockAppState(), { renameOrganization });

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
    const sample = { ...createMockAppState().tenants[0]!, id: "openadminos-sample-tenant", displayName: "Contoso (pilot)", kind: "sample" as const };
    render(createMockAppState({ tenants: [sample], activeTenantId: sample.id }));
    expect(await screen.findByText(CONNECTIONS_COPY.sampleOrganization)).toBeInTheDocument();
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
    });
    await user.click(await screen.findByRole("button", { name: SETUP_COPY.removeSavedRegistration("11111111-2222-4333-8444-555555555555") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/The saved registration was not removed\. .*Try again\./);
  });
});
