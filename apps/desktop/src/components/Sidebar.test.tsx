import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { Nova } from "../voice/Nova";
import { Sidebar, SIDEBAR_COLLAPSED_KEY } from "./Sidebar";
import {
  createAwaitingConfirmationRun,
  createMockAppState,
  makeMockBridge,
  renderRoute,
} from "../test/test-utils";

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1200,
  });
});

describe("Sidebar", () => {
  it("renders exactly five primary destinations in the locked order", () => {
    renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(primary)
        .getAllByRole("link")
        .map((link) => link.textContent?.trim()),
    ).toEqual(["Chat", "Agents", "Runs", "Changes", "Settings"]);
    expect(screen.queryByRole("navigation", { name: "More" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Agent Team/ })).not.toBeInTheDocument();
  });

  it("shows the Runs review badge only when a run awaits confirmation", async () => {
    const empty = renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });
    expect(screen.getByRole("link", { name: "Runs" })).not.toHaveTextContent(/\d/);
    empty.unmount();

    const runs = [
      createAwaitingConfirmationRun({ id: "run-standard" }),
      createAwaitingConfirmationRun({
        id: "run-team",
        office: { missionId: "mission-1", personaId: "persona-1", step: 1 },
      }),
      createAwaitingConfirmationRun({
        id: "run-external",
        origin: "external-proposal",
        external: {
          clientName: "Gateway client",
          requiredScopes: ["Policy.ReadWrite.ConditionalAccess"],
        },
      }),
    ];
    const bridge = makeMockBridge(
      {},
      createMockAppState({ runs }),
    );

    renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge,
    });
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Runs/ })).toHaveTextContent("3");
  });

  it("persists the collapsed rail and defaults to it below 1000px", async () => {
    const user = userEvent.setup();
    const first = renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(screen.getByRole("complementary", { name: "Application navigation" })).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("true");
    first.unmount();

    const restored = renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    restored.unmount();

    localStorage.clear();
    window.innerWidth = 900;
    renderRoute(<Sidebar />, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("opens Nova from the Voice footer without a floating launcher", async () => {
    const user = userEvent.setup();
    renderRoute(
      <>
        <Sidebar />
        <Nova />
      </>,
      {
        path: "*",
        route: "/chat",
        bridge: makeMockBridge(),
      },
    );

    expect(screen.queryByRole("button", { name: /Talk to Nova/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Voice" }));
    expect(
      await screen.findByRole("region", { name: "Nova voice assistant" }),
    ).toBeVisible();
  });
});
