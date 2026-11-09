import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  createAwaitingConfirmationRun,
  createMockAppState,
  createMockMcpServers,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";
import { DataBoundaryProvider, useDataBoundary } from "../state";
import { AppShell } from "./AppShell";
import { SAMPLE_DATA_REMOVED_NOTICE } from "../copy";

describe("shell chrome", () => {
  it("says once that the sample data was removed by the upgrade", async () => {
    const dismissSampleDataRemovedNotice = vi.fn(async () => createMockAppState());
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({ dismissSampleDataRemovedNotice }, createMockAppState({ sampleDataRemoved: true })),
    });
    expect(await screen.findByText(SAMPLE_DATA_REMOVED_NOTICE)).toBeInTheDocument();
    await waitFor(() => expect(dismissSampleDataRemovedNotice).toHaveBeenCalledOnce());
  });

  it("keeps the organization, model boundary, and running work visible without a status strip", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(
        {},
        createMockAppState({
          runs: [
            createAwaitingConfirmationRun({
              id: "run-active",
              status: "running",
              origin: undefined,
              external: undefined,
            }),
          ],
        }),
      ),
    });

    expect(await screen.findByRole("button", { name: /Switch organization, Contoso IT/ })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /Local · Ollama.*llama3.1/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 run in progress" })).toHaveAttribute("href", "/runs");
    expect(screen.queryByRole("contentinfo", { name: /Current organization/ })).not.toBeInTheDocument();
  });

  it("shows an honest hosted destination and the nightly brand tag", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(
        {},
        createMockAppState({
          activeProviderId: "openai",
          appVersion: "0.7.1-nightly.20261023141500",
        }),
      ),
    });

    expect(
      await screen.findByRole("status", { name: /Hosted · Codex · location set by your account.*gpt-5/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nightly")).toBeInTheDocument();
  });

  it("says nothing leaves the device with a local model, nothing connected and no reference", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({ tenants: [], activeTenantId: undefined, mcpServers: createMockMcpServers() })),
    });
    expect(
      await screen.findByRole("status", { name: "Local · Ollama · llama3.1 · nothing leaves this device" }),
    ).toBeInTheDocument();
  });

  it("names the hosted provider and its region with nothing connected, before any reference is added", async () => {
    const user = userEvent.setup();
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({ tenants: [], activeTenantId: undefined, activeProviderId: "openai", mcpServers: createMockMcpServers() })),
    });
    const status = await screen.findByRole("status", { name: "Hosted · Codex · location set by your account · gpt-5" });
    await user.hover(status);
    expect(
      await screen.findByText(/^Prompts leave this device through Codex; location set by your account\. No organization is active, so no tenant data is sent\. Codex sends prompts to OpenAI/),
    ).toBeInTheDocument();
  });

  it("names the hosts that receive MCP tool queries, also with a local model", async () => {
    const user = userEvent.setup();
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({
        mcpServers: createMockMcpServers({
          "microsoft-learn": { installed: true, enabled: true },
          "kql-search": { installed: true, enabled: true },
          intuneautomation: { installed: true, enabled: false },
        }),
      })),
    });

    const status = await screen.findByRole("status", { name: /Local · Ollama · llama3\.1 · tool queries to learn\.microsoft\.com \+1/ });
    await user.hover(status);
    const tooltip = await screen.findByText(/Words from that question can be sent to learn\.microsoft\.com and www\.kqlsearch\.com\./);
    expect(tooltip).toHaveTextContent("Ollama using llama3.1. The model, Graph and cache data, and chat history stay on this device. MCP queries are written from your current question only, never from Graph or cache data. Words from that question can be sent to learn.microsoft.com and www.kqlsearch.com. A filter blocks known tenant names, IDs, email addresses and IP addresses, but cannot guarantee it catches every private detail.");
    expect(tooltip.textContent).not.toMatch(/prompts, and chat history stay/);
    expect(screen.queryByText(/www\.intuneautomation\.com/)).not.toBeInTheDocument();
  });

  it("names the second-wave hosts while their servers are on", async () => {
    const user = userEvent.setup();
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({
        mcpServers: createMockMcpServers({
          "release-communications": { installed: true, enabled: true },
          windowsforum: { installed: true, enabled: true },
          "endoflife-ai": { installed: true, enabled: true },
        }),
      })),
    });
    const status = await screen.findByRole("status", { name: /tool queries to www\.microsoft\.com \+2/ });
    await user.hover(status);
    expect(await screen.findByText(/Words from that question can be sent to www\.microsoft\.com, mcp\.windowsforum\.com and mcp\.endoflife\.ai\./)).toBeInTheDocument();
  });

  it("names no host for a server Chat skips because an offered tool is missing", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({
        mcpServers: createMockMcpServers({
          "microsoft-learn": { installed: true, enabled: true },
          "kql-search": { installed: true, enabled: true, offeredTools: ["search_kql_queries"], missingTools: ["search_kql_queries"] },
        }),
      })),
    });
    const status = await screen.findByRole("status", { name: /tool queries to learn\.microsoft\.com/ });
    expect(status.getAttribute("aria-label")).not.toMatch(/\+1|kqlsearch/);
  });

  it("names no MCP hosts when the model is too small to be offered the tools", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({
        mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true } }),
        chatToolUse: { available: false, notice: "llama3.2:3b is too small for tool use. Chat answers from cached tenant data only and Marketplace tools are off. Use a model of 8B or larger." },
      })),
    });
    const status = await screen.findByRole("status", { name: /Local · Ollama/ });
    expect(status.getAttribute("aria-label")).not.toMatch(/tool queries/);
  });

  it("keeps updater errors and recovery in the sidebar", async () => {
    const user = userEvent.setup();
    const checkForUpdatesNow = vi.fn(async () => ({ status: "checking" as const }));
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({
        getUpdateState: vi.fn(async () => ({
          status: "error" as const,
          message: "Update check failed. Network unavailable.",
        })),
        checkForUpdatesNow,
      }),
    });

    expect(await screen.findByRole("alert")).toHaveTextContent("Network unavailable");
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(checkForUpdatesNow).toHaveBeenCalledTimes(1);
  });

  it("keeps organizations selectable when none is active", async () => {
    const user = userEvent.setup();
    const state = {
      ...createMockAppState(),
      activeTenantId: undefined,
    };
    const setActiveOrganization = vi.fn(async () => ({ ...state, activeTenantId: "tenant-1" }));
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({ setActiveOrganization }, state),
    });

    await user.click(
      await screen.findByRole("button", { name: "Choose an organization" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: /Contoso IT/ }));
    expect(setActiveOrganization).toHaveBeenCalledWith("org-tenant-1");
  });

  it("keeps the full navigation and no banner in production", async () => {
    renderRoute(<AppShell><div /></AppShell>, { path: "*", route: "/chat" });
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Agent Team" })).toBeInTheDocument();
    expect(within(primary).getByRole("link", { name: "Changes" })).toBeInTheDocument();
  });

  it("names an own app registration in the organization menu (design round)", async () => {
    const user = userEvent.setup();
    const base = createMockAppState();
    const openAdminOSTenant = {
      ...base.tenants[0]!,
      appRegistration: { kind: "openadminos" as const, clientId: "d1de0a94-f67a-421d-8804-a235955ffd69" },
    };
    const customTenant = {
      ...base.tenants[0]!,
      id: "tenant-2",
      displayName: "Fabrikam",
      appRegistration: {
        kind: "custom" as const,
        clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        authority: "https://login.microsoftonline.com/fabrikam.onmicrosoft.com",
      },
    };
    const legacyTenant = {
      ...base.tenants[0]!,
      id: "tenant-3",
      displayName: "Northwind",
      appRegistration: { kind: "openadminos" as const, clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e" },
    };
    const state = createMockAppState({
      tenants: [openAdminOSTenant, customTenant, legacyTenant],
    });
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, state),
    });

    await user.click(await screen.findByRole("button", { name: /Switch organization/ }));
    // The switcher names only an own app registration; the Organizations tab on Connections shows the details.
    const custom = screen.getByRole("menuitemradio", { name: /Fabrikam/ });
    expect(custom).toHaveTextContent("Own app registration");
    const ours = screen.getByRole("menuitemradio", { name: /Contoso IT/ });
    expect(ours).not.toHaveTextContent(/app registration/i);
    const legacy = screen.getByRole("menuitemradio", { name: /Northwind/ });
    expect(legacy).not.toHaveTextContent(/app registration/i);
  });

  it("offers Add organization and no sample data in the organization menu", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, emptyState),
    });

    await user.click(await screen.findByRole("button", { name: "Add an organization" }));
    expect(screen.getByRole("menuitem", { name: "Add organization" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /sample data/i })).not.toBeInTheDocument();
  });

  it("surfaces organization switch and updater retry failures", async () => {
    const user = userEvent.setup();
    const state = {
      ...createMockAppState(),
      activeTenantId: undefined,
    };
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(
        {
          setActiveOrganization: vi.fn(async () => {
            throw new Error("Tenant activation failed at the host.");
          }),
          getUpdateState: vi.fn(async () => ({
            status: "error" as const,
            message: "Update check failed. Network unavailable.",
          })),
          checkForUpdatesNow: vi.fn(async () => {
            throw new Error("The update service is unavailable.");
          }),
        },
        state,
      ),
    });

    await user.click(
      await screen.findByRole("button", { name: "Choose an organization" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: /Contoso IT/ }));
    expect(await screen.findByText(/Switching organizations failed.*Try again from the organization menu/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText(/The update could not be installed|The update check failed.*Try again from About and updates/),
    ).toBeInTheDocument();
  });

  it("surfaces update status and restart IPC failures with recovery", async () => {
    const loadFailure = renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({
        getUpdateState: vi.fn(async () => {
          throw new Error("Update state IPC failed.");
        }),
      }),
    });
    expect(
      await screen.findByText(/update status could not be loaded.*Try again from About and updates/i),
    ).toBeInTheDocument();
    loadFailure.unmount();

    const user = userEvent.setup();
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({
        getUpdateState: vi.fn(async () => ({ status: "ready" as const })),
        applyUpdateNow: vi.fn(async () => {
          throw new Error("Update install IPC failed.");
        }),
      }),
    });
    await user.click(await screen.findByRole("button", { name: "Restart" }));
    expect(
      await screen.findByText(/update could not be installed.*Try again from About and updates/i),
    ).toBeInTheDocument();
  });

  it("lets an active hosted voice session override a local provider boundary", async () => {
    const user = userEvent.setup();
    renderRoute(
      <DataBoundaryProvider>
        <BoundaryProbe />
      </DataBoundaryProvider>,
      { path: "*", route: "/chat", bridge: makeMockBridge() },
    );

    expect(screen.getByTestId("boundary-kind")).toHaveTextContent("local:Local · Ollama");
    await user.click(screen.getByRole("button", { name: "Start hosted voice" }));
    expect(screen.getByTestId("boundary-kind")).toHaveTextContent(
      "hosted:Voice · OpenAI",
    );
  });
});

