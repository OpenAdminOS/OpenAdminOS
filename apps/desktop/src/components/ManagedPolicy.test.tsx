import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import Settings from "../pages/Settings";
import Connections from "../pages/Connections";
import { TenantSetupDialog } from "../setup/TenantSetupDialog";
import { ManagedPolicyNotice } from "./ManagedPolicy";
import { ModelChoiceList } from "./ModelChoiceList";
import { optionsFromProviders } from "../setup/model-choice";
import {
  createMockAppState,
  makeMockBridge,
  mockProviders,
  renderRoute,
  renderWithAppState,
} from "../test/test-utils";
import type { ManagedPolicyStatus } from "../shared/openAdminOS";
import { SETUP_COPY } from "../copy";

const MACHINE = "/Library/Application Support/OpenAdminOS/policy.json";
const files: ManagedPolicyStatus["files"] = [
  { scope: "machine", path: MACHINE, found: true },
  { scope: "user", path: "/Users/admin/Library/Application Support/OpenAdminOS/policy.json", found: false },
];

const lockedOllama: ManagedPolicyStatus = {
  files,
  values: { defaultProvider: "ollama", defaultModel: "llama3.1" },
  sources: { defaultProvider: "machine", defaultModel: "machine" },
  locked: ["defaultProvider", "defaultModel"],
  issues: [],
};

const invalid: ManagedPolicyStatus = {
  files,
  values: {},
  sources: {},
  locked: [],
  issues: [
    {
      scope: "machine",
      path: MACHINE,
      line: 3,
      column: 23,
      key: "defaultProvider",
      message: "\"defaultProvider\" is \"olama\", which is not a provider id. It is not applied.",
    },
  ],
};

describe("IT policy in the renderer", () => {
  it("marks a locked provider and model in Settings and disables changing them", async () => {
    const ollama = mockProviders.find((provider) => provider.id === "ollama")!;
    const state = createMockAppState({
      providers: [ollama],
      activeProviderId: "ollama",
      activeModelByProviderId: { ollama: "llama3.1" },
      managedPolicy: lockedOllama,
    });
    const user = userEvent.setup();
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/providers", bridge: makeMockBridge({}, state) });

    const panel = await screen.findByRole("region", { name: "IT policy" });
    expect(within(panel).getByText("Provider")).toBeInTheDocument();
    expect(within(panel).getAllByText(/Locked/)).toHaveLength(2);
    expect(within(panel).getByText(MACHINE)).toBeInTheDocument();

    const radio = screen.getByRole("radio", { name: "Set Ollama active" });
    expect(radio).toBeChecked();
    expect(radio).toBeDisabled();
    expect(screen.getAllByText("Set by your IT department").length).toBeGreaterThanOrEqual(2);

    await user.click(screen.getByRole("button", { name: "Show details for Ollama" }));
    expect(screen.getByRole("button", { name: "llama3.1" })).toBeDisabled();
  });

  it("names the file, the line and the problem in Settings", async () => {
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/providers",
      bridge: makeMockBridge({}, createMockAppState({ managedPolicy: invalid })),
    });
    const panel = await screen.findByRole("region", { name: "IT policy" });
    const alert = within(panel).getByRole("alert");
    expect(alert).toHaveTextContent("1 problem");
    expect(alert).toHaveTextContent(`${MACHINE}, line 3`);
    expect(alert).toHaveTextContent("\"defaultProvider\" is \"olama\", which is not a provider id.");
    expect(within(panel).getByText("The policy files set no valid setting.")).toBeInTheDocument();
  });

  it("shows the one-time notice until it is dismissed", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({}, createMockAppState({ managedPolicy: invalid }));
    const view = renderWithAppState(<ManagedPolicyNotice />, { bridge });
    const notice = await screen.findByRole("alert", { name: "The IT policy file has a problem" });
    expect(notice).toHaveTextContent(`${MACHINE}, line 3`);
    await user.click(within(notice).getByRole("button", { name: "Dismiss" }));
    expect(bridge.dismissManagedPolicyNotice).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    view.unmount();

    renderWithAppState(<ManagedPolicyNotice />, {
      bridge: makeMockBridge({}, createMockAppState({ managedPolicy: { ...invalid, noticeDismissed: true } })),
    });
    await waitFor(() => expect(bridge.getAppState).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("limits sign-in to a locked registration and keeps it from being removed", async () => {
    const registration = {
      clientId: "aaaaaaaa-1111-2222-3333-444444444444",
      directoryTenantId: "contoso.onmicrosoft.com",
      label: "Contoso IT",
      lastUsedAt: "2026-11-09T12:00:00.000Z",
      managed: true,
    };
    const other = { clientId: "bbbbbbbb-1111-2222-3333-444444444444", label: "Old app", lastUsedAt: "2026-11-01T12:00:00.000Z" };
    renderWithAppState(
      <TenantSetupDialog
        open
        stage="permissions"
        intent={null}
        scopes={[]}
        scopesError={null}
        error={null}
        activeTenant={undefined}
        providers={mockProviders}
        activeProviderId="ollama"
        savedRegistrations={[registration, other]}
        registrationLocked
        onClose={() => undefined}
        onConnect={() => undefined}
        onKeepWaiting={() => undefined}
        onTryAgain={() => undefined}
        onSelectProvider={() => undefined}
        onRecheckProviders={() => undefined}
        onResume={() => undefined}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Your IT department set the app registration for sign-in on this device.")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: "OpenAdminOS app" })).toBeDisabled();
    expect(within(dialog).getByRole("radio", { name: "Your own app registration" })).toBeChecked();
    expect(within(dialog).getByText("Contoso IT")).toBeInTheDocument();
    expect(within(dialog).queryByText("Old app")).not.toBeInTheDocument();
  });

  it("marks the policy registration in Connections without a Remove action when locked", async () => {
    const state = createMockAppState({
      savedAppRegistrations: [
        { clientId: "aaaaaaaa-1111-2222-3333-444444444444", label: "Contoso IT", lastUsedAt: "2026-11-09T12:00:00.000Z", managed: true },
        { clientId: "bbbbbbbb-1111-2222-3333-444444444444", label: "Old app", lastUsedAt: "2026-11-01T12:00:00.000Z" },
      ],
      managedPolicy: {
        files,
        values: { appRegistration: { clientId: "aaaaaaaa-1111-2222-3333-444444444444", label: "Contoso IT" } },
        sources: { appRegistration: "machine" },
        locked: ["appRegistration"],
        issues: [],
      },
    });
    renderRoute(<Connections />, { path: "/connections", route: "/connections?view=organizations", bridge: makeMockBridge({}, state) });
    const list = await screen.findByRole("region", { name: SETUP_COPY.savedRegistrationsSettingsTitle });
    expect(within(list).getByText("Set by your IT department")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Remove.*Contoso IT/ })).not.toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /Remove.*Old app/ })).toBeInTheDocument();
  });

  it("marks a policy-locked provider in the scan's and Chat's model choice", async () => {
    const ollama = mockProviders.find((provider) => provider.id === "ollama")!;
    const state = createMockAppState({ providers: [ollama], activeProviderId: "ollama", managedPolicy: lockedOllama });
    renderWithAppState(
      <ModelChoiceList options={optionsFromProviders([ollama])} selected="ollama" onSelect={() => undefined} />,
      { bridge: makeMockBridge({}, state) },
    );
    const group = await screen.findByRole("radiogroup");
    await waitFor(() => expect(within(group).getByText("Set by your IT department")).toBeInTheDocument());
    expect(within(group).getAllByRole("radio")).toHaveLength(1);
  });
});
