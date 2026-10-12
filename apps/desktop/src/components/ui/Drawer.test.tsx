import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Drawer } from "./Drawer";

describe("Drawer", () => {
  it("traps focus, closes on Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button>Open details</button>
        <Drawer open={false} title="Run details" onClose={onClose}>
          <button>First action</button>
          <button>Last action</button>
        </Drawer>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Open details" });
    trigger.focus();

    rerender(
      <>
        <button>Open details</button>
        <Drawer open title="Run details" onClose={onClose}>
          <button>First action</button>
          <button>Last action</button>
        </Drawer>
      </>,
    );

    expect(screen.getByRole("dialog", { name: "Run details" })).toHaveAttribute(
      "aria-modal",
      "true",
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close drawer" })).toHaveFocus(),
    );
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(screen.getByRole("button", { name: "Last action" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <>
        <button>Open details</button>
        <Drawer open={false} title="Run details" onClose={onClose}>
          <button>First action</button>
        </Drawer>
      </>,
    );
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