function BoundaryProbe() {
  const { boundary, setVoiceHosted } = useDataBoundary();
  return (
    <>
      <div data-testid="boundary-kind">{boundary.kind}:{boundary.label}</div>
      <button type="button" onClick={() => setVoiceHosted(true)}>
        Start hosted voice
      </button>
    </>
  );
}

it("keeps a reference count for the short boundary chip (design round)", async () => {
  const { createMockMcpServers } = await import("../test/test-utils");
  renderRoute(<AppShell><div /></AppShell>, {
    path: "*",
    route: "/chat",
    bridge: makeMockBridge({}, createMockAppState({
      activeProviderId: "openai",
      mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true }, "kql-search": { installed: true, enabled: true } }),
    })),
  });
  const count = await screen.findByTestId("boundary-reference-count");
  expect(count).toHaveTextContent("+2 references");
  // One line at every width: the model and the host list are not drawn, only named.
  expect(screen.queryByTestId("boundary-tool-hosts")).not.toBeInTheDocument();
});

it("keeps the reference count muted in the boundary chip at every width (design round review, Muse V)", async () => {
  const { createMockMcpServers } = await import("../test/test-utils");
  renderRoute(<AppShell><div /></AppShell>, {
    path: "*",
    route: "/chat",
    bridge: makeMockBridge({}, createMockAppState({ mcpServers: createMockMcpServers({ "microsoft-learn": { installed: true, enabled: true } }) })),
  });
  const count = await screen.findByTestId("boundary-reference-count");
  expect(count.className).not.toContain("color-warning");
  expect(count.className).not.toMatch(/hidden/);
});
