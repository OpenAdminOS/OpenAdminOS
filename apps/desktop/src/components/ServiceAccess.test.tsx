import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ServiceGate, ServiceNotConnectedPanel } from "./ServiceAccess";
import { createMockAppState, makeMockBridge, renderWithAppState } from "../test/test-utils";

function intuneOnlyTenant(custom = false) {
  const base = createMockAppState().tenants[0]!;
  return {
    ...base,
    ...(custom
      ? { appRegistration: { kind: "custom" as const, clientId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } }
      : {}),
    grantedScopes: [
      "graph:User.Read.All",
      "graph:GroupMember.Read.All",
      "graph:Organization.Read.All",
    ],
  };
}

describe("service not connected panel", () => {
  it("names the service and adds it through reviewed consent", async () => {
    const user = userEvent.setup();
    const tenant = intuneOnlyTenant();
    const state = createMockAppState({ tenants: [tenant] });
    const addTenantAccess = vi.fn(async () => state);
    renderWithAppState(
      <ServiceNotConnectedPanel tenant={tenant} serviceIds={["defender"]} feature="This page" />,
      { route: "/chat", bridge: makeMockBridge({ addTenantAccess }, state) },
    );

    expect(
      await screen.findByRole("heading", { name: "Defender is not connected for Contoso IT" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Defender" }));
    const dialog = screen.getByRole("dialog", { name: "Add Defender access" });
    expect(within(dialog).getByText("3 delegated read scopes")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Continue to Microsoft" }));
    await waitFor(() =>
      expect(addTenantAccess).toHaveBeenCalledWith("tenant-1", ["defender.incidents", "defender.score"]),
    );
  });

  it("offers the permissions dialog instead of consent for an own registration", async () => {
    const user = userEvent.setup();
    const tenant = intuneOnlyTenant(true);
    const state = createMockAppState({ tenants: [tenant] });
    renderWithAppState(
      <ServiceNotConnectedPanel tenant={tenant} serviceIds={["defender"]} feature="This page" />,
      { route: "/chat", bridge: makeMockBridge({}, state) },
    );

    await user.click(await screen.findByRole("button", { name: "Add Defender permissions" }));
    const dialog = screen.getByRole("dialog", { name: "Add Defender permissions" });
    expect(within(dialog).getByRole("button", { name: "Copy script" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Check again" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Continue to Microsoft" })).not.toBeInTheDocument();
  });
});

describe("service gate", () => {
  it("shows the not-connected panel instead of the page when no listed service is connected", async () => {
    const tenant = { ...intuneOnlyTenant(), grantedScopes: ["graph:SecurityEvents.Read.All"] };
    renderWithAppState(
      <ServiceGate anyOf={["intune", "entra"]} feature="Changes">
        <div>Changes page</div>
      </ServiceGate>,
      { route: "/changes", bridge: makeMockBridge({}, createMockAppState({ tenants: [tenant] })) },
    );
    expect(
      await screen.findByRole("heading", { name: "Intune and Entra are not connected for Contoso IT" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Changes page")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Intune" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Entra" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders the page when one listed service is connected", async () => {
    const tenant = intuneOnlyTenant();
    renderWithAppState(
      <ServiceGate anyOf={["intune", "entra"]} feature="Changes">
        <div>Changes page</div>
      </ServiceGate>,
      { route: "/changes", bridge: makeMockBridge({}, createMockAppState({ tenants: [tenant] })) },
    );
    expect(await screen.findByText("Changes page")).toBeInTheDocument();
  });
});
