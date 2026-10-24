import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("opens the tenant account menu upward from the sidebar footer", async () => {
    const user = userEvent.setup();
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge(),
    });

    await user.click(await screen.findByRole("button", { name: /admin@contoso/i }));

    const menu = screen.getByRole("menu", { name: "Account and application" });
    expect(menu.className).toContain("bottom-[calc(100%+6px)]");
    expect(menu.className).not.toContain("top-[calc(100%+6px)]");
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

  it.each([
    {
      action: "Pin",
      failure: "Pin IPC failed.",
      expected: /Pinning the conversation failed.*Try again from the conversation menu/,
      overrides: { setIntuneChatConversationPinned: vi.fn(async () => { throw new Error("Pin IPC failed."); }) },
    },
    {
      action: "Export",
      failure: "Export IPC failed.",
      expected: /Exporting the conversation failed.*Try again from the conversation menu/,
      overrides: { getIntuneChatMessages: vi.fn(async () => { throw new Error("Export IPC failed."); }) },
    },
    {
      action: "Move to workspace",
      failure: "Workspace IPC failed.",
      expected: /Moving the conversation failed.*Try again from the conversation menu/,
      overrides: { createWorkspace: vi.fn(async () => { throw new Error("Workspace IPC failed."); }) },
    },
  ])("surfaces $action failures with recovery", async ({ action, failure, expected, overrides }) => {
    const user = userEvent.setup();
    const bridge = makeMockBridge({
      listIntuneChatConversations: vi.fn(async () => [sidebarConversation]),
      ...overrides,
    });
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/runs",
      bridge,
    });

    await user.click(
      await screen.findByRole("button", {
        name: `More actions for ${sidebarConversation.title}`,
      }),
    );
    await user.click(screen.getByRole("menuitem", { name: action }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(failure);
    expect(alert).toHaveTextContent(expected);
  });

  it("keeps menu and search keyboard navigation inside their controls", async () => {
    const user = userEvent.setup();
    renderRoute(<AppShell><div /></AppShell>, {
      path: "*",
      route: "/chat",
      bridge: makeMockBridge({
        listIntuneChatConversations: vi.fn(async () => [sidebarConversation]),
      }),
    });

    const search = await screen.findByRole("searchbox", { name: "Search workspaces" });
    search.focus();
    await user.keyboard("{ArrowDown}{Home}{End}");
    expect(search).toHaveFocus();

    const more = screen.getByRole("button", {
      name: `More actions for ${sidebarConversation.title}`,
    });
    more.focus();
    await user.keyboard("{ArrowDown}");
    const pin = await screen.findByRole("menuitem", { name: "Pin" });
    await waitFor(() => expect(pin).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  });
});

const sidebarConversation = {
  id: "conversation-sidebar",
  title: "Sidebar investigation",
  createdAt: "2026-10-10T08:00:00.000Z",
  updatedAt: "2026-10-10T09:00:00.000Z",
  tenantId: "tenant-1",
  scopeKind: "single-tenant" as const,
};
