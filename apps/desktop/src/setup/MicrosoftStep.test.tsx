import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation } from "react-router";

import { MICROSOFT_STEP_COPY, MODEL_SCAN_COPY, NOT_CONNECTED_COPY } from "../copy";
import {
  BASELINE_SCOPES,
  partIdsFor,
  requestedScopes,
  type AppState,
  type ModelScanResult,
  type OpenAdminOSApi,
  type TenantRecord,
} from "../shared/openAdminOS";
import { createMockAppState, makeMockBridge, renderWithAppState } from "../test/test-utils";
import { MicrosoftStepButton, ModelScanGate } from "./FirstRunScan";
import { connectedServices, connectedStarters } from "./connected-starters";

const SCAN: ModelScanResult = {
  probes: [{ providerId: "lm-studio", name: "LM Studio", where: "local", target: "localhost:1234", state: "not-found", summary: "Not installed", facts: [], ready: false, models: [] }],
  outcome: { kind: "nothing" }, startedAt: "2026-11-09T09:00:00.000Z", finishedAt: "2026-11-09T09:00:00.100Z" };
const fresh = () => createMockAppState({ tenants: [], activeTenantId: undefined, firstRunScanPending: true });
const qualified = (names: readonly string[]) => names.map((name) => `graph:${name}`);
const intuneTenant = (): TenantRecord => ({
  ...createMockAppState().tenants[0]!,
  id: "tenant-fabrikam",
  displayName: "Fabrikam",
  username: "admin@fabrikam.example",
  grantedScopes: qualified(requestedScopes(partIdsFor(["intune"])).map((scope) => scope.name)),
});

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function bridgeFor(state: AppState, overrides: Partial<OpenAdminOSApi> = {}) {
  return makeMockBridge(
    {
      onModelScanProgress: vi.fn(() => () => undefined),
      startModelScan: vi.fn(async () => SCAN),
      completeFirstRunScan: vi.fn(async () => ({ ...state, firstRunScanPending: undefined })),
      ...overrides,
    },
    state,
  );
}

function renderGate(bridge: OpenAdminOSApi) {
  return renderWithAppState(
    <ModelScanGate>
      <Routes>
        <Route path="*" element={<div>App content<MicrosoftStepButton /><Where /></div>} />
      </Routes>
    </ModelScanGate>,
    { route: "/chat", bridge },
  );
}

/** Leaves the model step the way an admin without a model does, which opens the Microsoft step. */
async function toMicrosoftStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: MODEL_SCAN_COPY.continueWithoutModel }));
  return screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.title });
}

const service = (name: string) => screen.getByRole("checkbox", { name: new RegExp(`^${name}`) });

