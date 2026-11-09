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
