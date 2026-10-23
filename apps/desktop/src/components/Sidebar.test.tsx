import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { SIDEBAR_COLLAPSED_KEY } from "./Sidebar";
import { AppShell } from "./AppShell";
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
  it("renders the six primary actions in the locked order", () => {
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    const primary = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(primary)
        .getAllByRole("button")
        .map((button) => button.textContent?.trim()),
    ).toEqual(expect.arrayContaining([expect.stringContaining("New chat"), expect.stringContaining("Search")]));
    expect(
      within(primary).getAllByRole("link").map((link) => link.textContent?.trim()),
    ).toEqual(["Agent Team", "Agents", "Runs", "Changes"]);
    expect(screen.getByRole("link", { name: "Agent Team" })).toHaveAttribute("href", "/office");
  });

  it("shows the Runs review badge only when a run awaits confirmation", async () => {
    const empty = renderRoute(<AppShell><div /></AppShell>, {
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

    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge,
    });
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Runs/ })).toHaveTextContent("3");
  });

  it("persists the fully collapsed sidebar and defaults to it below 1000px", async () => {
    const user = userEvent.setup();
    const first = renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });
    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(first.container.querySelector(".app-sidebar")).toHaveAttribute(
      "data-collapsed",
      "true",
    );
    expect(first.container.querySelector(".app-sidebar")).toHaveAttribute("inert");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe("true");
    first.unmount();

    const restored = renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Agent Team" })).not.toBeInTheDocument();
    restored.unmount();

    localStorage.clear();
    window.innerWidth = 900;
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("opens Nova from the Voice footer without a floating launcher", async () => {
    const user = userEvent.setup();
    renderRoute(
      <AppShell><div /></AppShell>,
      {
        path: "*",
        route: "/chat",
        bridge: makeMockBridge(),
      },
    );

    expect(screen.queryByRole("button", { name: /Talk to Nova/ })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /admin@contoso/i }));
    await user.click(screen.getByRole("menuitem", { name: /Voice/ }));
    expect(
      await screen.findByRole("region", { name: "Nova voice assistant" }),
    ).toBeVisible();
  });

  it("opens the shared keyboard shortcut reference from the account menu", async () => {
    const user = userEvent.setup();
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    await user.click(await screen.findByRole("button", { name: /admin@contoso/i }));
    await user.click(screen.getByRole("menuitem", { name: "Keyboard shortcuts" }));

    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(dialog).getByText("Toggle sidebar")).toBeInTheDocument();
    expect(within(dialog).getByText("Ctrl+Shift+S")).toBeInTheDocument();
    expect(within(dialog).getByText("Open Voice")).toBeInTheDocument();
  });
});
