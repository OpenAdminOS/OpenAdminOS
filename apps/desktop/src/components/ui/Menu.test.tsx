import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "./Menu";

describe("Menu", () => {
  it("supports arrow keys, closes on select and returns focus", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = renderMenu(onSelect);

    const trigger = screen.getByRole("button", { name: "Open actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const first = await screen.findByRole("menuitem", { name: "Rename" });
    await waitFor(() => expect(first).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await waitFor(() => expect(trigger).toHaveFocus());

    rerender(
      <Menu
        trigger={<button>Open actions</button>}
        items={[{ id: "rename", label: "Rename", onSelect: vi.fn() }]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Open actions" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens upward with side=top and focuses without scrolling ancestors", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, "focus");
    render(
      <Menu
        side="top"
        trigger={<button>Open account</button>}
        items={[
          { id: "settings", label: "Settings", onSelect: vi.fn() },
          { id: "tenants", label: "Tenants", onSelect: vi.fn() },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open account" }));

    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("bottom-[calc(100%+6px)]");
    expect(menu.className).not.toContain("top-[calc(100%+6px)]");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Settings" })).toHaveFocus(),
    );
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });

    // Keyboard navigation keeps the default focus scroll so long menus
    // reveal the focused item instead of focusing it off screen.
    focusSpy.mockClear();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Tenants" })).toHaveFocus();
    expect(focusSpy).toHaveBeenCalledWith();
    expect(focusSpy).not.toHaveBeenCalledWith({ preventScroll: true });
    focusSpy.mockRestore();
  });

  it("keeps plain opening focus for default bottom menus", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, "focus");
    render(
      <Menu
        trigger={<button>Open actions</button>}
        items={[{ id: "rename", label: "Rename", onSelect: vi.fn() }]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open actions" }));

    const menu = screen.getByRole("menu");
    expect(menu.className).toContain("top-[calc(100%+6px)]");
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus(),
    );
    expect(focusSpy).not.toHaveBeenCalledWith({ preventScroll: true });
    focusSpy.mockRestore();
  });
});

describe("Menu selectable items", () => {
  it("marks the checked item with aria-checked and moves focus across every item kind", async () => {
    const user = userEvent.setup();
    render(
      <Menu
        trigger={<button>Filter</button>}
        items={[
          { id: "all", label: "All modes", checked: true, radio: true, onSelect: vi.fn() },
          { id: "read", label: "Read mode", checked: false, radio: true, onSelect: vi.fn() },
          { id: "separator", type: "separator" },
          { id: "scheduled", label: "Scheduled only", checked: false, onSelect: vi.fn() },
          { id: "reset", label: "Reset", onSelect: vi.fn() },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Filter" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const all = await screen.findByRole("menuitemradio", { name: "All modes" });
    expect(all).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(all).toHaveFocus());
    expect(screen.getByRole("menuitemradio", { name: "Read mode" })).toHaveAttribute("aria-checked", "false");
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: "Read mode" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemcheckbox", { name: "Scheduled only" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Reset" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Reset" })).not.toHaveAttribute("aria-checked");
  });
});

function renderMenu(onSelect: () => void) {
  return render(
    <Menu
      trigger={<button>Open actions</button>}
      items={[
        { id: "rename", label: "Rename", onSelect: vi.fn() },
        { id: "separator", type: "separator" },
        { id: "delete", label: "Delete", danger: true, onSelect },
      ]}
    />,
  );
}
