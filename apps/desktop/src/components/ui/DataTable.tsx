import {
  useMemo,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Skeleton } from "./Skeleton";

export type SortDirection = "ascending" | "descending";

export interface DataTableColumn<Row> {
  id: string;
  header: string;
  accessor?: keyof Row;
  render?: (row: Row) => ReactNode;
  sortValue?: (row: Row) => string | number | Date | null | undefined;
  sortable?: boolean;
  align?: "left" | "right";
  width?: string;
}

export interface DataTableProps<Row> {
  columns: readonly DataTableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  caption: string;
  onRowClick?: (row: Row) => void;
  loading?: boolean;
  loadingRows?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  initialSort?: { columnId: string; direction?: SortDirection };
  className?: string;
}

function compareValues(
  left: string | number | Date | null | undefined,
  right: string | number | Date | null | undefined,
) {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  const a = left instanceof Date ? left.getTime() : left;
  const b = right instanceof Date ? right.getTime() : right;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  caption,
  onRowClick,
  loading = false,
  loadingRows = 5,
  emptyTitle = "No data",
  emptyDescription,
  initialSort,
  className = "",
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<{
    columnId: string;
    direction: SortDirection;
  } | null>(
    initialSort
      ? {
          columnId: initialSort.columnId,
          direction: initialSort.direction ?? "ascending",
        }
      : null,
  );

  const sortedRows = useMemo(() => {
    if (!sort) return [...rows];
    const column = columns.find((candidate) => candidate.id === sort.columnId);
    if (!column) return [...rows];
    const value = (row: Row) =>
      column.sortValue?.(row) ??
      (column.accessor ? (row[column.accessor] as string | number | Date | null | undefined) : undefined);
    return [...rows].sort((left, right) => {
      const result = compareValues(value(left), value(right));
      return sort.direction === "ascending" ? result : -result;
    });
  }, [columns, rows, sort]);

  const activateRow = (event: KeyboardEvent<HTMLTableRowElement>, row: Row) => {
    if (event.key !== "Enter" || !onRowClick) return;
    event.preventDefault();
    onRowClick(row);
  };

  return (
    <div
      className={`min-w-0 overflow-auto rounded-[10px] bg-[var(--color-surface)] ring-1 ring-[var(--color-border)] ${className}`}
    >
      <table
        aria-busy={loading}
        className="w-full border-collapse text-left text-base"
      >
        <caption className="sr-only">{caption}</caption>
        <thead className="sticky top-0 z-10 bg-[var(--color-bg-elevated)]">
          <tr className="border-b border-[var(--color-border)]">
            {columns.map((column) => {
              const activeSort = sort?.columnId === column.id ? sort.direction : undefined;
              const style: CSSProperties | undefined = column.width
                ? { width: column.width }
                : undefined;
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={column.sortable ? (activeSort ?? "none") : undefined}
                  style={style}
                  className={`whitespace-nowrap px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] ${
                    column.align === "right" ? "text-right" : "text-left"
                  }`}
                >
                  {column.sortable ? (
                    <button
                      type="button"
                      className={`inline-flex items-center gap-1 rounded-sm hover:text-[var(--color-text)] ${
                        column.align === "right" ? "ml-auto" : ""
                      }`}
                      onClick={() =>
                        setSort((current) => ({
                          columnId: column.id,
                          direction:
                            current?.columnId === column.id &&
                            current.direction === "ascending"
                              ? "descending"
                              : "ascending",
                        }))
                      }
                    >
                      {column.header}
                      <span aria-hidden="true" className="text-xs">
                        {activeSort === "ascending"
                          ? "↑"
                          : activeSort === "descending"
                            ? "↓"
                            : "↕"}
                      </span>
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {loading
            ? Array.from({ length: loadingRows }, (_, rowIndex) => (
                <tr key={`loading-${rowIndex}`} aria-hidden="true">
                  {columns.map((column, columnIndex) => (
                    <td key={column.id} className="px-3 py-2.5">
                      <Skeleton
                        className={columnIndex === 0 ? "w-3/4" : "w-1/2"}
                      />
                    </td>
                  ))}
                </tr>
              ))
            : sortedRows.map((row) => (
                <tr
                  key={rowKey(row)}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={(event) => activateRow(event, row)}
                  className={`transition-colors hover:bg-[var(--color-surface-hover)] focus-visible:bg-[var(--color-surface-hover)] ${
                    onRowClick ? "cursor-pointer" : ""
                  }`}
                >
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={`px-3 py-2.5 text-[var(--color-text-soft)] ${
                        column.align === "right" ? "text-right" : "text-left"
                      }`}
                    >
                      {column.render
                        ? column.render(row)
                        : column.accessor
                          ? String(row[column.accessor] ?? "")
                          : null}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
      {!loading && sortedRows.length === 0 && (
        <div role="status" className="px-6 py-10 text-center">
          <div className="text-base font-medium text-[var(--color-text)]">
            {emptyTitle}
          </div>
          {emptyDescription ? (
            <p className="mx-auto mt-1 max-w-md text-sm text-[var(--color-text-muted)]">
              {emptyDescription}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
