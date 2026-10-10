import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "role" | "children" | "onChange"> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
}

export function Switch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className = "",
  type = "button",
  ...rest
}: SwitchProps) {
  return (
    <button
      {...rest}
      type={type}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={`flex w-full items-center justify-between gap-4 rounded-lg py-2 text-left ${className}`}
    >
      <span className="min-w-0">
        <span className="block text-base font-medium text-[var(--color-text)]">
          {label}
        </span>
        {description ? (
          <span className="mt-0.5 block text-sm text-[var(--color-text-muted)]">
            {description}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 rounded-full ring-1 transition-colors ${
          checked
            ? "bg-[var(--color-accent)] ring-[var(--color-accent)]"
            : "bg-[var(--color-bg-raised)] ring-[var(--color-border-strong)]"
        }`}
      >
        <span
          className={`absolute top-0.5 h-4 w-4 rounded-full transition-transform motion-reduce:transition-none ${
            checked
              ? "translate-x-[18px] bg-[var(--color-on-accent)]"
              : "translate-x-0.5 bg-[var(--color-text-muted)]"
          }`}
        />
      </span>
    </button>
  );
}
