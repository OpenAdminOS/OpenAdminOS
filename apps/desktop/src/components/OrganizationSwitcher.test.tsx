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

describe("organization switcher keyboard and focus (review round 1)", () => {
  it("moves focus into the menu, navigates with arrow keys and returns focus to the chip", async () => {
    const user = userEvent.setup();
    const base = createMockAppState().tenants[0]!;
    const second = { ...base, id: "tenant-2", displayName: "Fabrikam" };
    renderSwitcher(createMockAppState({ tenants: [base, second] }));
    const chip = await screen.findByRole("button", { name: "Switch organization, Contoso IT" });
    chip.focus();
    await user.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    // The active organization takes focus.
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: /Contoso IT/ })).toHaveFocus());
    // Its disconnect action is the next item, reachable without hover.
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitem", { name: "Disconnect Contoso IT" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitemradio", { name: /Fabrikam/ })).toHaveFocus();
    await user.keyboard("{End}");
    expect(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.manageConnections })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(within(menu).getByRole("menuitemradio", { name: /Contoso IT/ })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(chip).toHaveFocus());
  });

  it("keeps the disconnect action visible without hover", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    const disconnect = screen.getByRole("menuitem", { name: "Disconnect Contoso IT" });
    expect(disconnect.className).not.toMatch(/opacity-0/);
  });

  it("returns focus to the chip after choosing an organization", async () => {
    const user = userEvent.setup();
    const base = createMockAppState().tenants[0]!;
    renderSwitcher(createMockAppState({ tenants: [base, { ...base, id: "tenant-2", displayName: "Fabrikam" }] }));
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    await user.click(screen.getByRole("menuitemradio", { name: /Fabrikam/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Switch organization, Fabrikam" })).toHaveFocus());
  });
});
