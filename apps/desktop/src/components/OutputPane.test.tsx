import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { OutputDataTable, OutputJsonBlock, type OutputTableColumn } from "./OutputPane";
import { makeMockBridge } from "../test/test-utils";

type Row = {
  name: string;
  count: number;
};

const rows: Row[] = [
  { name: "Fabrikam", count: 8 },
  { name: "Contoso", count: 3 },
];

const columns: OutputTableColumn<Row>[] = [
  {
    id: "name",
    header: "Name",
    render: (row) => row.name,
    sortValue: (row) => row.name,
  },
  {
    id: "count",
    header: "Count",
    align: "right",
    render: (row) => row.count,
    sortValue: (row) => row.count,
  },
];

describe("OutputPane renderers", () => {
  it("sorts data-table rows from keyboard-focusable headers", async () => {
    const user = userEvent.setup();

    render(
      <OutputDataTable
        rows={rows}
        columns={columns}
        getRowId={(row) => row.name}
        initialSort={{ columnId: "name", direction: "ascending" }}
      />,
    );

    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(tableFirstColumn()).toEqual(["Contoso", "Fabrikam"]);

    await user.click(screen.getByRole("button", { name: "Sort by Count ascending" }));

    expect(screen.getByRole("columnheader", { name: /Count/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(tableFirstColumn()).toEqual(["Contoso", "Fabrikam"]);

    await user.click(screen.getByRole("button", { name: "Sort by Count descending" }));

    expect(screen.getByRole("columnheader", { name: /Count/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(tableFirstColumn()).toEqual(["Fabrikam", "Contoso"]);
  });

  it("copies JSON blocks through the renderer clipboard bridge", async () => {
    const user = userEvent.setup();
    const bridge = makeMockBridge();
    window.openAdminOS = bridge;

    render(<OutputJsonBlock value={{ tenant: "Contoso", count: 3 }} />);

    await user.click(screen.getByRole("button", { name: "Copy JSON" }));

    expect(bridge.writeClipboardText).toHaveBeenCalledWith(
      '{\n  "tenant": "Contoso",\n  "count": 3\n}',
    );
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});

function tableFirstColumn(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");
}
