import {
  Fragment,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Button } from "./Button";
import { MarkdownPreview } from "./MarkdownPreview";
import { Pill } from "./Pill";
import { IconChevronDown, IconCopy } from "./icons";
import { copyTextToClipboard } from "../shared/clipboard";

const focusRingClass =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]";

type SortDirection = "ascending" | "descending";
type SortableValue = string | number | boolean | Date | null | undefined;

export type OutputTableSort = {
  columnId: string;
  direction: SortDirection;
};

export type OutputTableColumn<Row> = {
  id: string;
  header: string;
  render: (row: Row) => ReactNode;
  sortValue?: (row: Row) => SortableValue;
  sortable?: boolean;
  align?: "left" | "right";
  sticky?: boolean;
  className?: string;
  headerClassName?: string;
  cellClassName?: string | ((row: Row) => string);
  title?: (row: Row) => string | undefined;
  style?: CSSProperties;
};

export function OutputPane({
  title,
  subtitle,
  actions,
  badge,
  children,
  className = "",
  headerClassName = "",
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
  headerClassName?: string;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-xl bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)] ${className}`}
    >
      <div
        className={`flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border-soft)] p-4 ${headerClassName}`}
      >
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2
              id={titleId}
              className="truncate text-[12px] font-semibold text-[var(--color-text)]"
            >
              {title}
            </h2>
            {badge}
          </div>
          {subtitle ? (
            <div className="mt-1 text-[11px] leading-5 text-[var(--color-text-muted)]">
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function OutputPaneSection({
  title,
  subtitle,
  actions,
  badge,
  children,
  collapsible = true,
  defaultCollapsed = false,
  className = "",
  bodyClassName = "p-3",
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  className?: string;
  bodyClassName?: string;
}) {
  const [expanded, setExpanded] = useState(!defaultCollapsed);
  const open = collapsible ? expanded : true;
  const titleId = useId();
  const bodyId = useId();

  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-lg bg-[var(--color-bg)] ring-1 ring-[var(--color-border-soft)] ${className}`}
    >
      <div className="flex items-start justify-between gap-3 px-3 py-2">
        <div className="min-w-0 flex-1">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={bodyId}
              onClick={() => setExpanded((current) => !current)}
              className={`inline-flex max-w-full items-center gap-1.5 rounded-md text-left text-[12px] font-medium text-[var(--color-text)] transition-colors hover:text-[var(--color-accent)] ${focusRingClass}`}
            >
              <IconChevronDown
                size={12}
                aria-hidden="true"
                style={{
                  transform: open ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform 0.15s ease",
                }}
              />
              <span id={titleId} className="truncate">
                {title}
              </span>
              {badge}
            </button>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h3
                id={titleId}
                className="truncate text-[12px] font-medium text-[var(--color-text)]"
              >
                {title}
              </h3>
              {badge}
            </div>
          )}
          {subtitle ? (
            <div className="mt-0.5 text-[10.5px] leading-5 text-[var(--color-text-muted)]">
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      {open ? (
        <div id={bodyId} className={`border-t border-[var(--color-border-soft)] ${bodyClassName}`}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

export function OutputPaneToolbar({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`border-b border-[var(--color-border-soft)] p-3 ${className}`}>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

export function OutputSummaryGrid({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`grid gap-2 sm:grid-cols-2 lg:grid-cols-4 ${className}`}>{children}</div>;
}

export function OutputSummaryTile({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "success" | "danger" | "warning";
}) {
  const toneClass =
    tone === "success"
      ? "text-[var(--color-success)]"
      : tone === "danger"
        ? "text-[var(--color-danger)]"
        : tone === "warning"
          ? "text-[var(--color-warning)]"
          : "text-[var(--color-text)]";
  return (
    <div className="rounded-lg bg-[var(--color-bg)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]">
      <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </div>
      <div className={`mt-1 font-mono text-[18px] font-semibold tabular-nums ${toneClass}`}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

export function OutputFilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="inline-flex h-8 items-center gap-2 rounded-md bg-[var(--color-bg)] px-2 text-[11.5px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`h-6 min-w-[120px] bg-transparent text-[var(--color-text-soft)] outline-none ${focusRingClass}`}
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function OutputDataTable<Row,>({
  rows,
  columns,
  getRowId,
  initialSort,
  sort,
  onSortChange,
  minWidthClassName = "min-w-full",
  tableClassName = "",
  rowClassName,
  emptyMessage = "No rows.",
  renderExpandedRow,
  isRowExpanded,
}: {
  rows: Row[];
  columns: OutputTableColumn<Row>[];
  getRowId: (row: Row, index: number) => string;
  initialSort?: OutputTableSort;
  sort?: OutputTableSort | null;
  onSortChange?: (sort: OutputTableSort) => void;
  minWidthClassName?: string;
  tableClassName?: string;
  rowClassName?: string | ((row: Row) => string);
  emptyMessage?: string;
  renderExpandedRow?: (row: Row) => ReactNode;
  isRowExpanded?: (row: Row) => boolean;
}) {
  const firstSortableColumn = columns.find((column) => isColumnSortable(column));
  const [internalSort, setInternalSort] = useState<OutputTableSort | null>(
    initialSort ??
      (firstSortableColumn
        ? { columnId: firstSortableColumn.id, direction: "ascending" }
        : null),
  );
  const activeSort = sort === undefined ? internalSort : sort;
  const sortedRows = useMemo(() => {
    const activeColumn = activeSort
      ? columns.find((column) => column.id === activeSort.columnId)
      : undefined;
    if (!activeSort || !activeColumn?.sortValue) return rows;

    return rows
      .map((row, index) => ({ row, index }))
      .sort((left, right) => {
        const comparison = compareSortValues(
          activeColumn.sortValue?.(left.row),
          activeColumn.sortValue?.(right.row),
        );
        const directed =
          activeSort.direction === "ascending" ? comparison : comparison * -1;
        return directed || left.index - right.index;
      })
      .map((entry) => entry.row);
  }, [activeSort, columns, rows]);

  const setSort = (nextSort: OutputTableSort) => {
    if (onSortChange) onSortChange(nextSort);
    if (sort === undefined) setInternalSort(nextSort);
  };

  return (
    <div className="overflow-x-auto">
      <table className={`${minWidthClassName} w-full text-left text-[12px] ${tableClassName}`}>
        <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr>
            {columns.map((column) => {
              const sortable = isColumnSortable(column);
              const ariaSort = sortable
                ? activeSort?.columnId === column.id
                  ? activeSort.direction
                  : "none"
                : undefined;
              const nextDirection =
                activeSort?.columnId === column.id && activeSort.direction === "ascending"
                  ? "descending"
                  : "ascending";
              return (
                <th
                  key={column.id}
                  scope="col"
                  aria-sort={ariaSort}
                  className={`${tableCellBaseClass(column)} ${stickyHeaderClass(column)} ${column.headerClassName ?? ""}`}
                  style={column.style}
                >
                  {sortable ? (
                    <button
                      type="button"
                      onClick={() => setSort({ columnId: column.id, direction: nextDirection })}
                      aria-label={`Sort by ${column.header} ${nextDirection}`}
                      className={`inline-flex w-full items-center gap-1 rounded text-left transition-colors hover:text-[var(--color-text)] ${column.align === "right" ? "justify-end" : "justify-start"} ${focusRingClass}`}
                    >
                      <span>{column.header}</span>
                      <IconChevronDown
                        size={10}
                        aria-hidden="true"
                        className={
                          activeSort?.columnId === column.id
                            ? "text-[var(--color-accent)]"
                            : "text-[var(--color-text-muted)] opacity-50"
                        }
                        style={{
                          transform:
                            activeSort?.columnId === column.id &&
                            activeSort.direction === "ascending"
                              ? "rotate(180deg)"
                              : "rotate(0deg)",
                          transition: "transform 0.15s ease",
                        }}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.length === 0 ? (
            <tr className="border-t border-[var(--color-border-soft)]">
              <td
                colSpan={columns.length}
                className="px-3 py-3 text-[12px] text-[var(--color-text-muted)]"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            sortedRows.map((row, index) => {
              const rowId = getRowId(row, index);
              const expanded = isRowExpanded?.(row) ?? false;
              const rowClass =
                typeof rowClassName === "function" ? rowClassName(row) : rowClassName ?? "";
              return (
                <Fragment key={rowId}>
                  <tr className={`border-t border-[var(--color-border-soft)] ${rowClass}`}>
                    {columns.map((column) => (
                      <td
                        key={column.id}
                        title={column.title?.(row)}
                        className={`${tableCellBaseClass(column)} ${stickyCellClass(column)} ${cellClassName(column, row)}`}
                        style={column.style}
                      >
                        {column.render(row)}
                      </td>
                    ))}
                  </tr>
                  {expanded && renderExpandedRow ? (
                    <tr>
                      <td
                        colSpan={columns.length}
                        className="bg-[var(--color-bg)] px-3 py-3"
                      >
                        {renderExpandedRow(row)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

export function OutputKeyValueList({
  items,
  className = "",
}: {
  items: {
    label: string;
    value: ReactNode;
    title?: string;
    mono?: boolean;
  }[];
  className?: string;
}) {
  return (
    <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 ${className}`}>
      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-0 flex-col rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
        >
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {item.label}
          </span>
          <span
            title={item.title}
            className={`mt-0.5 break-words text-[12px] text-[var(--color-text)] ${
              item.mono ? "font-mono" : ""
            }`}
          >
            {item.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function OutputTextBlock({
  source,
  format = "plain",
  className = "",
}: {
  source: string;
  format?: "markdown" | "plain";
  className?: string;
}) {
  if (format === "markdown") {
    return (
      <MarkdownPreview
        source={source}
        className={`text-[13px] leading-relaxed text-[var(--color-text-soft)] ${className}`}
      />
    );
  }
  return (
    <div
      className={`whitespace-pre-wrap rounded-lg bg-[var(--color-bg-raised)] p-4 text-[12.5px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)] ${className}`}
    >
      {source}
    </div>
  );
}

export function OutputJsonBlock({
  value,
  copyLabel = "Copy JSON",
  className = "",
}: {
  value: unknown;
  copyLabel?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const content =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "null";

  const handleCopy = async () => {
    await copyTextToClipboard(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      className={`overflow-hidden rounded-lg bg-[var(--color-bg-raised)] ring-1 ring-[var(--color-border-soft)] ${className}`}
    >
      <div className="flex items-center justify-end border-b border-[var(--color-border-soft)] px-3 py-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label={copyLabel}
          leadingIcon={<IconCopy size={11} />}
          onClick={() => void handleCopy()}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="max-h-[420px] overflow-auto p-4 font-mono text-[11.5px] leading-relaxed text-[var(--color-text-soft)]">
        {content}
      </pre>
    </div>
  );
}

export function OutputStructuredContent({
  value: rawValue,
  compact = false,
}: {
  value: unknown;
  compact?: boolean;
}) {
  const value = rehydrateJsonStrings(rawValue);

  if (value === undefined || value === null) {
    return (
      <div className="text-[12.5px] text-[var(--color-text-muted)]">
        Result not yet available.
      </div>
    );
  }

  if (Array.isArray(value) && value.length > 0 && isRecord(value[0])) {
    return <OutputRecordTable rows={value as Record<string, unknown>[]} compact={compact} />;
  }

  if (Array.isArray(value) && value.length > 0) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((entry, index) => (
          <Pill key={index}>
            <span className="font-mono text-[10.5px]">{formatOutputValue(entry)}</span>
          </Pill>
        ))}
      </div>
    );
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    const bucketEntries = entries.filter(([, child]) => Array.isArray(child)) as [
      string,
      unknown[],
    ][];
    if (bucketEntries.length > 0 && bucketEntries.length === entries.length) {
      return (
        <div className="flex flex-col gap-4">
          {bucketEntries.map(([name, rows]) => (
            <OutputPaneSection
              key={name}
              title={humaniseOutputKey(name)}
              badge={<Pill>{rows.length}</Pill>}
              collapsible={false}
              bodyClassName="p-3"
            >
              {rows.length === 0 ? (
                <div className="rounded-md bg-[var(--color-bg-raised)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
                  No entries.
                </div>
              ) : (
                <OutputStructuredContent value={rows} compact />
              )}
            </OutputPaneSection>
          ))}
        </div>
      );
    }
    return <OutputRecordKeyValues record={value} />;
  }

  if (typeof value === "string") {
    return <OutputTextBlock source={value} />;
  }

  return <OutputTextBlock source={formatOutputValue(value)} />;
}

function OutputRecordTable({
  rows,
  compact,
}: {
  rows: Record<string, unknown>[];
  compact: boolean;
}) {
  const limit = compact ? 8 : 40;
  const columns = pickColumns(rows).map<OutputTableColumn<Record<string, unknown>>>(
    (key) => ({
      id: key,
      header: humaniseOutputKey(key),
      render: (row) => formatOutputValue(row[key]),
      sortValue: (row) => sortableCellValue(row[key]),
      cellClassName: "max-w-[220px] truncate font-mono text-[11px] text-[var(--color-text-soft)]",
      title: (row) => formatOutputValue(row[key]),
    }),
  );

  return (
    <div className="overflow-hidden rounded-lg ring-1 ring-[var(--color-border-soft)]">
      <OutputDataTable
        rows={rows.slice(0, limit)}
        columns={columns}
        getRowId={(_, index) => String(index)}
      />
      {rows.length > limit ? (
        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          Showing first {limit} of {rows.length}. Use "Show raw" for the full payload.
        </div>
      ) : null}
    </div>
  );
}

function OutputRecordKeyValues({ record }: { record: Record<string, unknown> }) {
  return (
    <OutputKeyValueList
      items={Object.entries(record).map(([key, value]) => ({
        label: humaniseOutputKey(key),
        value: formatOutputValue(value),
        title: formatOutputValue(value),
        mono: true,
      }))}
    />
  );
}

function isColumnSortable<Row>(column: OutputTableColumn<Row>): boolean {
  return column.sortable ?? Boolean(column.sortValue);
}

function compareSortValues(left: SortableValue, right: SortableValue): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  const leftValue = left instanceof Date ? left.getTime() : left;
  const rightValue = right instanceof Date ? right.getTime() : right;
  if (typeof leftValue === "number" && typeof rightValue === "number") {
    return leftValue - rightValue;
  }
  if (typeof leftValue === "boolean" && typeof rightValue === "boolean") {
    return Number(leftValue) - Number(rightValue);
  }
  return String(leftValue).localeCompare(String(rightValue), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function tableCellBaseClass<Row>(column: OutputTableColumn<Row>): string {
  return `px-3 py-2 ${column.align === "right" ? "text-right" : "text-left"} ${column.className ?? ""}`;
}

function stickyHeaderClass<Row>(column: OutputTableColumn<Row>): string {
  return column.sticky ? "sticky left-0 z-10 bg-[var(--color-bg)]" : "";
}

function stickyCellClass<Row>(column: OutputTableColumn<Row>): string {
  return column.sticky ? "sticky left-0 z-10 bg-[var(--color-bg-raised)]" : "";
}

function cellClassName<Row>(column: OutputTableColumn<Row>, row: Row): string {
  if (typeof column.cellClassName === "function") return column.cellClassName(row);
  return column.cellClassName ?? "";
}

function pickColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Map<string, number>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
  }
  return [...keys.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([key]) => key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rehydrateJsonStrings(value: unknown, depth = 0): unknown {
  if (depth > 4) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return rehydrateJsonStrings(JSON.parse(trimmed), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rehydrateJsonStrings(entry, depth + 1));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = rehydrateJsonStrings(child, depth + 1);
    }
    return out;
  }
  return value;
}

export function humaniseOutputKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (char) => char.toUpperCase());
}

export function formatOutputValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return JSON.stringify(value);
}

function sortableCellValue(value: unknown): SortableValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof Date ||
    value === null ||
    value === undefined
  ) {
    return value;
  }
  return formatOutputValue(value);
}
