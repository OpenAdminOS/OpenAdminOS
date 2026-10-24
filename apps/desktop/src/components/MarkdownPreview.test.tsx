import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MarkdownPreview } from "./MarkdownPreview";

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
