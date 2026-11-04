import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Settings from "./Settings";
import { TenantSwitcher } from "../components/TenantSwitcher";
import { SERVICE_COPY } from "../copy";
import { createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import type { AppState, OpenAdminOSApi, TenantRecord } from "../shared/openAdminOS";

const MISMATCH =
  "Signed in as it@fabrikam.example, but this tenant is connected as admin@contoso.example. Sign in as admin@contoso.example and try again.";

function ownRegistrationTenant(warned: boolean): TenantRecord {
  const base = createMockAppState().tenants[0]!;
  return {
    ...base,
    appRegistration: { kind: "custom", clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    grantedScopes: ["graph:User.Read.All", "graph:GroupMember.Read.All", "graph:Organization.Read.All"],
    entraTier: "p1",
    ...(warned
      ? { tierProbeWarning: { message: MISMATCH, reason: "account-mismatch", accountMismatch: true, at: "2026-11-04T10:00:00.000Z" } }
      : {}),
  };
}

describe("Entra tier probe warning", () => {
  it("shows the mismatch on the tenant in Settings, Tenants", async () => {
    const state = createMockAppState({ tenants: [ownRegistrationTenant(true)] });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: makeMockBridge({}, state) });

    const warning = await screen.findByRole("alert", { name: "Contoso IT license check" });
    expect(within(warning).getByText(SERVICE_COPY.tierProbeWarningTitle)).toBeInTheDocument();
    expect(within(warning).getByText(MISMATCH)).toBeInTheDocument();
    expect(within(warning).getByText(SERVICE_COPY.tierProbeWarningKept)).toBeInTheDocument();
  });

  it("Check again reports the probe warning instead of plain success", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [ownRegistrationTenant(false)] });
    const after = createMockAppState({ tenants: [ownRegistrationTenant(true)] });
    const refreshTenantGrants = vi.fn(async () => after);
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/tenants",
      bridge: makeMockBridge({ refreshTenantGrants }, before),
    });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain }));
    await waitFor(() => expect(refreshTenantGrants).toHaveBeenCalledWith("tenant-1"));
    expect(await within(services).findByText(SERVICE_COPY.checkedAgainWithWarning(MISMATCH))).toBeInTheDocument();
    expect(within(services).queryByText(SERVICE_COPY.checkedAgain)).not.toBeInTheDocument();
  });

  it("Check again still reports success when the probe finished", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ tenants: [ownRegistrationTenant(false)] });
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/tenants",
      bridge: makeMockBridge({ refreshTenantGrants: vi.fn(async () => state) }, state),
    });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain }));
    expect(await within(services).findByText(SERVICE_COPY.checkedAgain)).toBeInTheDocument();
  });

  it("shows the warning in the tenant switcher", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ tenants: [ownRegistrationTenant(true)] });
    renderRoute(<TenantSwitcher />, { path: "/", route: "/", bridge: makeMockBridge({}, state) });

    await user.click(await screen.findByRole("button", { name: /Switch tenant/ }));
    const menu = screen.getByRole("menu", { name: "Connected tenants" });
    expect(within(menu).getByText(`${SERVICE_COPY.tierProbeWarningShort}. ${MISMATCH}`)).toBeInTheDocument();
  });
});

function sharedTenant(warned: boolean, grantedScopes?: string[]): TenantRecord {
  const base = createMockAppState().tenants[0]!;
  return {
    ...base,
    grantedScopes: grantedScopes ?? ["graph:User.Read.All", "graph:GroupMember.Read.All", "graph:Organization.Read.All"],
    ...(warned
      ? { tierProbeWarning: { message: MISMATCH, reason: "account-mismatch" as const, accountMismatch: true, at: "2026-11-04T10:00:00.000Z" } }
      : {}),
  };
}

