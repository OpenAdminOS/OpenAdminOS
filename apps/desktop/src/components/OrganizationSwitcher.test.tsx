import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { OrganizationSwitcher } from "./OrganizationSwitcher";
import { ORGANIZATION_COPY, SERVICE_COPY } from "../copy";
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
    expect(within(menu).getByRole("menuitemradio", { name: new RegExp(`^${ORGANIZATION_COPY.noOrganization}`) })).toHaveAttribute("aria-checked", "false");
    expect(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.addOrganization })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.previewSample })).toBeInTheDocument();
    await user.click(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.manageConnections }));
    expect(screen.getByTestId("location")).toHaveTextContent("/connections");
  });

  it("chooses No organization and shows it on the chip", async () => {
    const user = userEvent.setup();
    const bridge = renderSwitcher();
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    await user.click(screen.getByRole("menuitemradio", { name: new RegExp(`^${ORGANIZATION_COPY.noOrganization}`) }));
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

  it("has no Disconnect in the switch rows (design round)", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    const menu = screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    expect(within(menu).queryByRole("menuitem", { name: /Disconnect/ })).not.toBeInTheDocument();
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

it("marks No organization with a neutral empty tile, not a question mark", async () => {
  const { activeTenantId: _none, ...state } = createMockAppState();
  renderSwitcher(state);
  const chip = await screen.findByRole("button", { name: ORGANIZATION_COPY.chipLabelNone(true) });
  expect(within(chip).getByTestId("no-organization-mark")).toBeEmptyDOMElement();
  expect(chip).not.toHaveTextContent("?");
});

describe("switcher keyboard edge cases (Muse round 2)", () => {
  it("goes to the last item with ArrowUp and the first with ArrowDown from outside the list", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    const menu = screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    // Let the open-time focus land first, then move focus outside the items.
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: /Contoso IT/ })).toHaveFocus());
    menu.setAttribute("tabindex", "-1");
    menu.focus();
    await user.keyboard("{ArrowUp}");
    expect(within(menu).getByRole("menuitem", { name: ORGANIZATION_COPY.manageConnections })).toHaveFocus();
    menu.focus();
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getByRole("menuitemradio", { name: /Contoso IT/ })).toHaveFocus();
  });

  it("reaches a running check's Cancel as a menu item", async () => {
    const user = userEvent.setup();
    renderSwitcher(createMockAppState({ tenantChecks: [{ tenantId: "tenant-1", kind: "license", phase: "checking" }] }));
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    const menu = screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    const cancel = within(menu).getByRole("menuitem", { name: SERVICE_COPY.cancelCheckFor("Contoso IT") });
    await waitFor(() => expect(within(menu).getByRole("menuitemradio", { name: /Contoso IT/ })).toHaveFocus());
    for (let step = 0; step < 4 && document.activeElement !== cancel; step += 1) await user.keyboard("{ArrowDown}");
    expect(cancel).toHaveFocus();
  });
});

describe("switcher filter, order and height (design round)", () => {
  function many(count: number) {
    const base = createMockAppState().tenants[0]!;
    const names = ["Woodgrove Bank", "Fabrikam", "Northwind Traders", "Adatum", "Tailspin Toys", "Litware", "Proseware"];
    return names.slice(0, count).map((name, index) => ({
      ...base,
      id: `tenant-${index}`,
      displayName: name,
      username: `admin@${name.split(" ")[0]!.toLowerCase()}.example`,
      // Proseware was used last, Woodgrove Bank first.
      lastUsedAt: `2026-11-0${index + 1}T10:00:00.000Z`,
    }));
  }

  it("lists the most recently used organization first", async () => {
    const user = userEvent.setup();
    const tenants = many(3);
    renderSwitcher(createMockAppState({ tenants, activeTenantId: tenants[0]!.id }));
    await user.click(await screen.findByRole("button", { name: /Switch organization/ }));
    const names = within(screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel }))
      .getAllByRole("menuitemradio")
      .map((item) => item.textContent ?? "");
    expect(names[0]).toMatch(/^NTNorthwind Traders/);
    expect(names[1]).toMatch(/^FAFabrikam/);
    expect(names[2]).toMatch(/^WBWoodgrove Bank/);
    expect(names.at(-1)).toMatch(/No organization/);
  });

  it("starts with a filter from six organizations that matches name and domain", async () => {
    const user = userEvent.setup();
    const tenants = many(7);
    renderSwitcher(createMockAppState({ tenants, activeTenantId: tenants[0]!.id }));
    await user.click(await screen.findByRole("button", { name: /Switch organization/ }));
    const filter = await screen.findByRole("searchbox", { name: ORGANIZATION_COPY.findOrganization });
    await waitFor(() => expect(filter).toHaveFocus());
    await user.type(filter, "tail");
    const menu = screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    expect(within(menu).getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual([expect.stringContaining("Tailspin Toys")]);
    await user.clear(filter);
    await user.type(filter, "litware.example");
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(1);
    await user.clear(filter);
    await user.type(filter, "zzz");
    expect(within(menu).getByRole("status")).toHaveTextContent(ORGANIZATION_COPY.noMatch("zzz"));
    // Arrow keys move from the filter into the list.
    await user.clear(filter);
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getAllByRole("menuitemradio")[0]).toHaveFocus();
  });

  it("has no filter below six organizations and caps the list height with scrolling", async () => {
    const user = userEvent.setup();
    renderSwitcher(createMockAppState({ tenants: many(5) }));
    await user.click(await screen.findByRole("button", { name: /Switch organization/ }));
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    expect(screen.getByTestId("organization-list").className).toMatch(/max-h-\[min\(360px,55vh\)\] overflow-y-auto/);
  });
});

