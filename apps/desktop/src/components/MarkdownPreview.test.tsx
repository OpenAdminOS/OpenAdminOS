import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MarkdownPreview, plainStepText } from "./MarkdownPreview";

describe("MarkdownPreview tables", () => {
  it("removes cell borders from the final row instead of the final column", () => {
    render(
      <MarkdownPreview
        source={"| Device | State |\n| --- | --- |\n| WIN-01 | Active |\n| WIN-02 | Stale |"}
      />,
    );

    const table = screen.getByRole("table");
    expect(table).toHaveClass("[&_tbody_tr:last-child_td]:border-b-0");
    const rows = screen.getAllByRole("row");
    const firstBodyCells = within(rows[1]!).getAllByRole("cell");
    expect(firstBodyCells[1]).not.toHaveClass("last:border-b-0");
  });
});

describe("MarkdownPreview numbered steps", () => {
  it("adds a keyboard-reachable copy button to each numbered step only when asked", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async () => undefined);
    Object.assign(window, { openAdminOS: { writeClipboardText } });
    try {
      const source = "3. Go to **Endpoint security** [4].\n4. Select `Create Policy`.\n\n- A bullet";
      const { rerender } = render(<MarkdownPreview source={source} />);
      expect(screen.queryByRole("button", { name: /Copy step/ })).toBeNull();
      rerender(<MarkdownPreview source={source} copySteps />);
      expect(screen.getAllByRole("button", { name: /Copy step/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["Copy step 3", "Copy step 4"]);
      await user.tab();
      expect(screen.getByRole("button", { name: "Copy step 3" })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(writeClipboardText).toHaveBeenCalledWith("Go to Endpoint security.");
      expect(plainStepText("Open [Tenant admin](https://intune.microsoft.com) [1][2], then `Connectors` [3]")).toBe("Open Tenant admin, then Connectors");
    } finally {
      Reflect.deleteProperty(window, "openAdminOS");
    }
  });
});
