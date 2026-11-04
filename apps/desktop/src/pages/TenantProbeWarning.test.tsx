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

describe("tenant checks with cancel", () => {
  it("Check again shows the open Microsoft sign-in and a cancel shows the designed message", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [ownRegistrationTenant(false)] });
    const pending = deferred<AppState>();
    const cancelTenantCheck = vi.fn(async () => {
      pending.reject(new Error("Error invoking remote method 'openadminos:refresh-tenant-grants': Error: Check again was cancelled."));
    });
    const live = liveBridge(before, { refreshTenantGrants: vi.fn(() => pending.promise), cancelTenantCheck });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: live.bridge });

    const services = await screen.findByRole("region", { name: "Contoso IT services" });
    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain }));
    live.publish({ ...before, tenantChecks: [{ tenantId: "tenant-1", kind: "permissions", phase: "sign-in" }] });
    expect(await within(services).findByText(SERVICE_COPY.waitingForSignIn)).toBeInTheDocument();
    expect(within(services).getByRole("button", { name: SERVICE_COPY.waitingForSignInButton })).toBeDisabled();

    await user.click(within(services).getByRole("button", { name: SERVICE_COPY.cancelCheck }));
    expect(cancelTenantCheck).toHaveBeenCalledWith("tenant-1");
    live.publish(before);
    expect(await within(services).findByText(SERVICE_COPY.checkCancelled.permissions)).toBeInTheDocument();
    expect(within(services).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(services).getByRole("button", { name: SERVICE_COPY.checkAgain })).toBeEnabled();
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

  it("a cancelled Retry license check keeps the warning and says so", async () => {
    const user = userEvent.setup();
    const before = createMockAppState({ tenants: [sharedTenant(true)] });
    const pending = deferred<AppState>();
    const cancelTenantCheck = vi.fn(async () => pending.reject(new Error("License check cancelled.")));
    const live = liveBridge(before, { retryTenantLicenseCheck: vi.fn(() => pending.promise), cancelTenantCheck });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: live.bridge });

    const warning = await screen.findByRole("alert", { name: "Contoso IT license check" });
    await user.click(within(warning).getByRole("button", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") }));
    live.publish({ ...before, tenantChecks: [{ tenantId: "tenant-1", kind: "license", phase: "sign-in" }] });
    expect(await within(warning).findByText(SERVICE_COPY.waitingForSignIn)).toBeInTheDocument();
    await user.click(within(warning).getByRole("button", { name: SERVICE_COPY.cancelLicenseCheckFor("Contoso IT") }));
    expect(cancelTenantCheck).toHaveBeenCalledWith("tenant-1");
    live.publish(before);
    expect(await within(warning).findByText(SERVICE_COPY.checkCancelled.license)).toBeInTheDocument();
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

  it("shows licenses as not checked, without a warning, when Organization.Read.All is not granted", async () => {
    const state = createMockAppState({
      tenants: [{ ...sharedTenant(false, ["graph:DeviceManagementManagedDevices.Read.All"]), entraTier: undefined }],
    });
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings/tenants", bridge: makeMockBridge({}, state) });

    expect(await screen.findByText(`${SERVICE_COPY.licensesNotChecked}.`)).toBeInTheDocument();
    expect(screen.getByText(SERVICE_COPY.licensesNotCheckedBody)).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "Contoso IT license check" })).not.toBeInTheDocument();
  });
});

