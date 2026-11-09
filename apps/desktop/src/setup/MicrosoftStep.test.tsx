import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Route, Routes, useLocation, useNavigate } from "react-router";

import { MICROSOFT_STEP_COPY, MODEL_SCAN_COPY, NOT_CONNECTED_COPY } from "../copy";
import {
  BASELINE_SCOPES,
  OPENADMINOS_APP_CLIENT_ID,
  grantedParts,
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
  appRegistration: { kind: "openadminos", clientId: OPENADMINOS_APP_CLIENT_ID },
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
    // electron/first-run-capture.ts picks services by these ids and leaves by Not now.
    expect(document.querySelector("#microsoft-step-heading")).not.toBeNull();
    for (const id of ["intune", "entra"]) expect(document.querySelector(`#microsoft-step-${id}`)).not.toBeNull();
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
    expect(screen.getByText(/Signed in as admin@fabrikam\.example\. The enterprise application OpenAdminOS \(app ID /)).toBeInTheDocument();

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

describe("Connect Microsoft 365 opened again with a tenant (PR #175 onboarding round review, 1 and 2)", () => {
  beforeEach(() => document.documentElement.setAttribute("data-reduced-motion", ""));
  afterEach(() => document.documentElement.removeAttribute("data-reduced-motion"));
  const defenderParts = partIdsFor(["defender"]);
  const defenderScopes = [...new Set(defenderParts.flatMap((id) => requestedScopes([id]).map((scope) => scope.name)))].filter((name) => !BASELINE_SCOPES.includes(name as never));
  const consentUrl = (message: string) => new URL(message.match(/https:\/\/login\.microsoftonline\.com\S+/)![0]);

  async function reopen(tenant: TenantRecord, overrides: Partial<OpenAdminOSApi> = {}) {
    const user = userEvent.setup();
    const bridge = bridgeFor(createMockAppState({ tenants: [tenant], activeTenantId: tenant.id }), overrides);
    renderGate(bridge);
    await user.click(await screen.findByRole("button", { name: MICROSOFT_STEP_COPY.reopen }));
    await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.title });
    return { user, bridge };
  }

  it("adds a service to a tenant on the shared app through Add access: same tenant, only the missing scopes, no new sign-in", async () => {
    const tenant = intuneTenant();
    const withDefender = { ...tenant, grantedScopes: [...tenant.grantedScopes!, ...defenderScopes.map((name) => `graph:${name}`)] };
    const addTenantAccess = vi.fn(async () => createMockAppState({ tenants: [withDefender], activeTenantId: tenant.id }));
    const connectTenant = vi.fn(async () => createMockAppState());
    const writeClipboardText = vi.fn(async (_text: string) => undefined);
    const { user } = await reopen(tenant, { addTenantAccess, connectTenant, writeClipboardText });

    await user.click(service("Defender"));
    // The step lists only what it asks for: no sign-in scopes for a tenant that is signed in.
    const region = screen.getByRole("region", { name: NOT_CONNECTED_COPY.permissionsSummary(defenderScopes.length) });
    expect(region).not.toHaveTextContent("offline_access");
    expect(screen.queryByRole("button", { name: MICROSOFT_STEP_COPY.signIn })).toBeNull();
    expect(screen.queryByRole("button", { name: MICROSOFT_STEP_COPY.ownRegistration })).toBeNull();

    // Ask an admin: consent for the shared app in this tenant, not /organizations.
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.askAdmin }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledOnce());
    const url = consentUrl(writeClipboardText.mock.calls[0]![0]);
    expect(url.pathname).toBe(`/${tenant.id}/v2.0/adminconsent`);
    expect(url.searchParams.get("client_id")).toBe(OPENADMINOS_APP_CLIENT_ID);
    for (const name of defenderScopes) expect(url.searchParams.get("scope")).toContain(`https://graph.microsoft.com/${name}`);

    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.addAccess }));
    const dialog = await screen.findByRole("dialog", { name: /Add Defender access/ });
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() => expect(addTenantAccess).toHaveBeenCalledWith(tenant.id, defenderParts));
    expect(connectTenant).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.connectedTitle("Fabrikam") })).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: MICROSOFT_STEP_COPY.connected })).getByText("Defender")).toBeInTheDocument();
  });

  it("adds a service to a tenant on its own registration through the extend script and Check again, and asks an admin for that client", async () => {
    const ownClientId = "11111111-2222-3333-4444-555555555555";
    const tenant: TenantRecord = { ...intuneTenant(), appRegistration: { kind: "custom", clientId: ownClientId } };
    const withDefender = { ...tenant, grantedScopes: [...tenant.grantedScopes!, ...defenderScopes.map((name) => `graph:${name}`)] };
    const refreshTenantGrants = vi.fn(async () => createMockAppState({ tenants: [withDefender], activeTenantId: tenant.id }));
    const addTenantAccess = vi.fn(async () => createMockAppState());
    const connectTenant = vi.fn(async () => createMockAppState());
    const writeClipboardText = vi.fn(async (_text: string) => undefined);
    const { user } = await reopen(tenant, { refreshTenantGrants, addTenantAccess, connectTenant, writeClipboardText });

    await user.click(service("Defender"));
    expect(screen.getByText(MICROSOFT_STEP_COPY.addsToOwn("Fabrikam", ownClientId))).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.askAdmin }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledOnce());
    const url = consentUrl(writeClipboardText.mock.calls[0]![0]);
    expect(url.pathname).toBe(`/${tenant.id}/v2.0/adminconsent`);
    expect(url.searchParams.get("client_id")).toBe(ownClientId);

    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.addPermissions }));
    const dialog = await screen.findByRole("dialog", { name: /Add Defender permissions/ });
    await user.click(within(dialog).getByRole("button", { name: "Copy script" }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledTimes(2));
    const script = writeClipboardText.mock.calls[1]![0];
    expect(script).toContain(ownClientId);
    for (const name of defenderScopes) expect(script).toContain(name);
    expect(script).not.toContain("DeviceManagementApps.Read.All");

    await user.click(within(dialog).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(refreshTenantGrants).toHaveBeenCalledWith(tenant.id));
    expect(addTenantAccess).not.toHaveBeenCalled();
    expect(connectTenant).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.connectedTitle("Fabrikam") })).toBeInTheDocument();
  });

  it("lets a partly connected service be completed after an Intune-only connect", async () => {
    const tenant = intuneTenant();
    const addTenantAccess = vi.fn(async () => createMockAppState({ tenants: [tenant], activeTenantId: tenant.id }));
    const { user } = await reopen(tenant, { addTenantAccess });

    // Intune's users and groups part also grants Entra's, so Entra is partly connected and still selectable.
    const entra = service("Entra");
    expect(entra).not.toBeChecked();
    expect(entra).toBeEnabled();
    expect(entra.closest("label")).toHaveTextContent(MICROSOFT_STEP_COPY.partlyConnected);
    expect(document.querySelector(".ms-node[data-service='entra']")).toHaveAttribute("data-state", "partial");

    await user.click(entra);
    // Entra users and groups and Entra devices are already granted through Intune's scopes.
    const granted = new Set(grantedParts(tenant).map((part) => part.id));
    const missing = partIdsFor(["entra"]).filter((id) => !granted.has(id));
    expect(missing).not.toContain("entra.people");
    const region = screen.getByRole("region", { name: /read-only Microsoft Graph permission/ });
    expect(region).toHaveTextContent("Policy.Read.All");
    // Already granted through Intune: not asked again.
    expect(region).not.toHaveTextContent("GroupMember.Read.All");
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.addAccess }));
    const dialog = await screen.findByRole("dialog", { name: /Add Entra access/ });
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() => expect(addTenantAccess).toHaveBeenCalledWith(tenant.id, missing));
  });
});

