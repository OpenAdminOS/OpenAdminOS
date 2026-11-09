import { screen, waitFor, within } from "@testing-library/react";
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
import { OPENADMINOS_APP_CLIENT_ID } from "../shared/openAdminOS";

const INTUNE_PARTS = ["intune.people", "intune.devices", "intune.apps"];
import { useSetupFlow } from "./SetupFlowContext";
import { FirstLaunchWelcome } from "./WelcomeView";
import { ORGANIZATION_COPY, PROVIDER_DETECTION_COPY, SETUP_COPY, WELCOME_COPY } from "../copy";
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
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
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
        clientId: OPENADMINOS_APP_CLIENT_ID,
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
      await screen.findByText(new RegExp(`The enterprise application OpenAdminOS \\(app ID ${OPENADMINOS_APP_CLIENT_ID}\\)`)),
    ).toHaveTextContent("with delegated Microsoft Graph permissions, all read-only");
    expect(screen.queryByText(/with 3 delegated Microsoft Graph permissions/)).not.toBeInTheDocument();
    expect(
      screen.getByText(/Your original action is ready\. Continuing sends it through the normal tenant/),
    ).toBeInTheDocument();
  });

  it("names the legacy Graph CLI client instead of OpenAdminOS for a tenant connected before v0.5", async () => {
    writePendingIntent(
      createPendingIntent({ kind: "view-changes", returnTo: "/changes" }),
    );
    const tenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: {
        kind: "openadminos" as const,
        clientId: "14d82eec-204b-4c2f-b7e8-296a70dab67e",
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
      await screen.findByText(
        "Signed in with Microsoft Graph Command Line Tools, client ID 14d82eec-204b-4c2f-b7e8-296a70dab67e.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/The enterprise application OpenAdminOS/)).not.toBeInTheDocument();
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

  it("connects with the OpenAdminOS app once the admin chooses it", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async () => createMockAppState());
    renderWelcome(makeMockBridge({ connectTenant }, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
    );
    expect(connectTenant).toHaveBeenCalledWith({
      partIds: INTUNE_PARTS,
    });
  });

  it("shows the loaded delegated permission count after an OpenAdminOS connection", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const tenant = {
      ...createMockAppState().tenants[0]!,
      appRegistration: {
        kind: "openadminos" as const,
        clientId: OPENADMINOS_APP_CLIENT_ID,
      },
    };
    const connectedState = createMockAppState({ tenants: [tenant] });
    const bridge = makeMockBridge(
      {
        getRequestedScopes: vi.fn(async () => [
          { service: "intune" as const, partId: "intune.devices", name: "Device.Read.All", mode: "read" as const, rationale: "Read devices" },
          { service: "intune" as const, partId: "intune.people", name: "User.Read.All", mode: "read" as const, rationale: "Read users" },
        ]),
        connectTenant: vi.fn(async () => connectedState),
      },
      emptyState,
    );
    renderWelcome(bridge);

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
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
      screen.getByRole("button", { name: SETUP_COPY.ownRegistrationSignIn }),
    );

    expect(connectTenant).toHaveBeenCalledWith({
      appRegistration: {
        clientId: "d1de0a94-f67a-421d-8804-a235955ffd69",
        directoryTenantId: "contoso.onmicrosoft.com",
      },
    });
  });

  it("requires at least one service and counts shared scopes once", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({}, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    for (const name of ["Intune", "Entra", "Defender"]) {
      expect(await screen.findByRole("checkbox", { name })).not.toBeChecked();
    }
    const approve = screen.getByRole("button", { name: /Approve \d+ read scopes/ });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(SETUP_COPY.selectServiceReason);

    await user.click(screen.getByRole("checkbox", { name: "Intune" }));
    expect(
      screen.getByRole("button", { name: "Approve 10 read scopes and continue to Microsoft" }),
    ).toBeEnabled();
    // Entra shares users, groups, organization and Entra devices with Intune.
    await user.click(screen.getByRole("checkbox", { name: "Entra" }));
    expect(
      screen.getByRole("button", { name: "Approve 17 read scopes and continue to Microsoft" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Defender" }));
    expect(
      screen.getByRole("button", { name: "Approve 20 read scopes and continue to Microsoft" }),
    ).toBeInTheDocument();
  });

  it("shows a part another selected service already covers as included", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async () => createMockAppState());
    renderWelcome(makeMockBridge({ connectTenant }, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(screen.getByRole("button", { name: "Review Entra parts and scopes" }));

    const people = screen.getByRole("checkbox", { name: "Entra users and groups" });
    expect(people).toBeChecked();
    expect(people).toBeDisabled();
    expect(people).toHaveAccessibleDescription("Included with Intune");
    const devices = screen.getByRole("checkbox", { name: "Entra devices" });
    expect(devices).toBeChecked();
    expect(devices).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Entra sign-in logs" })).not.toBeChecked();
    // Two of six Entra parts are included, so Entra is partly selected.
    expect(screen.getByRole("checkbox", { name: "Entra" })).toHaveAttribute("aria-checked", "mixed");

    // Selecting all of Entra adds no scope twice, and the request lists explicit parts.
    await user.click(screen.getByRole("checkbox", { name: "Entra" }));
    expect(screen.getByRole("checkbox", { name: "Entra" })).toBeChecked();
    await user.click(
      screen.getByRole("button", { name: "Approve 17 read scopes and continue to Microsoft" }),
    );
    expect(connectTenant).toHaveBeenCalledWith({
      partIds: [
        "intune.people",
        "intune.devices",
        "intune.apps",
        "entra.people",
        "entra.devices",
        "entra.apps",
        "entra.access",
        "entra.policies",
        "entra.signins",
      ],
    });
  });

  it("shows the Intune people part as included when Entra is selected", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({}, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Entra" }));
    await user.click(screen.getByRole("button", { name: "Review Intune parts and scopes" }));

    const people = screen.getByRole("checkbox", { name: "Intune users and groups" });
    expect(people).toBeChecked();
    expect(people).toBeDisabled();
    expect(people).toHaveAccessibleDescription("Included with Entra");
    expect(screen.getByRole("checkbox", { name: "Intune" })).toHaveAttribute("aria-checked", "mixed");
    expect(
      screen.getByRole("button", { name: "Approve 11 read scopes and continue to Microsoft" }),
    ).toBeEnabled();
  });

  it("expands a service to its parts and sends only the chosen parts", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async () => createMockAppState());
    renderWelcome(makeMockBridge({ connectTenant }, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("button", { name: "Review Entra parts and scopes" }));
    // Parts start unselected like their service.
    const signIns = screen.getByRole("checkbox", { name: "Entra sign-in logs" });
    expect(signIns).not.toBeChecked();
    expect(screen.getByText("AuditLog.Read.All")).toBeVisible();
    await user.click(signIns);
    expect(screen.getByRole("checkbox", { name: "Entra" })).toHaveAttribute("aria-checked", "mixed");
    await user.click(screen.getByRole("checkbox", { name: "Entra Conditional Access and policies" }));
    await user.click(
      screen.getByRole("button", { name: "Approve 3 read scopes and continue to Microsoft" }),
    );
    expect(connectTenant).toHaveBeenCalledWith({
      partIds: ["entra.policies", "entra.signins"],
    });
  });

  it("hides the service picker for an own app registration", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({}, emptyState));

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    expect(await screen.findByRole("button", { name: "Review Intune parts and scopes" })).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Your own app registration" }));
    expect(screen.getByText(SETUP_COPY.ownRegistrationServicesNote)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review Intune parts and scopes" })).not.toBeInTheDocument();
    expect(screen.queryByText(/scopes selected/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: SETUP_COPY.ownRegistrationSignIn })).toBeInTheDocument();
  });

  it("generates, copies, and saves an admin registration script", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const bridge = makeMockBridge({}, emptyState);
    renderWelcome(bridge);

    await user.click(
      await screen.findByRole("button", {
        name: "Your organization blocks third-party apps? Use your own app registration.",
      }),
    );
    const displayName = screen.getByLabelText("Application display name");
    await user.click(screen.getByRole("button", { name: "Generate setup script" }));
    expect(screen.getByRole("alert")).toHaveTextContent(SETUP_COPY.selectServiceReason);
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
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
    expect(screen.getByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ })).toBeInTheDocument();
    expect(screen.queryByLabelText(/Application \(client\) ID/i)).not.toBeInTheDocument();
    expectUnchosenSignIn();
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
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
    );

    expect(
      await screen.findByRole("heading", { name: "Pick an LLM provider" }),
    ).toBeInTheDocument();
  });

  it("lists a ready hosted provider first as detected, without selecting it", async () => {
    const user = userEvent.setup();
    // No local provider is ready; only the Codex CLI is signed in.
    const providers = mockProviders.map((provider) =>
      provider.id === "openai"
        ? provider
        : { ...provider, status: provider.isLocal ? ("error" as const) : ("not-installed" as const) },
    );
    const emptyState = createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      activeProviderId: "ollama",
      providers,
    });
    const bridge = makeMockBridge({}, emptyState);
    renderWelcome(bridge);

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(
      await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }),
    );

    const detected = await screen.findByRole("region", { name: PROVIDER_DETECTION_COPY.detectedLabel });
    const openai = providers.find((provider) => provider.id === "openai")!;
    expect(within(detected).getByText(openai.description)).toBeInTheDocument();
    expect(within(detected).queryByText("Anthropic")).not.toBeInTheDocument();
    // Detected first: the section precedes the provider grid.
    const grid = screen.getByRole("button", { name: /Ollama/ });
    expect(detected.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bridge.setActiveProvider).not.toHaveBeenCalled();

    await user.click(within(detected).getByRole("button", { name: PROVIDER_DETECTION_COPY.useDetected("Codex") }));
    await waitFor(() => expect(bridge.setActiveProvider).toHaveBeenCalledWith("openai"));
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
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(
      await screen.findByRole("button", { name: "Approve 10 read scopes and continue to Microsoft" }),
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

  it("opens every connect entry point on two equal, unchosen sign-in choices", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWithAppState(
      <>
        <SetupTrigger />
        <OpenSetupButton />
        <RequireProviderButton onReady={() => undefined} />
      </>,
      { route: "/changes", bridge: makeMockBridge({}, emptyState) },
    );

    for (const name of ["View changes", "Open setup", "Run agent"]) {
      await user.click(await screen.findByRole("button", { name }));
      await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" });
      expectUnchosenSignIn();
      await user.click(screen.getByRole("button", { name: "Cancel" }));
    }
  });

  it("explains each choice and keeps Approve disabled with a visible reason until one is chosen", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    const connectTenant = vi.fn(async (_options?: unknown) => createMockAppState());
    renderWithAppState(<OpenSetupButton />, {
      route: "/chat",
      bridge: makeMockBridge({ connectTenant }, emptyState),
    });
    await user.click(await screen.findByRole("button", { name: "Open setup" }));

    const openAdminOS = await screen.findByRole("radio", { name: "OpenAdminOS app" });
    const own = screen.getByRole("radio", { name: "Your own app registration" });
    expect(openAdminOS).toHaveAccessibleDescription(
      new RegExp(`sign-in logs as OpenAdminOS, client ID ${OPENADMINOS_APP_CLIENT_ID}`),
    );
    expect(openAdminOS).toHaveAccessibleDescription(/No client secret\. Tokens are stored on this device only\./);
    expect(own).toHaveAccessibleDescription(/organization creates and owns/);
    expect(own).toHaveAccessibleDescription(/Conditional Access/);
    expect(own).toHaveAccessibleDescription(/No client secret\. Tokens are stored on this device only\./);

    const approve = await screen.findByRole("button", { name: /Approve \d+ read scopes/ });
    await waitFor(() => expect(approve).toHaveAccessibleDescription(SETUP_COPY.chooseSignInReason));
    expect(screen.getByText(SETUP_COPY.chooseSignInReason)).toBeVisible();

    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(own);
    expect(approve).toBeDisabled();
    expect(screen.getByText(SETUP_COPY.clientIdRequiredReason)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Application \(client\) ID/i), "not-a-guid");
    expect(screen.getByText(SETUP_COPY.clientIdInvalidReason)).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Application \(client\) ID/i));
    await user.type(
      screen.getByLabelText(/Application \(client\) ID/i),
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    expect(approve).toBeEnabled();

    await user.click(openAdminOS);
    expect(approve).toBeEnabled();
    expect(screen.queryByLabelText(/Application \(client\) ID/i)).not.toBeInTheDocument();

    // The custom client ID typed before switching back must not be sent.
    await user.click(approve);
    await waitFor(() => expect(connectTenant).toHaveBeenCalledTimes(1));
    expect(connectTenant).toHaveBeenCalledWith({ partIds: INTUNE_PARTS });
    expect(connectTenant.mock.calls[0]?.[0]).not.toHaveProperty("appRegistration");
  });

  it("opens with the own registration chosen from the welcome link", async () => {
    const user = userEvent.setup();
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({}, emptyState));
    await user.click(
      await screen.findByRole("button", { name: WELCOME_COPY.ownRegistrationLink }),
    );
    expect(await screen.findByRole("radio", { name: "Your own app registration" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "OpenAdminOS app" })).not.toBeChecked();
  });

  it("preselects the most recent saved registration and allows another one", async () => {
    const user = userEvent.setup();
    const connectTenant = vi.fn(async () => createMockAppState());
    const emptyState = createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      savedAppRegistrations: [
        {
          clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          directoryTenantId: "contoso.onmicrosoft.com",
          label: "Contoso admin app",
          lastUsedAt: "2026-11-03T10:00:00.000Z",
        },
        { clientId: "11111111-2222-4333-8444-555555555555", lastUsedAt: "2026-11-01T10:00:00.000Z" },
      ],
    });
    renderWithAppState(<OpenSetupButton />, {
      route: "/chat",
      bridge: makeMockBridge({ connectTenant }, emptyState),
    });
    await user.click(await screen.findByRole("button", { name: "Open setup" }));
    expect(screen.queryByRole("radio", { name: /Contoso admin app/ })).not.toBeInTheDocument();

    await user.click(await screen.findByRole("radio", { name: "Your own app registration" }));
    expect(screen.getByRole("radio", { name: /Contoso admin app/ })).toBeChecked();
    expect(screen.queryByLabelText(/Application \(client\) ID/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: SETUP_COPY.ownRegistrationSignIn }));
    expect(connectTenant).toHaveBeenLastCalledWith({
      appRegistration: {
        clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        directoryTenantId: "contoso.onmicrosoft.com",
        label: "Contoso admin app",
      },
    });
  });

  it("enters a different registration next to saved ones", async () => {
    const user = userEvent.setup();
    const connectTenant = vi.fn(async () => createMockAppState());
    const emptyState = createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      savedAppRegistrations: [
        { clientId: "11111111-2222-4333-8444-555555555555", lastUsedAt: "2026-11-01T10:00:00.000Z" },
      ],
    });
    renderWithAppState(<OpenSetupButton />, {
      route: "/chat",
      bridge: makeMockBridge({ connectTenant }, emptyState),
    });
    await user.click(await screen.findByRole("button", { name: "Open setup" }));
    await user.click(await screen.findByRole("radio", { name: "Your own app registration" }));
    await user.click(screen.getByRole("radio", { name: SETUP_COPY.newRegistrationOption }));
    await user.type(
      screen.getByLabelText(/Application \(client\) ID/i),
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    await user.type(screen.getByLabelText(/Label \(optional\)/), "Fabrikam app");
    await user.click(screen.getByRole("button", { name: SETUP_COPY.ownRegistrationSignIn }));
    expect(connectTenant).toHaveBeenLastCalledWith({
      appRegistration: { clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", label: "Fabrikam app" },
    });
  });

  it("retries and edits a failed sign-in with the same own registration", async () => {
    const user = userEvent.setup();
    const connectTenant = vi.fn(async () => {
      throw new Error("Microsoft could not find your app registration.");
    });
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined });
    renderWelcome(makeMockBridge({ connectTenant }, emptyState));
    await user.click(
      await screen.findByRole("button", { name: WELCOME_COPY.ownRegistrationLink }),
    );
    await user.type(
      screen.getByLabelText(/Application \(client\) ID/i),
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
    await user.click(screen.getByRole("button", { name: SETUP_COPY.ownRegistrationSignIn }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Microsoft could not find your app registration.",
    );
    const expected = {
      appRegistration: { clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    };

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(connectTenant).toHaveBeenCalledTimes(2));
    expect(connectTenant).toHaveBeenNthCalledWith(2, expected);

    await user.click(await screen.findByRole("button", { name: SETUP_COPY.editSignIn }));
    expect(await screen.findByRole("radio", { name: "Your own app registration" })).toBeChecked();
    expect(screen.getByLabelText(/Application \(client\) ID/i)).toHaveValue(
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    );
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

function expectUnchosenSignIn() {
  const openAdminOS = screen.getByRole("radio", { name: "OpenAdminOS app" });
  const own = screen.getByRole("radio", { name: "Your own app registration" });
  expect(openAdminOS).not.toBeChecked();
  expect(own).not.toBeChecked();
  expect(screen.getByRole("button", { name: /Approve \d+ read scopes/ })).toBeDisabled();
  expect(screen.getByText(SETUP_COPY.chooseSignInReason)).toBeInTheDocument();
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

describe("connecting an organization whose disconnect is still cleaning up (Disconnect redesign)", () => {
  beforeEach(() => clearPendingIntent());

  it("shows the designed message with Retry cleanup in the sign-in error", async () => {
    const user = userEvent.setup();
    const pending = { tenantId: "tenant-1", displayName: "Contoso", removedAt: "2026-11-09T10:00:00.000Z", error: "The Microsoft sign-in could not be removed. Locked." };
    const emptyState = createMockAppState({ tenants: [], activeTenantId: undefined, tenantCleanups: [pending] });
    const message = "Disconnecting Contoso has not finished on this device: The Microsoft sign-in could not be removed. Locked. Retry cleanup on Connections, then connect again.";
    const connectTenant = vi.fn(async () => {
      throw new Error(message);
    });
    const bridge = makeMockBridge({ connectTenant }, emptyState);
    renderWelcome(bridge);

    await user.click(await screen.findByRole("button", { name: "Connect tenant" }));
    await user.click(await screen.findByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(await screen.findByRole("checkbox", { name: "Intune" }));
    await user.click(await screen.findByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    const notice = within(dialog).getByRole("region", { name: ORGANIZATION_COPY.cleanupHeading });
    await user.click(within(notice).getByRole("button", { name: `${ORGANIZATION_COPY.retryCleanup}, Contoso` }));
    await waitFor(() => expect(bridge.retryTenantCleanup).toHaveBeenCalledWith("tenant-1"));
  });
});
