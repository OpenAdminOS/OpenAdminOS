import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal, ModalHeader } from "./Modal";

describe("Modal accessibility", () => {
  it("labels the dialog, traps focus, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button>Open dialog</button>
        <Modal open={false} onClose={onClose}>
          <ModalHeader title="Review change" onClose={onClose} />
          <input aria-label="Confirmation phrase" />
          <button>Apply</button>
        </Modal>
      </>,
    );
    const trigger = screen.getByRole("button", { name: "Open dialog" });
    trigger.focus();
    rerender(
      <>
        <button>Open dialog</button>
        <Modal open onClose={onClose}>
          <ModalHeader title="Review change" onClose={onClose} />
          <input aria-label="Confirmation phrase" />
          <button>Apply</button>
        </Modal>
      </>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Review change" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <>
        <button>Open dialog</button>
        <Modal open={false} onClose={onClose}>
          <ModalHeader title="Review change" onClose={onClose} />
        </Modal>
      </>,
    );
    expect(screen.getByRole("button", { name: "Open dialog" })).toHaveFocus();
  });

  it("closes only the topmost dialog on Escape", async () => {
    const user = userEvent.setup();
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    render(
      <>
        <Modal open onClose={closeFirst} ariaLabel="First dialog">
          <button>First action</button>
        </Modal>
        <Modal open onClose={closeSecond} ariaLabel="Second dialog">
          <button>Second action</button>
        </Modal>
      </>,
    );

    await user.keyboard("{Escape}");
    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(closeFirst).not.toHaveBeenCalled();
  });
});
