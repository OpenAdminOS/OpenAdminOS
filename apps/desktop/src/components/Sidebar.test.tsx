import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./Sidebar";
import {
  createMockAppState,
  makeMockBridge,
  mockTenant,
  renderRoute,
} from "../test/test-utils";
import type { TenantRecord } from "../shared/openAdminOS";

describe("Sidebar", () => {
  it("keeps one compact primary navigation group", () => {
    renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(primary)
        .getAllByRole("link")
        .map((link) => link.querySelector(".flex-1")?.textContent?.trim()),
    ).toEqual(["Chat", "Agents", "Changes", "Settings"]);
    expect(screen.queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Report issue/ })).not.toBeInTheDocument();
  });

  it("shows Fleet only when at least two tenants are connected", async () => {
    const secondTenant: TenantRecord = {
      id: "tenant-2",
      displayName: "Fabrikam Europe",
      username: "admin@fabrikam.example",
      homeAccountId: "home-account-2",
      addedAt: "2026-08-01T08:00:00.000Z",
    };
    const appState = createMockAppState({
      tenants: [mockTenant, secondTenant],
    });

    renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({}, appState),
    });

    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(await within(primary).findByRole("link", { name: /Fleet/ })).toBeInTheDocument();
    expect(
      within(primary)
        .getAllByRole("link")
        .map((link) => link.querySelector(".flex-1")?.textContent?.trim()),
    ).toEqual(["Chat", "Agents", "Changes", "Fleet", "Settings"]);
  });
});
