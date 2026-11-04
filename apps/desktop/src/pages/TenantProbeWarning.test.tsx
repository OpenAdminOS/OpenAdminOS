import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import Settings from "./Settings";
import { TenantSwitcher } from "../components/TenantSwitcher";
import { SERVICE_COPY } from "../copy";
import { createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import type { TenantRecord } from "../shared/openAdminOS";

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
      ? { tierProbeWarning: { message: MISMATCH, accountMismatch: true, at: "2026-11-04T10:00:00.000Z" } }
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
