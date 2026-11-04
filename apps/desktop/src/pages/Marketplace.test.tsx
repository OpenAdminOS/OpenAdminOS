import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { RegistryAgentSummary } from "../shared/openAdminOS";
import {
  createMockAgent,
  createMockAppState,
  createMockMcpServers,
  makeMockBridge,
  mockTenant,
  renderRoute,
} from "../test/test-utils";
import Marketplace from "./Marketplace";

function registryAgent(overrides: Partial<RegistryAgentSummary> = {}): RegistryAgentSummary {
  const agent = createMockAgent({
    id: "find-inactive-devices",
    slug: "find-inactive-devices",
    name: "Find inactive devices",
    description: "Lists devices that have not checked in.",
    mode: "read",
    scopes: ["DeviceManagementManagedDevices.Read.All"],
  });
  const { installedAt: _installedAt, ...contract } = agent;
  return { ...contract, registryId: agent.slug, ...overrides } as RegistryAgentSummary;
}

const agents = [
  registryAgent(),
  registryAgent({ id: "ca-gap", slug: "ca-gap", registryId: "ca-gap", name: "Conditional Access gaps", description: "Finds users outside MFA policies.", requiresEntraTier: "p2" }),
];

function render(route = "/marketplace", overrides: Parameters<typeof createMockAppState>[0] = {}, bridgeOverrides = {}) {
  const bridge = makeMockBridge(bridgeOverrides, createMockAppState({
    registryAgents: agents,
    installedAgents: [],
    mcpServers: createMockMcpServers(),
    tenants: [{ ...mockTenant, entraTier: "p1" }],
    ...overrides,
  }));
  renderRoute(<Marketplace />, { path: "/marketplace", route, bridge });
  return bridge;
}

