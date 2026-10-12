import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type DataTableColumn } from "./DataTable";

interface Row {
  id: string;
  name: string;
  count: number;
}

const columns: DataTableColumn<Row>[] = [
  { id: "name", header: "Name", accessor: "name", sortable: true },
  { id: "count", header: "Count", accessor: "count", sortable: true, align: "right" },
];

describe("DataTable", () => {
  it("sorts columns and activates focused rows with Enter", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        caption="Tenant runs"
        columns={columns}
        rows={[
          { id: "2", name: "Zulu", count: 2 },
          { id: "1", name: "Alpha", count: 1 },
        ]}
        rowKey={(row) => row.id}
        onRowClick={onRowClick}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    const dataRows = screen.getAllByRole("row").slice(1);
    expect(within(dataRows[0]!).getByText("Alpha")).toBeInTheDocument();
    dataRows[0]!.focus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "1" }),
    );
  });

  it("renders loading and empty states", () => {
    const { rerender } = render(
      <DataTable
        caption="Tenant runs"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        loading
        loadingRows={2}
      />,
    );
    expect(screen.getByRole("table")).toHaveAttribute("aria-busy", "true");
    expect(screen.getAllByRole("row", { hidden: true })).toHaveLength(3);

    rerender(
      <DataTable
        caption="Tenant runs"
        columns={columns}
        rows={[]}
        rowKey={(row) => row.id}
        emptyTitle="No runs"
        emptyDescription="Runs appear after an agent starts."
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("No runs");
  });
});
