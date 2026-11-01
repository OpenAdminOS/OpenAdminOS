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
import { FirstLaunchWelcome } from "./WelcomeView";
import { WELCOME_COPY } from "../copy";
import { PILOT_COPY } from "../shared/pilot-mode";

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

  it("shows the OpenAdminOS enterprise application summary alongside a pending intent", async () => {
    writePendingIntent(
      createPendingIntent({ kind: "view-changes", returnTo: "/changes" }),
    );
    const tenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: {
        kind: "openadminos" as const,
        clientId: "11111111-2222-4333-8444-555555555555",
      },
    };
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge(
        { getRequestedScopes: vi.fn(() => new Promise<never>(() => undefined)) },
        createMockAppState({ tenants: [tenant] }),
      ),
    });

    expect(
      await screen.findByText(/The enterprise application OpenAdminOS \(app ID 11111111-2222-4333-8444-555555555555\)/),
    ).toHaveTextContent("with delegated Microsoft Graph permissions, all read-only");
    expect(screen.queryByText(/with 3 delegated Microsoft Graph permissions/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Your original action is ready\. Continuing sends it through the normal tenant/),
    ).toBeInTheDocument();
  });

  it("shows the custom registration summary alongside a pending intent", async () => {
    writePendingIntent(
      createPendingIntent({ kind: "view-changes", returnTo: "/changes" }),
    );
    const tenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: {
        kind: "custom" as const,
        clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      },
    };
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({ tenants: [tenant] })),
    });

    expect(
      await screen.findByText(
        "Signed in with your app registration aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Your original action is ready\. Continuing sends it through the normal tenant/),
    ).toBeInTheDocument();
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

  it("treats a configured Azure provider at available as ready, matching the host", async () => {
    const providers = mockProviders.map((provider) =>
      provider.id === "azure-openai"
        ? { ...provider, status: "available" as const, models: ["gpt-4o"], defaultModel: "gpt-4o" }
        : provider,
    );
    writePendingIntent(
      createPendingIntent({
        kind: "agent-run",
        slug: "device-offboard",
        providerId: "azure-openai",
        model: "gpt-4o",
        returnTo: "/runs/run-1",
      }),
    );
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({}, createMockAppState({ activeProviderId: "azure-openai", providers })),
    });

    expect(
      await screen.findByRole("heading", { name: "Tenant connected" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pick an LLM provider" })).not.toBeInTheDocument();
  });

  it("connects with the OpenAdminOS registration by default", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async () => createMockAppState());
    renderWelcome(makeMockBridge({ connectTenant }, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );
    // No options means the default app identity.
    expect(connectTenant).toHaveBeenCalledWith(undefined);
  });

  it("shows the loaded delegated permission count after an OpenAdminOS connection", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const tenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: {
        kind: "openadminos" as const,
        clientId: "11111111-2222-4333-8444-555555555555",
      },
    };
    const connectedState = createMockAppState({ tenants: [tenant] });
    const bridge = makeMockBridge(
      {
        getRequestedScopes: vi.fn(async () => [
          { name: "Device.Read.All", mode: "read" as const, rationale: "Read devices" },
          { name: "User.Read.All", mode: "read" as const, rationale: "Read users" },
        ]),
        connectTenant: vi.fn(async () => connectedState),
      },
      emptyState,
    );
    renderWelcome(bridge);

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );

    expect(
      await screen.findByText(/with 5 delegated Microsoft Graph permissions, all read-only/),
    ).toBeInTheDocument();
    expect(screen.queryByText(PILOT_COPY.removedAfterConnect)).not.toBeInTheDocument();
  });

  it("connects with a custom app registration when the admin supplies one", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async () => createMockAppState());
    renderWelcome(makeMockBridge({ connectTenant }, emptyState));

    await user.click(
      await screen.findByRole("button", { name: WELCOME_COPY.ownRegistrationLink }),
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
    renderWelcome(makeMockBridge({}, emptyState));
    await user.click(
      await screen.findByRole("button", { name: WELCOME_COPY.ownRegistrationLink }),
    );
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "No client secret is used. OpenAdminOS signs in as a public client (Authorization Code with PKCE), so there is no secret to store on this device.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the full-window welcome when a launch has no tenants", async () => {
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({}, emptyState));

    expect(
      await screen.findByRole("heading", { level: 1, name: "Welcome to OpenAdminOS" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Start in pilot mode", "Connect your tenant"]);
    expect(screen.getByRole("button", { name: "Start pilot mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect tenant" })).toBeInTheDocument();
    expect(
      screen.getByText("Read-only by default. Write actions always ask for your confirmation."),
    ).toBeInTheDocument();
  });

  it("opens setup on the permissions stage from the Connect card", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({}, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    expect(
      await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve and continue to Microsoft" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Application \(client\) ID/i)).not.toBeInTheDocument();
  });

  it("starts pilot mode from the welcome and leaves the welcome", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const addSampleTenant = vi.fn(async () => pilotState());
    const bridge = makeMockBridge({ addSampleTenant }, emptyState);
    renderWelcome(bridge);

    await user.click(await screen.findByRole("button", { name: "Start pilot mode" }));

    await waitFor(() => expect(addSampleTenant).toHaveBeenCalledOnce());
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Welcome to OpenAdminOS" })).not.toBeInTheDocument();
  });

  it("leaves the guest shell when the admin skips the welcome", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({}, emptyState));

    await user.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByText("App content")).toBeInTheDocument();
  });

  it("does not show the welcome when a tenant is already connected", async () => {
    renderWelcome();

    await screen.findByText("App content");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByRole("heading", { name: "Welcome to OpenAdminOS" }),
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
    renderWelcome(makeMockBridge({}, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Pick an LLM provider" }),
    ).toBeInTheDocument();
  });

  it("says pilot data was removed after connecting from pilot mode", async () => {
    const user = userEvent.setup();
    const connectedState = createMockAppState();
    const bridge = makeMockBridge(
      { connectTenant: vi.fn(async () => connectedState) },
      pilotState(),
    );
    renderWithAppState(<OpenSetupButton />, { route: "/chat", bridge });

    await user.click(await screen.findByRole("button", { name: "Open setup" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve and continue to Microsoft" }),
    );
    expect(await screen.findByText(PILOT_COPY.removedAfterConnect)).toBeInTheDocument();
  });

  it("does not ask for a provider before pilot agent runs", async () => {
    const user = userEvent.setup();
    const providers = mockProviders.map((provider) => ({
      ...provider,
      status: "error" as const,
    }));
    const onReady = vi.fn();
    renderWithAppState(<RequireProviderButton onReady={onReady} />, {
      route: "/agents",
      bridge: makeMockBridge({}, { ...pilotState(), providers }),
    });

    await user.click(await screen.findByRole("button", { name: "Run agent" }));
    expect(onReady).toHaveBeenCalledOnce();
    expect(screen.queryByRole("heading", { name: "Pick an LLM provider" })).not.toBeInTheDocument();
  });
});

function renderWelcome(bridge?: ReturnType<typeof makeMockBridge>) {
  return renderWithAppState(
    <FirstLaunchWelcome>
      <div>App content</div>
    </FirstLaunchWelcome>,
    { route: "/chat", ...(bridge ? { bridge } : {}) },
  );
}

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

function OpenSetupButton() {
  const { openSetup } = useSetupFlow();
  return <Button onClick={() => openSetup()}>Open setup</Button>;
}

function RequireProviderButton({ onReady }: { onReady: () => void }) {
  const { requireTenantAndProvider } = useSetupFlow();
  return (
    <Button
      onClick={() => {
        if (
          requireTenantAndProvider(
            createPendingIntent({ kind: "agent-run", slug: "find-inactive-devices", returnTo: "/agents" }),
          )
        ) {
          onReady();
        }
      }}
    >
      Run agent
    </Button>
  );
}
