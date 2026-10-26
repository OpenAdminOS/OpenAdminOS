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
import { PERMISSION_AREAS } from "../shared/openAdminOS";
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
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
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
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({ connectTenant }, emptyState),
    });

    await user.click(
      await screen.findByRole("button", { name: "Connect your tenant" }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
    );
    expect(connectTenant).toHaveBeenCalledWith({
      permissionAreaIds: PERMISSION_AREAS.map((area) => area.id),
    });
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
    renderWithAppState(<div>App content</div>, { route: "/chat", bridge });

    await user.click(await screen.findByRole("button", { name: "Connect your tenant" }));
    await user.click(
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
    );

    expect(
      await screen.findByText(/with 5 delegated Microsoft Graph permissions, all read-only/),
    ).toBeInTheDocument();
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
        name: "Use your organization's app registration",
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
    await user.click(screen.getByRole("checkbox", { name: "Apps" }));
    await user.click(
      screen.getByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
    );

    expect(connectTenant).toHaveBeenCalledWith({
      permissionAreaIds: ["devices", "directory", "identity", "security"],
      appRegistration: {
        clientId: "d1de0a94-f67a-421d-8804-a235955ffd69",
        directoryTenantId: "contoso.onmicrosoft.com",
      },
    });
  });

  it("locks the required area and updates the approved scope count", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({}, emptyState),
    });

    await user.click(await screen.findByRole("button", { name: "Connect your tenant" }));
    const directory = await screen.findByRole("checkbox", {
      name: "Users, groups, and directory",
    });
    expect(directory).toBeChecked();
    expect(directory).toBeDisabled();
    expect(
      screen.getByText(
        "Required: tenant identity, users, and groups are used by every area.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Approve 21 read scopes and continue to Microsoft",
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Apps" }));
    await user.click(screen.getByRole("checkbox", { name: "Security and sign-ins" }));
    expect(
      screen.getByRole("button", {
        name: "Approve 13 read scopes and continue to Microsoft",
      }),
    ).toBeInTheDocument();
  });

  it("generates, copies, and saves an admin registration script", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const bridge = makeMockBridge({}, emptyState);
    renderWithAppState(<div>App content</div>, { route: "/chat", bridge });

    await user.click(
      await screen.findByRole("button", {
        name: "Use your organization's app registration",
      }),
    );
    const displayName = screen.getByLabelText("Application display name");
    await user.clear(displayName);
    await user.type(displayName, "Contoso's OpenAdminOS");
    await user.click(screen.getByRole("button", { name: "Generate setup script" }));

    const script = screen.getByLabelText("PowerShell setup script");
    expect((script as HTMLTextAreaElement).value).toContain("Contoso''s OpenAdminOS");
    expect(
      (screen.getByLabelText("Message for your admin") as HTMLTextAreaElement).value,
    ).toContain("delegated and read-only");

    await user.click(screen.getByRole("button", { name: "Copy script" }));
    expect(bridge.writeClipboardText).toHaveBeenCalledWith(
      expect.stringContaining("New-MgApplication"),
    );
    await user.click(screen.getByRole("button", { name: "Save script" }));
    expect(bridge.saveTextFile).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestedName: "OpenAdminOS-registration-setup.ps1",
        filters: [{ name: "PowerShell script", extensions: ["ps1"] }],
      }),
    );
    await user.click(screen.getByRole("button", { name: "Copy message" }));
    expect(bridge.writeClipboardText).toHaveBeenLastCalledWith(
      expect.stringContaining("trust-model/authentication"),
    );
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
        name: "Use your organization's app registration",
      }),
    );
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "No client secret is used. OpenAdminOS signs in as a public client (Authorization Code with PKCE), so there is no secret to store on this device.",
      ),
    ).toBeInTheDocument();
  });

  it("opens the first-run choice automatically when a launch has no connected tenants", async () => {
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWithAppState(<div>App content</div>, {
      route: "/chat",
      bridge: makeMockBridge({}, emptyState),
    });

    expect(
      await screen.findByRole("heading", { name: "Choose how to start" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try with sample data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect your tenant" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Use your organization's app registration" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual([
      "Try with sample data",
      "Connect your tenant",
      "Use your organization's app registration",
    ]);
  });

  it("adds sample data from the first-run choice", async () => {
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
    const bridge = makeMockBridge({ addSampleTenant }, emptyState);
    renderWithAppState(<div>App content</div>, { route: "/chat", bridge });

    await user.click(
      await screen.findByRole("button", { name: "Try with sample data" }),
    );

    await waitFor(() => expect(addSampleTenant).toHaveBeenCalledOnce());
    expect(screen.queryByRole("heading", { name: "Choose how to start" })).not.toBeInTheDocument();
  });

  it("stays contextual when a tenant is already connected", async () => {
    renderWithAppState(<div>App content</div>, { route: "/chat" });

    await screen.findByText("App content");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      screen.queryByRole("heading", { name: "Choose how to start" }),
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
      await screen.findByRole("button", { name: "Connect your tenant" }),
    );
    await user.click(
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Pick an LLM provider" }),
    ).toBeInTheDocument();
  });
});
