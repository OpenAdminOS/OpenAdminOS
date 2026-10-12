import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Modal, ModalHeader } from "./Modal";
import { Drawer } from "./ui/Drawer";

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

  it("stacks a dialog opened from a drawer above the drawer", async () => {
    const onClose = vi.fn();
    render(
      <Drawer open title="Offboarding agent" onClose={onClose}>
        <Modal open onClose={onClose}>
          <ModalHeader title="Review run" onClose={onClose} />
          <button>Start run</button>
        </Modal>
      </Drawer>,
    );

    const dialog = await screen.findByRole("dialog", { name: "Review run" });
    const drawer = screen.getByRole("dialog", { name: "Offboarding agent" });
    const layer = (element: HTMLElement) => {
      let node: HTMLElement | null = element;
      while (node && node.parentElement !== document.body) node = node.parentElement;
      return node!;
    };
    const zIndex = (element: HTMLElement) =>
      Number(/(?:^|\s)z-\[(\d+)\]/.exec(element.className)?.[1] ?? 0);

    expect(layer(dialog).parentElement).toBe(document.body);
    expect(zIndex(layer(dialog))).toBeGreaterThan(zIndex(layer(drawer)));
  });
});