describe("Connect Microsoft 365, the second onboarding step", () => {
  beforeEach(() => document.documentElement.setAttribute("data-reduced-motion", ""));
  afterEach(() => document.documentElement.removeAttribute("data-reduced-motion"));

  it("follows the model step on a fresh install, with the step indicator and nothing preselected", async () => {
    const user = userEvent.setup();
    const bridge = bridgeFor(fresh());
    renderGate(bridge);

    const steps = await screen.findByRole("list", { name: "Setup steps" });
    expect(within(steps).getByText("Model").closest("li")).toHaveAttribute("aria-current", "step");
    await toMicrosoftStep(user);

    const after = screen.getByRole("list", { name: "Setup steps" });
    expect(within(after).getByText("Microsoft 365").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(after).getByText("Model").closest("li")).toHaveTextContent("Model, done");
    expect(bridge.completeFirstRunScan).toHaveBeenCalledOnce();
    expect(screen.queryByText("App content")).not.toBeInTheDocument();
    for (const name of ["Intune", "Entra", "Defender"]) expect(service(name)).not.toBeChecked();
    expect(screen.getByText(MICROSOFT_STEP_COPY.noneYet)).toBeInTheDocument();
    for (const name of [MICROSOFT_STEP_COPY.signIn, MICROSOFT_STEP_COPY.ownRegistration, MICROSOFT_STEP_COPY.askAdmin]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
    // Every service is dashed on the stage until it is connected.
    expect(document.querySelectorAll(".ms-node[data-state='off']")).toHaveLength(3);
  });

  it("shows the read-only permissions of the services picked, sign-in included", async () => {
    const user = userEvent.setup();
    renderGate(bridgeFor(fresh()));
    await toMicrosoftStep(user);

    await user.click(service("Defender"));
    const defender = requestedScopes(partIdsFor(["defender"]));
    const region = screen.getByRole("region", { name: NOT_CONNECTED_COPY.permissionsSummary(defender.length) });
    expect(within(region).getByText("Defender")).toBeInTheDocument();
    expect(within(region).getByText(BASELINE_SCOPES.join(", "))).toBeInTheDocument();
    expect(region).toHaveTextContent("SecurityIncident.Read.All");
    expect(region).not.toHaveTextContent("DeviceManagementManagedDevices.Read.All");
    expect(document.querySelector(".ms-node[data-service='defender']")).toHaveAttribute("data-state", "picked");

    await user.click(service("Intune"));
    const both = requestedScopes(partIdsFor(["intune", "defender"]));
    expect(screen.getByRole("region", { name: NOT_CONNECTED_COPY.permissionsSummary(both.length) })).toHaveTextContent("DeviceManagementManagedDevices.Read.All");
    expect(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.signIn })).toBeEnabled();

    await user.click(service("Intune"));
    await user.click(service("Defender"));
    expect(screen.getByText(MICROSOFT_STEP_COPY.noneYet)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.signIn })).toBeDisabled();
  });

  it("signs in through the existing connect flow with the picked services and the app choice open, then shows what was connected", async () => {
    const user = userEvent.setup();
    const tenant = intuneTenant();
    const connected = createMockAppState({ tenants: [tenant], activeTenantId: tenant.id });
    const connectTenant = vi.fn(async () => connected);
    renderGate(bridgeFor(fresh(), { connectTenant }));
    await toMicrosoftStep(user);

    await user.click(service("Intune"));
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.signIn }));
    const dialog = await screen.findByRole("dialog");
    // The picked service is preselected; neither app is chosen.
    expect(within(dialog).getByRole("checkbox", { name: "Intune" })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: "OpenAdminOS app" })).not.toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(within(dialog).getByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }));
    await waitFor(() => expect(connectTenant).toHaveBeenCalledWith({ partIds: partIdsFor(["intune"]) }));

    // The step shows the result itself; the dialog closes.
    expect(await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.connectedTitle("Fabrikam") })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const list = screen.getByRole("list", { name: MICROSOFT_STEP_COPY.connected });
    expect(within(list).getByText("Intune")).toBeInTheDocument();
    expect(list).toHaveTextContent("Devices and configuration, Apps");
    // Intune's users and groups part also grants Entra's, so Entra shows as partly connected.
    expect(within(list).getByText(MICROSOFT_STEP_COPY.partial("Entra"))).toBeInTheDocument();
    expect(within(list).queryByText(/Defender/)).not.toBeInTheDocument();
    expect(document.querySelector(".ms-node[data-service='intune']")).toHaveAttribute("data-state", "connected");
    expect(document.querySelector(".ms-node[data-service='defender']")).toHaveAttribute("data-state", "off");
    expect(screen.getByRole("status")).toHaveTextContent("Fabrikam is connected: Intune and Entra.");

    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.openChat }));
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/chat");
  });

  it("opens the connect flow with the own app registration chosen and the picked services preselected", async () => {
    const user = userEvent.setup();
    renderGate(bridgeFor(fresh()));
    await toMicrosoftStep(user);

    await user.click(service("Entra"));
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.ownRegistration }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("radio", { name: /Your own app registration/ })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Entra" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Intune" })).not.toBeChecked();
  });

  it("copies the consent request for an admin, and shows it when the clipboard refuses", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async (_text: string) => undefined);
    renderGate(bridgeFor(fresh(), { writeClipboardText }));
    await toMicrosoftStep(user);

    await user.click(service("Intune"));
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.askAdmin }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledOnce());
    const message = writeClipboardText.mock.calls[0]![0];
    expect(message).toContain("https://login.microsoftonline.com/organizations/v2.0/adminconsent");
    expect(message).toContain("DeviceManagementManagedDevices.Read.All");
    expect(message).toContain("User.Read");
    expect(await screen.findByText(NOT_CONNECTED_COPY.askAdminCopied)).toBeInTheDocument();

    writeClipboardText.mockRejectedValueOnce(new Error("Clipboard unavailable"));
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.askAdmin }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(NOT_CONNECTED_COPY.askAdminFailed);
    expect(within(alert).getByRole("textbox", { name: "Message for an admin" })).toHaveValue(message);
  });

  it("opens Chat from Not now without connecting anything", async () => {
    const user = userEvent.setup();
    const bridge = bridgeFor(fresh());
    renderGate(bridge);
    await toMicrosoftStep(user);

    await user.click(service("Intune"));
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.notNow }));
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/chat");
    expect(bridge.connectTenant).not.toHaveBeenCalled();
  });

  it("names a proxy or offline failure on sign-in in the connect flow, and the step stays", async () => {
    const user = userEvent.setup();
    const failure =
      "Microsoft sign-in could not reach login.microsoftonline.com: this device is offline. No system proxy is set, and OpenAdminOS connected directly. Connect to a network, then try again.";
    const connectTenant = vi.fn(async () => {
      throw new Error(failure);
    });
    renderGate(bridgeFor(fresh(), { connectTenant }));
    await toMicrosoftStep(user);

    await user.click(service("Intune"));
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.signIn }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "OpenAdminOS app" }));
    await user.click(within(dialog).getByRole("button", { name: /Approve \d+ read scopes and continue to Microsoft/ }));
    expect(await within(dialog).findByText(failure)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    await user.click(within(dialog).getAllByRole("button", { name: /^(Close|Cancel)/ })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.title })).toBeInTheDocument();
    expect(service("Intune")).toBeChecked();
  });

  it("is skipped when an organization is already connected", async () => {
    const user = userEvent.setup();
    renderGate(bridgeFor(createMockAppState({ firstRunScanPending: true })));
    await user.click(await screen.findByRole("button", { name: MODEL_SCAN_COPY.continueWithoutModel }));
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: MICROSOFT_STEP_COPY.title })).not.toBeInTheDocument();
  });

  it("opens again from Settings without the step indicator, showing connected services as connected", async () => {
    const user = userEvent.setup();
    const tenant = intuneTenant();
    renderGate(bridgeFor(createMockAppState({ tenants: [tenant], activeTenantId: tenant.id })));

    await user.click(await screen.findByRole("button", { name: MICROSOFT_STEP_COPY.reopen }));
    expect(await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.title })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Setup steps" })).not.toBeInTheDocument();
    expect(service("Intune")).toBeChecked();
    expect(service("Intune")).toBeDisabled();
    expect(service("Defender")).not.toBeChecked();

    await user.click(service("Defender"));
    // Already signed in: only the picked service's permissions, no sign-in scopes.
    const region = screen.getByRole("region", { name: /read-only Microsoft Graph permission/ });
    expect(region).not.toHaveTextContent("offline_access");

    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.notNow }));
    expect(await screen.findByText("App content")).toBeInTheDocument();
  });
});

describe("what a connected organization can answer", () => {
  it("lists connected services with their granted parts, and claims nothing for unrecorded grants or the sample tenant", () => {
    const tenant = intuneTenant();
    expect(connectedServices(tenant).map((entry) => [entry.service.id, entry.status])).toEqual([
      ["intune", "connected"],
      ["entra", "partial"],
    ]);
    expect(connectedServices({ ...tenant, grantedScopes: undefined })).toEqual([]);
    expect(connectedServices({ ...tenant, kind: "sample" })).toEqual([]);
    expect(connectedServices(undefined)).toEqual([]);
  });

  it("offers at most two starters per connected service, from its granted parts", () => {
    const groups = connectedStarters(intuneTenant());
    expect(groups.map((group) => group.service.id)).toEqual(["intune", "entra"]);
    expect(groups[0]!.prompts).toEqual(["Which groups is this policy assigned to?", "Which devices have not synced in 30 days?"]);
    for (const group of groups) expect(group.prompts.length).toBeLessThanOrEqual(2);
  });
});
