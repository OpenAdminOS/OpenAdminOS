import { createContext, useContext } from "react";

import { SETTINGS_ITEMS, type SettingsItemId } from "../copy";

interface SettingsFilterValue {
  query: string;
  sectionMatch: boolean;
}

/** The Settings search, so each row can hide itself when it does not match. */
export const SettingsFilterContext = createContext<SettingsFilterValue>({
  query: "",
  sectionMatch: false,
});

export function SettingRow({
  id,
  label,
  description,
  control,
  stacked = false,
}: {
  id?: SettingsItemId;
  label?: string;
  description?: string;
  control: React.ReactNode;
  /** Place a wide, multi-field control below the label instead of beside it. */
  stacked?: boolean;
}) {
  const { query, sectionMatch } = useContext(SettingsFilterContext);
  const catalogEntry = id ? SETTINGS_ITEMS[id] : undefined;
  const renderedLabel = catalogEntry?.title ?? label;
  const renderedDescription = description ?? catalogEntry?.description;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchTerms = normalizedQuery.split(/\s+/).filter(Boolean);
  const rowHaystack = [
    renderedLabel,
    renderedDescription,
    ...(catalogEntry?.keywords ?? []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
  const matches =
    !normalizedQuery ||
    sectionMatch ||
    searchTerms.every((term) => rowHaystack.includes(term));
  if (!matches) return null;
  return (
    <div
      id={id ? `setting-${id}` : undefined}
      tabIndex={id ? -1 : undefined}
      className={`setting-row scroll-mt-6 border-b border-[var(--color-border-soft)] last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] ${normalizedQuery ? "bg-[var(--color-accent-soft)]/35" : ""}`}
    >
      <div
        className={`grid items-center gap-4 px-0 py-[var(--row-y)] ${stacked ? "" : "sm:grid-cols-[minmax(220px,1fr)_minmax(0,auto)]"}`}
      >
        <div className="min-w-0">
          <div className="text-[14px] font-medium text-[var(--color-text)]">
            {renderedLabel}
          </div>
          <div className="mt-0.5 text-[13px] leading-5 text-[var(--color-text-muted)]">
            {renderedDescription}
          </div>
        </div>
        <div className={`min-w-0 ${stacked ? "w-full" : "justify-self-start sm:justify-self-end"}`}>{control}</div>
      </div>
    </div>
  );
}
