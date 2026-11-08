import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";

import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { ORGANIZATION_COPY } from "../copy";
import { createMockAppState, makeMockBridge, renderRoute } from "../test/test-utils";
import { SERVICE_PARTS } from "../shared/openAdminOS";

function scopes(...serviceIds: string[]) {
  return [
    ...new Set(
      SERVICE_PARTS.filter((part) => serviceIds.includes(part.service)).flatMap((part) =>
        part.scopes.map((scope) => `graph:${scope.name}`),
      ),
    ),
  ];
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSwitcher(state = createMockAppState()) {
  const bridge = makeMockBridge({}, state);
  renderRoute(
    <>
      <OrganizationSwitcher />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </>,
    { path: "*", route: "/chat", bridge },
  );
  return bridge;
}

describe("organization switcher", () => {
  it("lists each organization with the services it runs, sample data and the three actions", async () => {
    const user = userEvent.setup();
    const base = createMockAppState().tenants[0]!;
    const woodgrove = { ...base, id: "tenant-woodgrove", displayName: "Woodgrove", grantedScopes: scopes("intune", "entra") };
    const fabrikam = { ...base, id: "tenant-fabrikam", displayName: "Fabrikam", grantedScopes: scopes("intune", "entra", "defender") };
    const sample = { ...base, id: "openadminos-sample-tenant", displayName: "Contoso (pilot)", kind: "sample" as const };
    renderSwitcher(
      createMockAppState({
        tenants: [woodgrove, fabrikam, sample],
        activeTenantId: woodgrove.id,
        organizations: [
          { id: "org-tenant-woodgrove", name: "Woodgrove Bank", createdAt: base.addedAt, connections: { microsoft365: { tenantId: woodgrove.id } } },
        ],
      }),
    );

    // The chip shows the organization name, not the tenant display name.
    await user.click(await screen.findByRole("button", { name: "Switch organization, Woodgrove Bank" }));
    const menu = screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    const active = within(menu).getByRole("menuitemradio", { name: /Woodgrove Bank/ });
    expect(active).toHaveAttribute("aria-checked", "true");
    expect(within(active).getByLabelText("Services: Intune, Entra")).toBeInTheDocument();
    const other = within(menu).getByRole("menuitemradio", { name: /Fabrikam/ });
    expect(within(other).getByLabelText("Services: Intune, Entra, Defender")).toBeInTheDocument();
    const pilot = within(menu).getByRole("menuitemradio", { name: /Contoso \(pilot\)/ });
    expect(within(pilot).getByText(ORGANIZATION_COPY.sampleLabel)).toBeInTheDocument();
    expect(within(menu).getByRole("menuitemradio", { name: ORGANIZATION_COPY.noOrganization })).toHaveAttribute("aria-checked", "false");
    expect(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.addOrganization })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.previewSample })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.manageConnections }));
    expect(screen.getByTestId("location")).toHaveTextContent("/connections");
  });

  it("chooses No organization and shows it on the chip", async () => {
    const user = userEvent.setup();
    const bridge = renderSwitcher();
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    await user.click(screen.getByRole("menuitemradio", { name: ORGANIZATION_COPY.noOrganization }));
    await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith(null));
    expect(await screen.findByRole("button", { name: ORGANIZATION_COPY.chipLabelNone(true) })).toHaveTextContent(
      ORGANIZATION_COPY.noOrganization,
    );
  });

  it("explains an empty list without organizations", async () => {
    const user = userEvent.setup();
    const { activeTenantId: _none, ...state } = createMockAppState();
    renderSwitcher({ ...state, tenants: [] });
    await user.click(await screen.findByRole("button", { name: ORGANIZATION_COPY.chipLabelNone(false) }));
    const menu = screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    expect(within(menu).getByText(ORGANIZATION_COPY.none)).toBeInTheDocument();
    expect(within(menu).getByText(ORGANIZATION_COPY.noneDetail)).toBeInTheDocument();
    // "No organization" is already the state; there is nothing else to choose.
    expect(within(menu).queryByRole("menuitemradio")).not.toBeInTheDocument();
  });
});