describe("Marketplace", () => {
  it("lists the MCP servers and registry agents without prices or commerce", async () => {
    render();
    expect(await screen.findByRole("heading", { name: "Marketplace", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Spotlight" })).toBeInTheDocument();
    const kinds = screen.getByRole("group", { name: "Listing kind" });
    expect(within(kinds).getByRole("button", { name: "Discover" })).toHaveAttribute("aria-pressed", "true");
    expect(within(kinds).getByRole("button", { name: /Agents/ })).toHaveTextContent("2");
    expect(within(kinds).getByRole("button", { name: /MCP tools/ })).toHaveTextContent("3");

    const mcp = screen.getByRole("region", { name: "MCP tools" });
    for (const [name, host] of [["Microsoft Learn", "learn.microsoft.com"], ["KQL Search", "www.kqlsearch.com"], ["IntuneAutomation", "www.intuneautomation.com"]]) {
      const card = within(mcp).getByRole("button", { name: new RegExp(`^${name}, MCP tool`) });
      expect(card).toHaveTextContent(`Sends tool queries to ${host}`);
      expect(card).toHaveTextContent("No sign-in needed");
    }

    const catalog = await screen.findByLabelText("Agent catalog");
    expect(within(catalog).getByText("Find inactive devices")).toBeInTheDocument();
    expect(within(catalog).getByText(/License required/)).toBeInTheDocument();
    expect(screen.getByText("2 of 2 agents")).toBeInTheDocument();

    expect(document.body.textContent).not.toMatch(/EUR|USD|\$\d|trial|Buy licence|per month|checkout|\bFree\b/i);
  });

  it("filters listings by search and switches kinds through the URL", async () => {
    const user = userEvent.setup();
    render();
    await user.type(await screen.findByRole("searchbox", { name: "Search the Marketplace" }), "kql");
    expect(screen.getByRole("heading", { name: 'Results for "kql"' })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^KQL Search, MCP tool/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Microsoft Learn, MCP tool/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Agents" })).not.toBeInTheDocument();

    await user.clear(screen.getByRole("searchbox", { name: "Search the Marketplace" }));
    const kinds = screen.getByRole("group", { name: "Listing kind" });
    await user.click(within(kinds).getByRole("button", { name: /Agents/ }));
    expect(within(kinds).getByRole("button", { name: /Agents/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("region", { name: "MCP tools" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Spotlight" })).not.toBeInTheDocument();
  });

  it("installs an MCP server after an authentication step that names the host", async () => {
    const user = userEvent.setup();
    const bridge = render();
    await user.click(await screen.findByRole("button", { name: /^Microsoft Learn, MCP tool/ }));
    const dialog = await screen.findByRole("dialog", { name: "Microsoft Learn details" });
    expect(within(dialog).getByText("Where queries go")).toBeInTheDocument();
    expect(within(dialog).getAllByText("No sign-in needed").length).toBeGreaterThan(0);

    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(within(dialog).getByText("Authentication")).toBeInTheDocument();
    expect(within(dialog).getByText(/No sign-in needed\. This server is public/)).toBeInTheDocument();
    expect(within(dialog).getByText("No sign-in needed · queries go to learn.microsoft.com")).toBeInTheDocument();
    const install = within(dialog).getByRole("button", { name: "Install" });
    expect(install).toBeDisabled();

    await user.click(within(dialog).getByRole("checkbox", { name: /I reviewed where Microsoft Learn sends tool queries/ }));
    await user.click(install);
    await waitFor(() => expect(bridge.installMcpServer).toHaveBeenCalledWith("microsoft-learn"));
    expect(bridge.installMcpServer).toHaveBeenCalledTimes(1);
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Installed Microsoft Learn. Its tools are available to Chat.");
    expect(within(dialog).getByRole("switch", { name: /Available in Chat/ })).toHaveAttribute("aria-checked", "true");
    expect(within(dialog).getByText("search")).toBeInTheDocument();
  });

  it("shows a designed error with retry when the server is unreachable", async () => {
    const user = userEvent.setup();
    const installMcpServer = vi.fn()
      .mockRejectedValueOnce(new Error("Error invoking remote method 'openadminos:install-mcp-server': Error: Microsoft Learn could not be reached at learn.microsoft.com. Check the network connection, then retry."))
      .mockResolvedValueOnce(createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true } }));
    render("/marketplace?server=microsoft-learn&install=1", {}, { installMcpServer });
    const dialog = await screen.findByRole("dialog", { name: "Microsoft Learn details" });
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Install" }));

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Microsoft Learn could not be installed");
    expect(alert).toHaveTextContent("Microsoft Learn could not be reached at learn.microsoft.com. Check the network connection, then retry. Nothing was installed.");
    expect(alert).not.toHaveTextContent("invoking remote method");

    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(installMcpServer).toHaveBeenCalledTimes(2));
  });

  it("turns an installed server off and uninstalls it", async () => {
    const user = userEvent.setup();
    const bridge = render("/marketplace?server=kql-search", {
      mcpServers: createMockMcpServers({ "kql-search": { installed: true, enabled: true, tools: [
        { name: "search_kql_queries", description: "Search KQL." },
        { name: "huge_tool", description: "Too many params.", unavailable: "Not offered to Chat: its parameter schema is too large to pass to a model, even without descriptions." },
      ] } }),
    });
    const dialog = await screen.findByRole("dialog", { name: "KQL Search details" });
    expect(within(dialog).getByText("search_kql_queries")).toBeInTheDocument();
    expect(within(dialog).getByText(/its parameter schema is too large to pass to a model/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("switch", { name: /Available in Chat/ }));
    await waitFor(() => expect(bridge.setMcpServerEnabled).toHaveBeenCalledWith("kql-search", false));
    await user.click(within(dialog).getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(bridge.uninstallMcpServer).toHaveBeenCalledWith("kql-search"));
    expect(await within(dialog).findByRole("status")).toHaveTextContent("Removed KQL Search. Chat no longer offers its tools.");
  });

  it("says when the selected model is too small for tool use, on the page and on each server card", async () => {
    const notice = "llama3.2:3b is too small for tool use. Chat answers from cached tenant data only and Marketplace tools are off. Use a model of 8B or larger.";
    render("/marketplace", { chatToolUse: { available: false, notice } });
    expect(await screen.findByRole("note")).toHaveTextContent(notice);
    const mcp = screen.getByRole("region", { name: "MCP tools" });
    for (const name of ["Microsoft Learn", "KQL Search", "IntuneAutomation"]) {
      expect(within(mcp).getByRole("button", { name: new RegExp(`^${name}, MCP tool`) })).toHaveTextContent(notice);
    }
  });

  it("keeps the Marketplace browsable in pilot mode with MCP install but no agent install", async () => {
    const user = userEvent.setup();
    render("/marketplace", {
      tenants: [{ ...mockTenant, id: "openadminos-sample-tenant", kind: "sample", displayName: "Contoso (pilot)" }],
      activeTenantId: "openadminos-sample-tenant",
    });
    const catalog = await screen.findByLabelText("Agent catalog");
    expect(within(catalog).queryByRole("button", { name: "Install" })).not.toBeInTheDocument();
    expect(within(catalog).getAllByRole("button", { name: "Details" })).toHaveLength(2);
    expect(screen.getByText("Agent install is available in production. Connect your tenant to use it.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^IntuneAutomation, MCP tool/ }));
    const dialog = await screen.findByRole("dialog", { name: "IntuneAutomation details" });
    expect(within(dialog).getByRole("button", { name: "Install" })).toBeEnabled();
  });
});
