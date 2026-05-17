import { useState } from "react";
import { Card } from "./Card";
import { Pill } from "./Pill";
import { IconChevronDown, IconShield } from "./icons";
import type { RunRecord } from "../shared/openAgents";

/**
 * Renders the `run.result` payload as something more useful than raw
 * JSON when we can detect a shape, and falls back to a JSON `<pre>`
 * otherwise. Empty results get an info callout regardless of status.
 */
export function ResultPanel({ run }: { run: RunRecord }) {
  const [rawOpen, setRawOpen] = useState(false);
  const result = run.result;
  const emptyContextMessage = describeEmpty(run);

  return (
    <Card className="mb-6">
      <div className="p-6">
        <div className="flex items-center justify-between">
          <SectionLabel>Result</SectionLabel>
          {result !== undefined && result !== null && (
            <button
              onClick={() => setRawOpen((open) => !open)}
              className="inline-flex items-center gap-1 text-[11.5px] font-medium text-[var(--color-text-soft)] hover:text-[var(--color-text)]"
            >
              <IconChevronDown
                size={11}
                style={{
                  transform: rawOpen ? "rotate(0deg)" : "rotate(-90deg)",
                  transition: "transform 0.15s ease",
                }}
              />
              {rawOpen ? "Hide raw" : "Show raw"}
            </button>
          )}
        </div>

        {emptyContextMessage && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-[var(--color-info-soft)] px-3 py-2.5 ring-1 ring-[var(--color-info)]/25">
            <IconShield
              size={13}
              className="mt-0.5 shrink-0 text-[var(--color-info)]"
            />
            <div className="text-[12px] leading-relaxed text-[var(--color-text-soft)]">
              {emptyContextMessage}
            </div>
          </div>
        )}

        {!emptyContextMessage && (
          <div className="mt-4">
            <StructuredResult value={result} />
          </div>
        )}

        {rawOpen && result !== undefined && result !== null && (
          <pre className="mt-4 max-h-[420px] overflow-auto rounded-lg bg-[var(--color-bg-raised)] p-4 font-mono text-[11.5px] leading-relaxed text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
      </div>
    </Card>
  );
}

function describeEmpty(run: RunRecord): string | undefined {
  if (!isEmptyResult(run)) return undefined;
  if (run.dataSource === "synthetic") {
    return "No records processed. Synthetic mode runs against an empty inventory — connect a Microsoft 365 tenant from Settings to see actual data.";
  }
  if (run.status === "failed") {
    return "Run failed before producing a result. See the Logs tab for details.";
  }
  return "Run completed with no records matched. The agent's filters did not select anything from the current tenant inventory.";
}

export function isEmptyResult(run: RunRecord): boolean {
  const result = run.result;
  if (result === undefined || result === null) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (typeof result !== "object") return false;
  const record = result as Record<string, unknown>;
  if (Object.keys(record).length === 0) return true;
  for (const key of ["count", "total", "size"]) {
    const value = record[key];
    if (typeof value === "number" && value === 0) return true;
  }
  // If every value in the record is an empty array, treat as empty.
  const values = Object.values(record);
  if (values.length > 0 && values.every((v) => Array.isArray(v) && v.length === 0)) {
    return true;
  }
  return false;
}

// ─── Structured renderers ────────────────────────────────────────────────

function StructuredResult({ value: rawValue }: { value: unknown }) {
  // Agent template result blocks render Liquid expressions into the
  // result.data shape. When a value embeds {{ obj }} where obj is an
  // object/array, the template engine JSON.stringifies it into a
  // string. Re-hydrate those strings before deciding how to render.
  const value = rehydrateJsonStrings(rawValue);

  if (value === undefined || value === null) {
    return (
      <div className="text-[12.5px] text-[var(--color-text-muted)]">
        Result not yet available.
      </div>
    );
  }

  // Array of objects -> table
  if (Array.isArray(value) && value.length > 0 && isRecord(value[0])) {
    return <RecordTable rows={value as Record<string, unknown>[]} />;
  }

  // Array of primitives -> pill list
  if (Array.isArray(value) && value.length > 0) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((entry, idx) => (
          <Pill key={idx}>
            <span className="font-mono text-[10.5px]">{String(entry)}</span>
          </Pill>
        ))}
      </div>
    );
  }

  // Object whose values are all arrays -> bucketed sections (e.g. {active:[], warn:[], stale:[], retire:[]})
  if (isRecord(value)) {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record);
    const bucketEntries = entries.filter(
      ([, val]) => Array.isArray(val),
    ) as [string, unknown[]][];
    if (bucketEntries.length > 0 && bucketEntries.length === entries.length) {
      return <BucketView buckets={bucketEntries} />;
    }
    return <KeyValueView record={record} />;
  }

  return (
    <pre className="overflow-auto rounded-lg bg-[var(--color-bg-raised)] p-4 font-mono text-[11.5px] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border-soft)]">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function BucketView({ buckets }: { buckets: [string, unknown[]][] }) {
  return (
    <div className="flex flex-col gap-4">
      {buckets.map(([name, rows]) => (
        <div key={name}>
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[12px] font-medium capitalize text-[var(--color-text)]">
              {humaniseKey(name)}
            </span>
            <Pill>{rows.length}</Pill>
          </div>
          {rows.length === 0 ? (
            <div className="rounded-md bg-[var(--color-bg-raised)] px-3 py-2 text-[11.5px] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-soft)]">
              No entries.
            </div>
          ) : isRecord(rows[0]) ? (
            <RecordTable rows={rows as Record<string, unknown>[]} compact />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {rows.map((entry, idx) => (
                <Pill key={idx}>
                  <span className="font-mono text-[10.5px]">{String(entry)}</span>
                </Pill>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function RecordTable({
  rows,
  compact = false,
}: {
  rows: Record<string, unknown>[];
  compact?: boolean;
}) {
  const columns = pickColumns(rows);
  return (
    <div className="overflow-auto rounded-lg ring-1 ring-[var(--color-border-soft)]">
      <table className="min-w-full divide-y divide-[var(--color-border-soft)] text-left text-[12px]">
        <thead className="bg-[var(--color-bg-raised)]">
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                className="px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]"
              >
                {humaniseKey(col)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)] bg-[var(--color-surface)]">
          {rows.slice(0, compact ? 8 : 40).map((row, rowIdx) => (
            <tr key={rowIdx} className="hover:bg-[var(--color-surface-hover)]">
              {columns.map((col) => (
                <td
                  key={col}
                  className="truncate px-3 py-1.5 font-mono text-[11px] text-[var(--color-text-soft)]"
                  style={{ maxWidth: 220 }}
                  title={formatCell(row[col])}
                >
                  {formatCell(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > (compact ? 8 : 40) && (
        <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-bg-raised)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
          Showing first {compact ? 8 : 40} of {rows.length}. Use "Show raw" for the full payload.
        </div>
      )}
    </div>
  );
}

function KeyValueView({ record }: { record: Record<string, unknown> }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {Object.entries(record).map(([key, value]) => (
        <div
          key={key}
          className="flex flex-col rounded-md bg-[var(--color-bg-raised)] px-3 py-2 ring-1 ring-[var(--color-border-soft)]"
        >
          <span className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {humaniseKey(key)}
          </span>
          <span className="mt-0.5 break-words font-mono text-[12px] text-[var(--color-text)]">
            {formatCell(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function pickColumns(rows: Record<string, unknown>[]): string[] {
  const keys = new Map<string, number>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      keys.set(key, (keys.get(key) ?? 0) + 1);
    }
  }
  // Take the most-frequent keys, max 6 cols.
  return [...keys.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([key]) => key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Walk `value` and re-parse any strings that look like serialised JSON
 * (start with `{` or `[`, end with the matching brace, parse cleanly).
 * The agent template's Liquid renderer turns `{{ obj }}` interpolations
 * into JSON strings; this rehydrates them so the structured renderers
 * can show tables / key-value views instead of opaque text.
 */
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

function humaniseKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  return JSON.stringify(value);
}

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}