/** A bridge whose state the test can change, as the host does on state-changed events. */
function liveBridge(initial: AppState, overrides: Partial<OpenAdminOSApi>) {
  let current = initial;
  const listeners: Array<(info: { reason: string }) => void> = [];
  const bridge = makeMockBridge(
    {
      getAppState: vi.fn(async () => current),
      onAppStateChanged: vi.fn((listener: (info: { reason: string }) => void) => {
        listeners.push(listener);
        return () => undefined;
      }),
      ...overrides,
    },
    initial,
  );
  return {
    bridge,
    publish(next: AppState) {
      current = next;
      for (const listener of listeners) listener({ reason: "tenant-check" });
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** How Electron delivers a host error to the renderer. */
function remoteError(channel: string, name: string, message: string): Error {
  return new Error(`Error invoking remote method '${channel}': ${name}: ${message}`);
}

const CANCELLED_AFTER_ACCESS =
  "Access was added. The license check was cancelled; the Entra tier and licenses are as they were. Retry license check to update them.";

describe("tenant checks with cancel", () => {
  it("Check again shows the open Microsoft sign-in and a cancel shows the host's message without the Electron prefix", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [ownRegistrationTenant(false)] });
    const pending = deferred<AppState>();
    const cancelTenantCheck = vi.fn(async () => {
      pending.reject(remoteError("openadminos:refresh-tenant-grants", "TenantCheckCancelledError", "Check again was cancelled. Nothing changed."));
    });
    const live = liveBridge(before, { refreshTenantGrants: vi.fn(() => pending.promise), cancelTenantCheck });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: live.bridge });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain }));
    live.publish({ ...before, tenantChecks: [{ tenantId: "tenant-1", kind: "permissions", phase: "sign-in" }] });
    const progress = await screen.findByRole("status", { name: SERVICE_COPY.checkRunningFor("Contoso IT") });
    expect(within(progress).getByText(SERVICE_COPY.waitingForSignIn)).toBeInTheDocument();
    expect(within(services).getByRole("button", { name: SERVICE_COPY.waitingForSignInButton })).toBeDisabled();
    // Adding permissions waits for the running check.
    for (const button of within(services).getAllByRole("button", { name: /^Add .+ permissions$/ })) {
      expect(button).toBeDisabled();
    }

    await user.click(within(progress).getByRole("button", { name: SERVICE_COPY.cancelCheckFor("Contoso IT") }));
    expect(cancelTenantCheck).toHaveBeenCalledWith("tenant-1");
    live.publish(before);
    expect(await within(services).findByText("Check again was cancelled. Nothing changed.")).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();
    expect(within(services).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain })).toBeEnabled();
  });

  it("shows a failed check without the Electron prefix", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({ tenants: [ownRegistrationTenant(false)] });
    const refreshTenantGrants = vi.fn(async () => {
      throw new Error("Error invoking remote method 'openadminos:refresh-tenant-grants': Error: Microsoft could not be reached.");
    });
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/tenants",
      bridge: makeMockBridge({ refreshTenantGrants }, state),
    });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain }));
    expect(await within(services).findByRole("alert")).toHaveTextContent(/^Microsoft could not be reached\.$/);
  });

  for (const [label, tenantFor] of [
    ["a shared-app tenant", sharedTenant],
    ["an own-registration tenant", ownRegistrationTenant],
  ] as const) {
    it(`Retry license check runs the probe for ${label} and reports the result`, async () => {
      const user = userEvent.setup();
      const before = createMockAppState({ tenants: [tenantFor(true)] });
      const after = createMockAppState({ tenants: [tenantFor(false)] });
      const retryTenantLicenseCheck = vi.fn(async () => after);
      const refreshTenantGrants = vi.fn(async () => after);
      renderRoute(<Settings />, {
        path: "/settings/:section?",
        route: "/settings/tenants",
        bridge: makeMockBridge({ retryTenantLicenseCheck, refreshTenantGrants }, before),
      });

      const warning = await screen.findByRole("alert", { name: "Contoso IT license check" });
      await user.click(within(warning).getByRole("button", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") }));
      expect(retryTenantLicenseCheck).toHaveBeenCalledWith("tenant-1");
      expect(refreshTenantGrants).not.toHaveBeenCalled();
      expect(await screen.findByText(SERVICE_COPY.licenseCheckFinished)).toBeInTheDocument();
      expect(screen.queryByRole("alert", { name: "Contoso IT license check" })).not.toBeInTheDocument();
    });
  }

  it("a cancelled Retry license check keeps the warning and shows the host's message", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [sharedTenant(true)] });
    const pending = deferred<AppState>();
    const message =
      "The license check was cancelled; the Entra tier and licenses are as they were. Retry license check to update them.";
    const cancelTenantCheck = vi.fn(async () =>
      pending.reject(remoteError("openadminos:retry-tenant-license-check", "TenantCheckCancelledError", message)),
    );
    const live = liveBridge(before, { retryTenantLicenseCheck: vi.fn(() => pending.promise), cancelTenantCheck });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: live.bridge });

    const warning = await screen.findByRole("alert", { name: "Contoso IT license check" });
    await user.click(within(warning).getByRole("button", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") }));
    live.publish({ ...before, tenantChecks: [{ tenantId: "tenant-1", kind: "license", phase: "sign-in" }] });
    const progress = await screen.findByRole("status", { name: SERVICE_COPY.checkRunningFor("Contoso IT") });
    expect(within(progress).getByText(SERVICE_COPY.waitingForSignIn)).toBeInTheDocument();
    expect(within(warning).getByRole("button", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") })).toBeDisabled();
    await user.click(within(progress).getByRole("button", { name: SERVICE_COPY.cancelCheckFor("Contoso IT") }));
    expect(cancelTenantCheck).toHaveBeenCalledWith("tenant-1");
    live.publish(before);
    expect(await within(warning).findByText(message)).toBeInTheDocument();
    expect(within(warning).getByText(MISMATCH)).toBeInTheDocument();
  });

  it("Add access keeps the dialog open when the license check did not finish", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [sharedTenant(false)] });
    const after = createMockAppState({ tenants: [sharedTenant(true)] });
    const addTenantAccess = vi.fn(async () => after);
    renderRoute(<Settings />, {
      path: "/settings/:section?",
      route: "/settings/tenants",
      bridge: makeMockBridge({ addTenantAccess }, before),
    });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.addAccessTitle("Defender") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    expect(addTenantAccess).toHaveBeenCalled();
    expect(await within(dialog).findByText(SERVICE_COPY.accessAddedWithWarning(MISMATCH))).toBeInTheDocument();
  });

  it("Add access cancelled during the license check says the access was added", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [sharedTenant(false)] });
    const pending = deferred<AppState>();
    const cancelTenantCheck = vi.fn(async () =>
      pending.reject(remoteError("openadminos:add-tenant-access", "TenantCheckCancelledError", CANCELLED_AFTER_ACCESS)),
    );
    const live = liveBridge(before, { addTenantAccess: vi.fn(() => pending.promise), cancelTenantCheck });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: live.bridge });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.addAccessTitle("Defender") }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    live.publish({ ...before, tenantChecks: [{ tenantId: "tenant-1", kind: "access", phase: "licenses" }] });
    const progress = await within(dialog).findByRole("status", { name: SERVICE_COPY.checkRunningFor("Contoso IT") });
    expect(within(progress).getByText(SERVICE_COPY.checkingLicenses)).toBeInTheDocument();
    await user.click(within(progress).getByRole("button", { name: SERVICE_COPY.cancelCheckFor("Contoso IT") }));
    live.publish(before);
    expect(await within(dialog).findByText(CANCELLED_AFTER_ACCESS)).toBeInTheDocument();
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers Retry license check in the tenant switcher", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [sharedTenant(true)] });
    const retryTenantLicenseCheck = vi.fn(async () => createMockAppState({ tenants: [sharedTenant(false)] }));
    renderRoute(<TenantSwitcher />, { path: "/", route: "/", bridge: makeMockBridge({ retryTenantLicenseCheck }, before) });

    await user.click(await screen.findByRole("button", { name: /Switch tenant/ }));
    await user.click(screen.getByRole("button", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") }));
    expect(retryTenantLicenseCheck).toHaveBeenCalledWith("tenant-1");
    expect(await screen.findByText(SERVICE_COPY.licenseCheckFinished)).toBeInTheDocument();
  });

  it("shows progress and Cancel in Settings after the switcher started the check and its menu closed", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [sharedTenant(true)] });
    const pending = deferred<AppState>();
    const message =
      "The license check was cancelled; the Entra tier and licenses are as they were. Retry license check to update them.";
    const cancelTenantCheck = vi.fn(async () =>
      pending.reject(remoteError("openadminos:retry-tenant-license-check", "TenantCheckCancelledError", message)),
    );
    const live = liveBridge(before, { retryTenantLicenseCheck: vi.fn(() => pending.promise), cancelTenantCheck });
    renderRoute(
      <>
        <TenantSwitcher />
        <Settings />
      </>,
      { path: "/settings/:section?", route: "/settings/tenants", bridge: live.bridge },
    );

    await user.click(await screen.findByRole("button", { name: /Switch tenant/ }));
    const menu = screen.getByRole("menu", { name: "Connected tenants" });
    await user.click(within(menu).getByRole("button", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") }));
    live.publish({ ...before, tenantChecks: [{ tenantId: "tenant-1", kind: "license", phase: "licenses" }] });
    // The switcher shows the check with a labelled Cancel, not a second X.
    const inMenu = await within(menu).findByRole("status", { name: SERVICE_COPY.checkRunningFor("Contoso IT") });
    expect(within(inMenu).getByRole("button", { name: SERVICE_COPY.cancelCheckFor("Contoso IT") })).toHaveTextContent(SERVICE_COPY.cancelCheck);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Connected tenants" })).not.toBeInTheDocument();

    const settingsWarning = screen.getByRole("alert", { name: "Contoso IT license check" });
    expect(within(settingsWarning).getByRole("button", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") })).toBeDisabled();
    const progress = screen.getByRole("status", { name: SERVICE_COPY.checkRunningFor("Contoso IT") });
    expect(within(progress).getByText(SERVICE_COPY.checkingLicenses)).toBeInTheDocument();
    await user.click(within(progress).getByRole("button", { name: SERVICE_COPY.cancelCheckFor("Contoso IT") }));
    expect(cancelTenantCheck).toHaveBeenCalledWith("tenant-1");
    live.publish(before);
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.queryByText(/Error invoking remote method/)).not.toBeInTheDocument();
  });

  it("shows licenses as not checked once, without a warning, when Organization.Read.All is not granted", async () => {
    const state = createMockAppState({
      tenants: [{ ...sharedTenant(false, ["graph:DeviceManagementManagedDevices.Read.All"]), entraTier: undefined }],
    });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: makeMockBridge({}, state) });

    expect(await screen.findByText(`${SERVICE_COPY.licensesNotChecked}.`)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(SERVICE_COPY.licensesNotChecked))).toHaveLength(1);
    expect(screen.getByText(SERVICE_COPY.licensesNotCheckedBody)).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Contoso IT license check" })).not.toBeInTheDocument();
  });
});
