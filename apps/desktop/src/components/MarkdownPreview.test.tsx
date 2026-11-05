import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CitationContext, CitationNumberContext, MarkdownPreview } from "./MarkdownPreview";

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
      // Without shown numbers, a citation copies as it reads on screen.
      expect(writeClipboardText).toHaveBeenCalledWith("Go to Endpoint security [4].");
    } finally {
      Reflect.deleteProperty(window, "openAdminOS");
    }
  });

  it("copies a step with its sub-items two levels deep, indented two spaces per level, keeping bullets and numbers", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async () => undefined);
    Object.assign(window, { openAdminOS: { writeClipboardText } });
    try {
      const source = [
        "1. Open **Endpoint security**.",
        "   Sign in as an Intune admin first.",
        "   - Select *Antivirus*",
        "     1. Choose `macOS`",
        "     2. Pick [the profile](https://learn.microsoft.com/x)",
        "   - Select ~~Firewall~~ Attack surface",
        "2. Assign the policy.",
      ].join("\n");
      render(<MarkdownPreview source={source} copySteps />);
      // Nested numbered sub-items are copied with their step and get no button of their own.
      expect(screen.getAllByRole("button", { name: /Copy step/ }).map((button) => button.getAttribute("aria-label"))).toEqual(["Copy step 1", "Copy step 2"]);
      await user.click(screen.getByRole("button", { name: "Copy step 1" }));
      expect(writeClipboardText).toHaveBeenCalledWith([
        "Open Endpoint security.",
        "  Sign in as an Intune admin first.",
        "  - Select Antivirus",
        "    1. Choose macOS",
        "    2. Pick the profile",
        "  - Select Firewall Attack surface",
      ].join("\n"));
      expect(screen.getByRole("button", { name: "Copied step 1" })).toBeInTheDocument();
      expect(screen.getByText("Copied step 1", { selector: "[role=status]" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Copy step 2" }));
      expect(writeClipboardText).toHaveBeenLastCalledWith("Assign the policy.");
    } finally {
      Reflect.deleteProperty(window, "openAdminOS");
    }
  });

  it("copies citation chips as their shown numbers in brackets, in nested sub-items too, and leaves code alone", async () => {
    const user = userEvent.setup();
    const writeClipboardText = vi.fn(async () => undefined);
    Object.assign(window, { openAdminOS: { writeClipboardText } });
    const shown = new Map([[4, 1], [7, 2]]);
    try {
      const source = "1. Grant full disk access [7][4].\n   - Use the `[4]` profile [4]\n   - Unknown [9]";
      render(
        <CitationContext.Provider value={(citation) => (shown.has(citation) ? <button type="button">{shown.get(citation)}</button> : undefined)}>
          <CitationNumberContext.Provider value={(citation) => shown.get(citation)}>
            <MarkdownPreview source={source} copySteps />
          </CitationNumberContext.Provider>
        </CitationContext.Provider>,
      );
      await user.click(screen.getByRole("button", { name: "Copy step 1" }));
      expect(writeClipboardText).toHaveBeenCalledWith("Grant full disk access [2][1].\n  - Use the [4] profile [1]\n  - Unknown [9]");
    } finally {
      Reflect.deleteProperty(window, "openAdminOS");
    }
  });
});
