import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { EnterpriseStatus } from "@openadminos/agent-sdk";

import Settings from "../pages/Settings";
import { makeMockBridge, renderRoute } from "../test/test-utils";
import { EnterpriseSettingsSections } from "./EnterpriseSettingsSections";

const ACTIVE: EnterpriseStatus = {
  active: true,
  label: "Team features on",
  settingsSections: [
    { id: "team", title: "Team", description: "Approvals and audit shared with your team." },
    { id: "sandboxes", title: "Sandboxes", description: "Machines you run that keep schedules going." },
  ],
};

describe("team features sections in Settings", () => {
  it("renders nothing without team features", async () => {
    const getEnterpriseStatus = vi.fn(async (): Promise<EnterpriseStatus> => ({ active: false }));
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings", bridge: makeMockBridge({ getEnterpriseStatus }) });
    await waitFor(() => expect(getEnterpriseStatus).toHaveBeenCalled());
    expect(await screen.findByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(document.querySelector("[data-enterprise-settings-section]")).toBeNull();
  });

  it("renders each registered section with its title and description in Settings", async () => {
    renderRoute(<Settings />, { path: "/settings/:section?", route: "/settings", bridge: makeMockBridge({ getEnterpriseStatus: async () => ACTIVE }) });
    expect(await screen.findByRole("heading", { name: "Sandboxes" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Team" })).toBeInTheDocument();
    expect(screen.getByText("Machines you run that keep schedules going.")).toBeInTheDocument();
    expect(document.querySelectorAll("[data-enterprise-settings-section]")).toHaveLength(2);
  });

  it("filters by the search and follows status changes", async () => {
    let status: EnterpriseStatus = ACTIVE;
    let changed: (() => void) | undefined;
    renderRoute(<EnterpriseSettingsSections query="schedules" />, {
      path: "*",
      route: "/settings",
      bridge: makeMockBridge({
        getEnterpriseStatus: async () => status,
        onEnterpriseStatusChanged: (listener) => {
          changed = listener;
          return () => undefined;
        },
      }),
    });
    expect(await screen.findByRole("heading", { name: "Sandboxes" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Team" })).toBeNull();
    status = { active: false };
    await act(async () => {
      changed?.();
    });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Sandboxes" })).toBeNull());
  });
});
