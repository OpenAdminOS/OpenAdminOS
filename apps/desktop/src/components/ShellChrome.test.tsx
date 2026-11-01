import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";
import { DataBoundaryProvider, useDataBoundary } from "../state";
import { AppShell } from "./AppShell";
import { PilotProductionOnly } from "./PilotMode";
import { PILOT_COPY } from "../shared/pilot-mode";

function pilotState() {
  return createMockAppState({
    tenants: [
      {
        id: "openadminos-sample-tenant",
        kind: "sample",
        displayName: "Contoso (pilot)",
        username: "admin@contoso-sample.invalid",
        homeAccountId: "openadminos-sample-account",
        addedAt: "2026-10-26T12:00:00.000Z",
      },
    ],
    activeTenantId: "openadminos-sample-tenant",
  });
}

describe("shell chrome", () => {
  it("keeps tenant, model boundary, and running work visible without a status strip", async () => {
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

    expect(await screen.findByRole("button", { name: /Switch tenant, Contoso IT/ })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /Local · Ollama.*llama3.1/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "1 run in progress" })).toHaveAttribute("href", "/runs");
    expect(screen.queryByRole("contentinfo", { name: /Current tenant/ })).not.toBeInTheDocument();
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
      await screen.findByRole("status", { name: /Hosted · OpenAI.*gpt-5/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nightly")).toBeInTheDocument();
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

  it("keeps connected tenants selectable when none is active", async () => {
    const user = userEvent.setup();
    const state = {
      ...createMockAppState(),
      activeTenantId: undefined,
    };
    const setActiveTenant = vi.fn(async () => ({ ...state, activeTenantId: "tenant-1" }));
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({ setActiveTenant }, state),
    });

    await user.click(
      await screen.findByRole("button", { name: "Choose an active tenant" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: /Contoso IT/ }));
    expect(setActiveTenant).toHaveBeenCalledWith("tenant-1");
  });

  it("shows pilot mode chrome: tenant label, banner, and reduced navigation", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, pilotState()),
    });

    const tenantButton = await screen.findByRole("button", {
      name: /Switch tenant, Contoso \(pilot\)/,
    });
    expect(within(tenantButton).getByText("Pilot mode")).toBeInTheDocument();
    const banner = screen.getByRole("region", { name: "Pilot mode" });
    expect(banner).toHaveTextContent(PILOT_COPY.banner);
    expect(within(banner).getByRole("button", { name: "Connect your tenant" })).toBeInTheDocument();
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Agents" })).toBeInTheDocument();
    expect(within(primary).getByRole("link", { name: "Runs" })).toBeInTheDocument();
    expect(within(primary).queryByRole("link", { name: "Agent Team" })).not.toBeInTheDocument();
    expect(within(primary).queryByRole("link", { name: "Changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create workspace" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: PILOT_COPY.boundaryLabel })).toBeInTheDocument();
  });

  it("keeps the full navigation and no banner in production", async () => {
    renderRoute(<AppShell><div /></AppShell>, { path: "*", route: "/chat" });
    const primary = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(primary).getByRole("link", { name: "Agent Team" })).toBeInTheDocument();
    expect(within(primary).getByRole("link", { name: "Changes" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pilot mode" })).not.toBeInTheDocument();
  });

  it("renders the designed production page for a hidden route in pilot mode", async () => {
    renderRoute(
      <PilotProductionOnly feature="Agent Team">
        <div>Team content</div>
      </PilotProductionOnly>,
      { path: "*", route: "/office", bridge: makeMockBridge({}, pilotState()) },
    );
    expect(await screen.findByRole("heading", { name: "Agent Team" })).toBeInTheDocument();
    expect(
      screen.getByText("Agent Team is available in production. Connect your tenant to use it."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect your tenant" })).toBeInTheDocument();
    expect(screen.queryByText("Team content")).not.toBeInTheDocument();
  });

  it("opens pilot mode from the tenant menu", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const addSampleTenant = vi.fn(async () => pilotState());
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({ addSampleTenant }, emptyState),
    });

    await user.click(await screen.findByRole("button", { name: "Connect a tenant" }));
    await user.click(screen.getByRole("menuitem", { name: "Open pilot mode" }));
    expect(addSampleTenant).toHaveBeenCalledOnce();
  });

  it("leaves pilot mode only after a confirm that says what is deleted", async () => {
    const user = userEvent.setup();
    const disconnectTenant = vi.fn(async () =>
      createMockAppState({ tenants: [], activeTenantId: undefined }),
    );
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({ disconnectTenant }, pilotState()),
    });

    await user.click(await screen.findByRole("button", { name: /Switch tenant, Contoso \(pilot\)/ }));
    expect(screen.getByRole("menuitem", { name: "Connect tenant" })).toBeInTheDocument();
    await user.click(screen.getByRole("menuitem", { name: "Leave pilot mode" }));
    expect(await screen.findByText(/This deletes the fictional Contoso tenant from this device, with its pilot runs, chats/)).toBeInTheDocument();
    expect(disconnectTenant).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Leave pilot mode" }));
    expect(disconnectTenant).toHaveBeenCalledWith("openadminos-sample-tenant");
  });

  it("surfaces tenant switch and updater retry failures", async () => {
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
          setActiveTenant: vi.fn(async () => {
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
      await screen.findByRole("button", { name: "Choose an active tenant" }),
    );
    await user.click(screen.getByRole("menuitemradio", { name: /Contoso IT/ }));
    expect(await screen.findByText(/Switching tenants failed.*Try again from the tenant menu/)).toBeInTheDocument();

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
