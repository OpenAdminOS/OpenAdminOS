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
