import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Button } from "../components/Button";
import {
  createMockAppState,
  makeMockBridge,
  mockProviders,
  renderWithAppState,
} from "../test/test-utils";
import { clearPendingIntent, createPendingIntent, writePendingIntent } from "./pending-intent";
import { useSetupFlow } from "./SetupFlowContext";

function SetupTrigger() {
  const { requireTenant } = useSetupFlow();
  return (
    <Button
      onClick={() =>
        requireTenant(
          createPendingIntent({ kind: "view-changes", returnTo: "/changes" }),
        )
      }
    >
      View changes
    </Button>
  );
}

describe("contextual tenant setup", () => {
  beforeEach(() => clearPendingIntent());

  it("cancels an in-flight browser sign-in and discards the pending action", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const cancelConnectTenant = vi.fn(async () => undefined);
    const connectTenant = vi.fn(() => new Promise<never>(() => undefined));
    const bridge = makeMockBridge(
      { connectTenant, cancelConnectTenant },
      emptyState,
    );
    renderWithAppState(<SetupTrigger />, { route: "/changes", bridge });

    await user.click(await screen.findByRole("button", { name: "View changes" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );
    await user.click(await screen.findByRole("button", { name: "Cancel sign-in" }));

    await waitFor(() => expect(cancelConnectTenant).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("heading", { name: "Connect a Microsoft 365 tenant" }),
    ).not.toBeInTheDocument();
  });

  it("restores a safe pending action after the renderer reloads", async () => {
    writePendingIntent(
      createPendingIntent(
        { kind: "view-changes", returnTo: "/changes" },
        new Date(),
      ),
    );
    renderWithAppState(<div>App content</div>, { route: "/chat" });

    expect(
      await screen.findByRole("heading", { name: "Tenant connected" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Changes" })).toBeInTheDocument();
  });

  it("checks the provider pinned to a restored run instead of the active provider", async () => {
    writePendingIntent(
      createPendingIntent({
        kind: "agent-run",
        slug: "device-offboard",
        providerId: "anthropic",
        model: "claude-sonnet",
        returnTo: "/runs/run-1",
      }),
    );
    renderWithAppState(<div>App content</div>, { route: "/chat" });

    expect(
      await screen.findByRole("heading", { name: "Pick an LLM provider" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Tenant connected" })).not.toBeInTheDocument();
  });

  it("connects with the OpenAdminOS registration by default", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async () => createMockAppState());
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({ connectTenant }, emptyState),
    });

    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );
    // No options means the default app identity.
    expect(connectTenant).toHaveBeenCalledWith(undefined);
  });

  it("connects with a custom app registration when the admin supplies one", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async () => createMockAppState());
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({ connectTenant }, emptyState),
    });

    await user.click(
      await screen.findByRole("button", {
        name: "Connect with your own app registration",
      }),
    );
    await user.type(
      screen.getByLabelText(/Application \(client\) ID/i),
      "d1de0a94-f67a-421d-8804-a235955ffd69",
    );
    await user.type(
      screen.getByLabelText(/Directory \(tenant\) ID/i),
      "contoso.onmicrosoft.com",
    );
    await user.click(
      screen.getByRole("button", { name: "Connect with your own app registration" }),
    );

    expect(connectTenant).toHaveBeenCalledWith({
      appRegistration: {
        clientId: "d1de0a94-f67a-421d-8804-a235955ffd69",
        directoryTenantId: "contoso.onmicrosoft.com",
      },
    });
  });

  it("never asks for a client secret", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({}, emptyState),
    });
    await user.click(
      await screen.findByRole("button", {
        name: "Connect with your own app registration",
      }),
    );
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No client secret is needed or accepted/i)).toBeInTheDocument();
  });

  it("opens setup automatically when a launch has no connected tenants", async () => {
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({}, emptyState),
    });

    expect(
      await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" }),
    ).toBeInTheDocument();
  });

  it("stays contextual when a tenant is already connected", async () => {
    renderWithAppState(<div>App content</div>, { route: "/chat" });

    await screen.findByText("App content");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByRole("heading", { name: "Connect a Microsoft 365 tenant" }),
    ).not.toBeInTheDocument();
  });

  it("continues first-run setup into provider selection when no provider is connected", async () => {
    const user = userEvent.setup();
    const providers = mockProviders.map((provider) => ({
      ...provider,
      status: "available" as const,
    }));
    const emptyState = createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      providers,
    });
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({}, emptyState),
    });

    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Pick an LLM provider" }),
    ).toBeInTheDocument();
  });
});
