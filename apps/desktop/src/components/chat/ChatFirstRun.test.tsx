import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createMockAppState, makeMockBridge, mockTenant, renderWithAppState } from "../../test/test-utils";
import { qualifyScope, requestedScopes, type TenantRecord } from "../../shared/openAdminOS";
import { NotConnectedCard } from "./ChatFirstRun";

const grants = (partIds: string[]) => requestedScopes(partIds).map((scope) => qualifyScope(scope.name));
const notConnected = { reason: "service-missing" as const, partIds: ["entra.signins", "defender.incidents"], tenantId: mockTenant.id };

function renderCard(tenant: TenantRecord, onAskAgain = vi.fn()) {
  renderWithAppState(
    <>
      <NotConnectedCard notConnected={notConnected} tenants={[tenant]} activeTenant={tenant} onAskAgain={onAskAgain} />
      <NotConnectedCard notConnected={notConnected} tenants={[tenant]} activeTenant={tenant} onAskAgain={onAskAgain} />
    </>,
    { bridge: makeMockBridge({}, createMockAppState({ tenants: [tenant], activeTenantId: tenant.id })) },
  );
  return onAskAgain;
}

describe("NotConnectedCard (review round 1, findings 8 and N)", () => {
  it("offers one action per service still missing, then Ask again once both are granted", () => {
    const none = { ...mockTenant, grantedScopes: grants(["intune.devices"]) };
    renderCard(none);
    expect(screen.getAllByRole("button", { name: "Add Entra" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Add Defender" })).toHaveLength(2);
  });

  it("drops a service once it is granted", () => {
    renderCard({ ...mockTenant, grantedScopes: grants(["intune.devices", "entra.signins"]) });
    expect(screen.queryByRole("button", { name: "Add Entra" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add Defender" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Ask again" })).not.toBeInTheDocument();
  });

  it("offers Ask again when every needed service is granted", () => {
    renderCard({ ...mockTenant, grantedScopes: grants(["intune.devices", "entra.signins", "defender.incidents"]) });
    expect(screen.getAllByRole("button", { name: "Ask again" })).toHaveLength(2);
  });

  it("gives each card its own heading id", () => {
    renderCard({ ...mockTenant, grantedScopes: grants(["intune.devices"]) });
    const sections = document.querySelectorAll("section[aria-labelledby]");
    const ids = [...sections].map((section) => section.getAttribute("aria-labelledby"));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("NotConnectedCard after the tenant changed (Muse round 2, P)", () => {
  const render = (card: Parameters<typeof NotConnectedCard>[0], tenants: TenantRecord[]) =>
    renderWithAppState(<NotConnectedCard {...card} />, {
      bridge: makeMockBridge({}, createMockAppState({ tenants, ...(tenants[0] ? { activeTenantId: tenants[0].id } : {}) })),
    });

  it("offers Add per missing service on the tenant a no-tenant card connected, not Connect again", () => {
    const partial = { ...mockTenant, grantedScopes: grants(["intune.devices", "entra.signins"]) };
    render({ notConnected: { reason: "no-tenant", partIds: ["entra.signins", "defender.incidents"] }, tenants: [partial], activeTenant: partial }, [partial]);
    expect(screen.getByRole("heading", { name: `Defender is not connected for ${mockTenant.displayName}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Defender" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add Entra" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect / })).not.toBeInTheDocument();
    expect(screen.queryByText("Sign-in")).not.toBeInTheDocument();
  });

  it("still offers Connect when the tenant the card was about was removed", () => {
    render(
      { notConnected: { reason: "service-missing", partIds: ["entra.signins", "defender.incidents"], tenantId: "removed-tenant" }, tenants: [], activeTenant: undefined },
      [],
    );
    expect(screen.getByText(/The tenant this question was about is no longer in OpenAdminOS/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Connect Entra.+Defender$/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use our own app registration" })).toBeInTheDocument();
  });
});
