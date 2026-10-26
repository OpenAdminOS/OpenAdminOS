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

  it("labels the active sample tenant in the top bar", async () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(
        {},
        createMockAppState({
          tenants: [
            {
              id: "openadminos-sample-tenant",
              kind: "sample",
              displayName: "Contoso (sample data)",
              username: "admin@contoso-sample.invalid",
              homeAccountId: "openadminos-sample-account",
              addedAt: "2026-10-26T12:00:00.000Z",
            },
          ],
          activeTenantId: "openadminos-sample-tenant",
        }),
      ),
    });

    const tenantButton = await screen.findByRole("button", {
        name: /Switch tenant, Contoso \(sample data\)/,
      });
    expect(tenantButton).toBeInTheDocument();
    expect(within(tenantButton).getByText("Sample data")).toBeInTheDocument();
  });

  it("offers sample data from the tenant menu when no tenant exists", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const addSampleTenant = vi.fn(async () =>
      createMockAppState({
        tenants: [
          {
            id: "openadminos-sample-tenant",
            kind: "sample",
            displayName: "Contoso (sample data)",
            username: "admin@contoso-sample.invalid",
            homeAccountId: "openadminos-sample-account",
            addedAt: "2026-10-26T12:00:00.000Z",
          },
        ],
        activeTenantId: "openadminos-sample-tenant",
      }),
    );
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({ addSampleTenant }, emptyState),
    });

    await user.click(await screen.findByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Connect a tenant" }));
    await user.click(screen.getByRole("menuitem", { name: "Try with sample data" }));
    expect(addSampleTenant).toHaveBeenCalledOnce();
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
