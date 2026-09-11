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
    ).toEqual(["Chat", "Agent Team", "Agents", "Changes", "Cache", "Settings"]);
    expect(
      screen.queryByRole("link", { name: "Home" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Report issue/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps Workspaces and Connectors out of the primary group but reachable", () => {
    renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    // The primary group stays the daily destinations only: v0.4 cut the
    // nav to four items and these two are power-user surfaces.
    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(primary).queryByRole("link", { name: /Workspaces/ }),
    ).not.toBeInTheDocument();
    expect(
      within(primary).queryByRole("link", { name: /Connectors/ }),
    ).not.toBeInTheDocument();

    const more = screen.getByRole("navigation", { name: "More" });
    expect(
      within(more)
        .getAllByRole("link")
        .map((link) => link.querySelector(".flex-1")?.textContent?.trim()),
    ).toEqual(["Workspaces", "Connectors"]);
  });

  it("shows persona icons and selects only the linked persona", async () => {
    const personas = ["Chief of Staff", "Research Bot"].map((name, i) => ({
      id: `persona-${i}`,
      name,
      responsibility: "Review settings",
      avatar: "robot" as const,
      color: "sage" as const,
      tenantId: "tenant-1",
      providerId: "ollama" as const,
      agentSlugs: ["compliance-overview"],
      intervalMinutes: null,
      maxMinutes: 30,
      enabled: true,
      createdAt: "2026-09-10T10:00:00Z",
      updatedAt: "2026-09-10T10:00:00Z",
      lastError: i === 1 ? "Review provider settings" : undefined,
    }));
    renderRoute(<Sidebar />, {
      path: "*",
      route: "/office?persona=persona-1",
      bridge: makeMockBridge(
        {},
        createMockAppState({ office: { personas, missions: [] } }),
      ),
    });
    const research = await screen.findByRole("link", { name: /Research Bot/ });
    expect(research).toHaveAttribute("href", "/office?persona=persona-1");
    expect(research).toHaveAttribute("aria-current", "page");
    expect(research.querySelector("svg")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Chief of Staff" }),
    ).not.toHaveAttribute("aria-current");
    expect(
      within(research).getByRole("img", { name: "Needs attention" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Agent Team/ })).toHaveTextContent(
      "1",
    );
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
    expect(
      await within(primary).findByRole("link", { name: /Fleet/ }),
    ).toBeInTheDocument();
    expect(
      within(primary)
        .getAllByRole("link")
        .map((link) => link.querySelector(".flex-1")?.textContent?.trim()),
    ).toEqual(["Chat", "Agent Team", "Agents", "Changes", "Fleet", "Cache", "Settings"]);
  });
});
