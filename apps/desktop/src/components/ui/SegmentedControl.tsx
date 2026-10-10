import { useRef, type KeyboardEvent } from "react";

export interface SegmentedControlOption {
  id: string;
  label: string;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  options: readonly SegmentedControlOption[];
  value: string;
  onValueChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}

export function SegmentedControl({
  options,
  value,
  onValueChange,
  ariaLabel,
  className = "",
}: SegmentedControlProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const enabled = options.filter((option) => !option.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const current = enabled.findIndex((option) => option.id === value);
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const next =
      event.key === "Home"
        ? enabled[0]
        : event.key === "End"
          ? enabled.at(-1)
          : enabled[
              (current + (forward ? 1 : -1) + enabled.length) % enabled.length
            ];
    if (!next) return;
    onValueChange(next.id);
    Array.from(
      rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-segment-id]") ?? [],
    )
      .find((button) => button.dataset.segmentId === next.id)
      ?.focus();
  };

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label={ariaLabel}
      className={`inline-flex items-center rounded-lg bg-[var(--color-surface)] p-0.5 ring-1 ring-[var(--color-border)] ${className}`}
    >
      {options.map((option) => {
        const checked = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            data-segment-id={option.id}
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            onClick={() => onValueChange(option.id)}
            onKeyDown={onKeyDown}
            className={`h-7 rounded-md px-2.5 text-xs font-medium transition-colors ${
              checked
                ? "bg-[var(--color-bg-raised)] text-[var(--color-text)] shadow-sm"
                : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