describe("Connect Microsoft 365 after a provider setup detour (PR #175 onboarding round review, 4)", () => {
  beforeEach(() => document.documentElement.setAttribute("data-reduced-motion", ""));
  afterEach(() => document.documentElement.removeAttribute("data-reduced-motion"));
  const ollamaNoModel: ModelScanResult = {
    probes: [{ providerId: "ollama", name: "Ollama", where: "local", target: "localhost:11434", state: "found", summary: "Running, no model loaded", facts: [], ready: false, models: [] }],
    outcome: { kind: "nothing" },
    startedAt: "2026-11-09T09:00:00.000Z",
    finishedAt: "2026-11-09T09:00:00.100Z",
  };
  function GoTo({ to }: { to: string }) {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate(to)}>Go to {to}</button>;
  }
  function renderAt(bridge: OpenAdminOSApi, route: string) {
    return renderWithAppState(
      <ModelScanGate>
        <Routes>
          <Route path="*" element={<div>App content<GoTo to="/chat" /><MicrosoftStepButton /><Where /></div>} />
        </Routes>
      </ModelScanGate>,
      { route, bridge },
    );
  }
  const ready = (pending: boolean) =>
    createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      activeProviderId: "ollama",
      providers: createMockAppState().providers.map((provider) =>
        provider.id === "ollama" ? { ...provider, status: "connected" as const, models: ["openadminos/openadmin-8b:latest"] } : provider,
      ),
      ...(pending ? { firstRunMicrosoftStepPending: true } : {}),
    });

  it("keeps the step for later when Get OpenAdmin 8B leaves the scan for Settings", async () => {
    const user = userEvent.setup();
    const bridge = bridgeFor(fresh(), { startModelScan: vi.fn(async () => ollamaNoModel) });
    renderAt(bridge, "/chat");
    await user.click(await screen.findByRole("button", { name: "Get OpenAdmin 8B" }));
    await waitFor(() => expect(bridge.completeFirstRunScan).toHaveBeenCalledWith({ microsoftStepPending: true }));
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/settings/providers");
    expect(screen.queryByRole("heading", { name: MICROSOFT_STEP_COPY.title })).toBeNull();
  });

  it("shows the step once a model is ready and the admin leaves Settings, and clears it when left", async () => {
    const user = userEvent.setup();
    const completeFirstRunMicrosoftStep = vi.fn(async () => ready(false));
    const bridge = bridgeFor(ready(true), { completeFirstRunMicrosoftStep });
    renderAt(bridge, "/settings/providers");
    // Not inside Settings, where the admin is setting up the model.
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: MICROSOFT_STEP_COPY.title })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Go to /chat" }));
    expect(await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.title })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Setup steps" });
    expect(within(steps).getByText("Microsoft 365").closest("li")).toHaveAttribute("aria-current", "step");
    await user.click(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.notNow }));
    await waitFor(() => expect(completeFirstRunMicrosoftStep).toHaveBeenCalledOnce());
    expect(await screen.findByText("App content")).toBeInTheDocument();
    // Still reachable afterwards from Settings, Tenants (Connections after step 4).
    expect(screen.getByRole("button", { name: MICROSOFT_STEP_COPY.reopen })).toBeInTheDocument();
  });

  it("shows the step on a later launch when a model is now ready", async () => {
    renderAt(bridgeFor(ready(true)), "/chat");
    expect(await screen.findByRole("heading", { level: 1, name: MICROSOFT_STEP_COPY.title })).toBeInTheDocument();
  });

  it("waits while no model is ready", async () => {
    const pendingNoModel = createMockAppState({
      tenants: [],
      activeTenantId: undefined,
      activeProviderId: "ollama",
      providers: createMockAppState().providers.map((provider) => (provider.id === "ollama" ? { ...provider, status: "connected" as const, models: [] } : provider)),
      firstRunMicrosoftStepPending: true,
    });
    renderAt(bridgeFor(pendingNoModel), "/chat");
    expect(await screen.findByText("App content")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: MICROSOFT_STEP_COPY.title })).toBeNull();
  });
});

describe("what a connected organization can answer", () => {
  it("lists connected services with their granted parts, and claims nothing for unrecorded grants", () => {
    const tenant = intuneTenant();
    expect(connectedServices(tenant).map((entry) => [entry.service.id, entry.status])).toEqual([
      ["intune", "connected"],
      ["entra", "partial"],
    ]);
    expect(connectedServices({ ...tenant, grantedScopes: undefined })).toEqual([]);
    expect(connectedServices(undefined)).toEqual([]);
  });

  it("offers at most two starters per connected service, from its granted parts", () => {
    const groups = connectedStarters(intuneTenant());
    expect(groups.map((group) => group.service.id)).toEqual(["intune", "entra"]);
    expect(groups[0]!.prompts).toEqual(["Which groups is this policy assigned to?", "Which devices have not synced in 30 days?"]);
    for (const group of groups) expect(group.prompts.length).toBeLessThanOrEqual(2);
  });
});
