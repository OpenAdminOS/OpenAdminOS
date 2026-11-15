import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EnterpriseStatus } from "@openadminos/agent-sdk";

import { makeMockBridge, renderRoute } from "../test/test-utils";
import { AppShell } from "./AppShell";

describe("team features in the status strip", () => {
  it("shows nothing when the bridge has no team features", async () => {
    renderRoute(<AppShell><div /></AppShell>, { path: "*", route: "/chat", bridge: makeMockBridge() });
    expect(await screen.findByRole("status", { name: /Local · Ollama/ })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /Team/ })).not.toBeInTheDocument();
  });

  it("shows nothing without a valid licence", async () => {
    const getEnterpriseStatus = vi.fn(async (): Promise<EnterpriseStatus> => ({ active: false }));
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({ getEnterpriseStatus }),
    });
    await waitFor(() => expect(getEnterpriseStatus).toHaveBeenCalled());
    expect(await screen.findByRole("status", { name: /Local · Ollama/ })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: /Team/ })).not.toBeInTheDocument();
  });

  it("shows a small problem entry when the licence was refused, with the reason and the fix", async () => {
    const message = "The licence expired and its grace period ended 2027-01-15T00:00:00.000Z. Install a renewed licence, then restart OpenAdminOS.";
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({
        getEnterpriseStatus: async () => ({ active: false, problem: { reason: "licence-expired", message } }),
      }),
    });
    const chip = await screen.findByRole("status", { name: `Team features off · ${message}` });
    expect(chip).toHaveTextContent("Team features off");
    expect(chip).toHaveAttribute("data-reason", "licence-expired");
  });

  it("shows the module's status entry while team features are on and follows changes", async () => {
    let status: EnterpriseStatus = {
      active: true,
      label: "Team service · Frankfurt · end-to-end encrypted",
      detail: "Approval and audit payloads leave this device end-to-end encrypted.",
      settingsSections: [],
    };
    let changed: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const { unmount } = renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({
        getEnterpriseStatus: async () => status,
        onEnterpriseStatusChanged: (listener) => {
          changed = listener;
          return unsubscribe;
        },
      }),
    });
    expect(
      await screen.findByRole("status", {
        name: "Team service · Frankfurt · end-to-end encrypted · Approval and audit payloads leave this device end-to-end encrypted.",
      }),
    ).toBeInTheDocument();

    status = { active: false };
    await act(async () => changed?.());
    await waitFor(() => expect(screen.queryByRole("status", { name: /Team service/ })).not.toBeInTheDocument());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
