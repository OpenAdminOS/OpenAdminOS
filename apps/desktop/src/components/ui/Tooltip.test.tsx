import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Tooltip } from "./Tooltip";

afterEach(() => {
  vi.useRealTimers();
});

describe("Tooltip", () => {
  it("renders outside the trigger so clipping ancestors cannot cut it off", () => {
    render(
      <div style={{ overflow: "hidden" }} data-testid="clip">
        <Tooltip content="3 findings to review" side="right">
          <button type="button">Agent Team</button>
        </Tooltip>
      </div>,
    );
    const tip = screen.getByRole("tooltip", { hidden: true });
    expect(screen.getByTestId("clip")).not.toContainElement(tip);
    expect(tip.parentElement).toBe(document.body);
    expect(screen.getByRole("button", { name: "Agent Team" })).toHaveAttribute(
      "aria-describedby",
      tip.id,
    );
  });

  it("shows after the hover delay and hides when the pointer leaves", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Collapse sidebar" side="right">
        <button type="button">Collapse</button>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "Collapse" });
    const tip = screen.getByRole("tooltip", { hidden: true });

    fireEvent.mouseEnter(trigger.parentElement!);
    expect(tip).toHaveClass("invisible");
    act(() => {
      vi.advanceTimersByTime(450);
    });
    expect(tip).toHaveClass("visible");

    fireEvent.mouseLeave(trigger.parentElement!);
    expect(tip).toHaveClass("invisible");
  });

  it("stretches the trigger wrapper when fullWidth is set", () => {
    render(
      <Tooltip content="Tip" fullWidth>
        <a href="#team">Agent Team</a>
      </Tooltip>,
    );
    const wrapper = screen.getByRole("link", { name: "Agent Team" }).parentElement!;
    expect(wrapper).toHaveClass("flex", "w-full");
    expect(wrapper).not.toHaveClass("inline-flex");
  });
});
