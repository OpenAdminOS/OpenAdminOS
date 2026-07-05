import { useState } from "react";
import { OutputJsonBlock, OutputPane, OutputStructuredContent } from "./OutputPane";
import { IconChevronDown, IconShield } from "./icons";
import type { RunRecord } from "../shared/openAdminOS";

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
    <OutputPane
      title="Result"
      className="mb-6"
      actions={
        result !== undefined && result !== null ? (
          <button
            type="button"
            onClick={() => setRawOpen((open) => !open)}
            aria-expanded={rawOpen}
            className="inline-flex items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-[var(--color-text-soft)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent)]"
          >
            <IconChevronDown
              size={11}
              aria-hidden="true"
              style={{
                transform: rawOpen ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 0.15s ease",
              }}
            />
            {rawOpen ? "Hide raw" : "Show raw"}
          </button>
        ) : undefined
      }
    >
      <div className="p-6">
        {emptyContextMessage && (
          <div className="flex items-start gap-2.5 rounded-lg bg-[var(--color-info-soft)] px-3 py-2.5 ring-1 ring-[var(--color-info)]/25">
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
          <OutputStructuredContent value={result} />
        )}

        {rawOpen && result !== undefined && result !== null && (
          <OutputJsonBlock value={result} className="mt-4" />
        )}
      </div>
    </OutputPane>
  );
}

function describeEmpty(run: RunRecord): string | undefined {
  if (!isEmptyResult(run)) return undefined;
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
