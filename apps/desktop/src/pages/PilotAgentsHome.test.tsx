import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import Agents from "./Agents";
import {
  createMockAgent,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";
import type { AgentSummary, RegistryAgentSummary } from "../shared/openAdminOS";

const pilotTenant = {
  id: "openadminos-sample-tenant",
  kind: "sample" as const,
  displayName: "Contoso (pilot)",
  username: "admin@contoso-sample.invalid",
  homeAccountId: "openadminos-sample-account",
  addedAt: "2026-10-26T12:00:00.000Z",
};

function agent(slug: string, name: string, mode: "read" | "write" = "read"): AgentSummary {
  return createMockAgent({ id: slug, slug, name, mode });
}

describe("Agents in pilot mode", () => {
  it("lists the three pilot agents first and every other agent as production only", async () => {
    const installed = [
      agent("stale-guest-cleanup", "Stale guest cleanup", "write"),
      agent("find-inactive-devices", "Find inactive devices"),
      agent("conditional-access-explainer", "Conditional Access explainer"),
      agent("compliance-overview", "Compliance overview"),
    ];
    const registry = [
      ...installed,
      agent("future-agent", "Future agent"),
    ] as unknown as RegistryAgentSummary[];
    const state = createMockAppState({
      tenants: [pilotTenant],
      activeTenantId: pilotTenant.id,
      installedAgents: installed,
      registryAgents: registry,
    });
    renderRoute(<Agents />, { path: "/agents", route: "/agents", bridge: makeMockBridge({}, state) });

    const pilot = await screen.findByLabelText("Available in pilot mode", { selector: "div" });
    expect(
      within(pilot).getAllByRole("button", { name: /^Run / }).map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Run Find inactive devices",
      "Run Conditional Access explainer",
      "Run Stale guest cleanup",
    ]);
    const production = screen.getByLabelText("Available in production", { selector: "div" });
    expect(within(production).getByText("Compliance overview")).toBeInTheDocument();
    expect(within(production).getByText("Future agent")).toBeInTheDocument();
    expect(within(production).queryByText("Find inactive devices")).not.toBeInTheDocument();
    expect(within(production).getAllByText("Connect your tenant to run")).toHaveLength(2);
    expect(within(production).queryByRole("button", { name: /^Run / })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Browse" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New agent" })).not.toBeInTheDocument();
  });

  it("opens setup from a production agent", async () => {
    const user = userEvent.setup();
    const state = createMockAppState({
      tenants: [pilotTenant],
      activeTenantId: pilotTenant.id,
      installedAgents: [agent("compliance-overview", "Compliance overview")],
    });
    renderRoute(<Agents />, { path: "/agents", route: "/agents", bridge: makeMockBridge({}, state) });
    await user.click(await screen.findByRole("button", { name: "Connect your tenant to run Compliance overview" }));
    expect(await screen.findByRole("heading", { name: "Connect a Microsoft 365 tenant" })).toBeInTheDocument();
  });
});