describe("switcher filter and focus (design round review, Muse E and F)", () => {
  function many(count: number) {
    const base = createMockAppState().tenants[0]!;
    const names = ["Woodgrove Bank", "Fabrikam", "Northwind Traders", "Adatum", "Tailspin Toys", "Litware", "Proseware"];
    return names.slice(0, count).map((name, index) => ({
      ...base,
      id: `tenant-${index}`,
      displayName: name,
      username: `admin@${name.split(" ")[0]!.toLowerCase()}.example`,
      lastUsedAt: `2026-11-0${index + 1}T10:00:00.000Z`,
    }));
  }

  it("keeps the filter outside the menu with its own keys, a focus ring and a polite count", async () => {
    const user = userEvent.setup();
    const tenants = many(7);
    const bridge = renderSwitcher(createMockAppState({ tenants, activeTenantId: tenants[0]!.id }));
    const chip = await screen.findByRole("button", { name: /Switch organization/ });
    await user.click(chip);
    const menu = screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel });
    expect(chip).toHaveAttribute("aria-controls", menu.id);
    const filter = screen.getByRole("searchbox", { name: ORGANIZATION_COPY.findOrganization });
    expect(menu).not.toContainElement(filter);
    expect(filter.closest("label")?.className).toContain("focus-within:ring-2");
    await waitFor(() => expect(filter).toHaveFocus());
    await user.type(filter, "ware");
    // Home and End move the caret in the input, not focus in the menu.
    await user.keyboard("{Home}");
    expect(filter).toHaveFocus();
    expect(screen.getByText(ORGANIZATION_COPY.matchCount(2))).toBeInTheDocument();
    // Down enters the list; Up from its first item returns to the filter.
    await user.keyboard("{ArrowDown}");
    expect(within(menu).getAllByRole("menuitemradio")[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(filter).toHaveFocus();
    // Enter picks the first match.
    await user.keyboard("{Enter}");
    await waitFor(() => expect(bridge.setActiveOrganization).toHaveBeenCalledWith("org-tenant-6"));
  });

  it("keeps focus on the picked organization while busy and after a failed switch", async () => {
    const user = userEvent.setup();
    const base = createMockAppState().tenants[0]!;
    let fail!: (error: Error) => void;
    const bridge = renderSwitcher(createMockAppState({ tenants: [base, { ...base, id: "tenant-2", displayName: "Fabrikam" }] }));
    vi.mocked(bridge.setActiveOrganization).mockImplementation(() => new Promise((_resolve, reject) => (fail = reject)));
    await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
    const fabrikam = screen.getByRole("menuitemradio", { name: /Fabrikam/ });
    fabrikam.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(fabrikam).toHaveAttribute("aria-disabled", "true"));
    expect(fabrikam).not.toBeDisabled();
    expect(fabrikam).toHaveFocus();
    fail(new Error("The local state file could not be written."));
    await waitFor(() => expect(screen.getByRole("menuitemradio", { name: /Fabrikam/ })).toHaveFocus());
    expect(screen.getByRole("menu", { name: ORGANIZATION_COPY.menuLabel })).toBeInTheDocument();
  });
});

it("moves focus from Retry license check to the Cancel that replaces it (design round review, Muse E)", async () => {
  const user = userEvent.setup();
  const base = createMockAppState().tenants[0]!;
  const tenant = { ...base, tierProbeWarning: { message: "The license check did not finish.", at: "2026-11-09T10:00:00.000Z" } } as typeof base;
  const state = createMockAppState({ tenants: [tenant] });
  let notify: (() => void) | undefined;
  const bridge = makeMockBridge({}, state);
  vi.mocked(bridge.onAppStateChanged!).mockImplementation((listener) => {
    notify = () => listener({ reason: "tenant-check" });
    return () => undefined;
  });
  // The host reports the check as running, as it does over IPC.
  vi.mocked(bridge.retryTenantLicenseCheck).mockImplementation(() => {
    vi.mocked(bridge.getAppState).mockResolvedValue({ ...state, tenantChecks: [{ tenantId: tenant.id, kind: "license", phase: "checking" }] } as never);
    notify?.();
    return new Promise(() => undefined);
  });
  renderRoute(
    <>
      <OrganizationSwitcher />
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </>,
    { path: "*", route: "/chat", bridge },
  );
  await user.click(await screen.findByRole("button", { name: "Switch organization, Contoso IT" }));
  await user.click(screen.getByRole("menuitem", { name: SERVICE_COPY.retryLicenseCheckFor("Contoso IT") }));
  await waitFor(() => expect(screen.getByRole("menuitem", { name: SERVICE_COPY.cancelCheckFor("Contoso IT") })).toHaveFocus());
});
