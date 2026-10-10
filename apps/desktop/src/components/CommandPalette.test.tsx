import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import {
  createMockAppState,
  makeMockBridge,
  mockTenant,
  renderRoute,
} from "../test/test-utils";

describe("Command Palette", () => {
  it("uses complete combobox semantics and opens catalog-backed Settings results", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderRoute(<CommandPalette open onClose={onClose} />, {
      path: "/",
      route: "/",
      bridge: makeMockBridge(),
    });

    expect(screen.getByRole("dialog", { name: "Command Palette" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    const combobox = screen.getByRole("combobox", {
      name: "Search commands, agents, or pages",
    });
    expect(combobox).toHaveAttribute("aria-controls", "command-palette-results");
    await waitFor(() => expect(combobox).toHaveFocus());

    await user.tab();
    expect(combobox).toHaveFocus();
    await user.tab({ shift: true });
    expect(combobox).toHaveFocus();

    await user.type(combobox, "tenant cache");
    const option = screen.getByRole("option", { name: /Tenant cache/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

it("lists the shell destinations and every Settings section", async () => {
  renderRoute(<CommandPalette open onClose={vi.fn()} />, {
    path: "/",
    route: "/",
    bridge: makeMockBridge(
      {},
      createMockAppState({
        tenants: [
          mockTenant,
          {
            ...mockTenant,
            id: "tenant-2",
            displayName: "Fabrikam",
            homeAccountId: "home-account-2",
          },
        ],
      }),
    ),
  });

  await screen.findByRole("option", { name: /Changes: All tenants/ });

  for (const label of [
    "Go to Chat",
    "Agents",
    "Agents: Hub",
    "Go to Runs",
    "Go to Changes",
    "Open Settings",
    "Team office",
    "Add teammate",
    "Changes: All tenants",
    "Go to Workspaces",
    "Open Voice",
  ]) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(
      screen.getByRole("option", {
        name: label === "Agents" ? /^Agents$/ : new RegExp(`^${escapedLabel}`),
      }),
    ).toBeInTheDocument();
  }

  expect(screen.getByRole("option", { name: /^Device Offboard/ })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: /^Run Device Offboard/ })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Schedules/ })).not.toBeInTheDocument();

  expect(screen.getByRole("option", { name: /^Data/ })).toBeInTheDocument();

  for (const section of [
    "Providers",
    "Tenants",
    "Data",
    "Chat",
    "Connectors",
    "Gateway",
    "General",
    "Appearance",
    "Privacy",
    "About",
  ]) {
    expect(
      screen.getByRole("option", { name: new RegExp(`Settings: ${section}`) }),
    ).toBeInTheDocument();
  }

  expect(screen.queryByRole("option", { name: /Go to Cache/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /Go to Connectors/ })).not.toBeInTheDocument();
});
