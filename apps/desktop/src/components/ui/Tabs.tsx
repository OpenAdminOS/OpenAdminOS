import { useRef, type KeyboardEvent } from "react";

export interface TabItem {
  id: string;
  label: string;
  disabled?: boolean;
  panelId?: string;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}

export function Tabs({
  tabs,
  value,
  onValueChange,
  ariaLabel,
  className = "",
}: TabsProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const enabled = tabs.filter((tab) => !tab.disabled);

  const selectAdjacent = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const current = enabled.findIndex((tab) => tab.id === value);
    const next =
      event.key === "Home"
        ? enabled[0]
        : event.key === "End"
          ? enabled.at(-1)
          : event.key === "ArrowRight"
            ? enabled[(current + 1 + enabled.length) % enabled.length]
            : enabled[(current - 1 + enabled.length) % enabled.length];
    if (!next) return;
    onValueChange(next.id);
    Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-tab-id]") ?? [],
    )
      .find((button) => button.dataset.tabId === next.id)
      ?.focus();
  };

  return (
    <div
      ref={rootRef}
      role="tablist"
      aria-label={ariaLabel}
      className={`flex items-end gap-5 border-b border-[var(--color-border-soft)] ${className}`}
    >
      {tabs.map((tab) => {
        const selected = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            data-tab-id={tab.id}
            aria-selected={selected}
            aria-controls={tab.panelId}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            onClick={() => onValueChange(tab.id)}
            onKeyDown={selectAdjacent}
            className={`relative -mb-px min-h-9 border-b-2 px-0.5 pb-2 pt-1 text-sm font-medium transition-colors ${
              selected
                ? "border-[var(--color-accent)] text-[var(--color-text)]"
                : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
