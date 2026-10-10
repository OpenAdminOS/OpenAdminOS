import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Tooltip } from "./Tooltip";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label" | "children"> {
  label: string;
  icon: ReactNode;
  tooltip?: string;
  size?: "sm" | "md";
  tone?: "neutral" | "danger";
}

export function IconButton({
  label,
  icon,
  tooltip = label,
  size = "md",
  tone = "neutral",
  className = "",
  type = "button",
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip content={tooltip}>
      <button
        {...rest}
        type={type}
        aria-label={label}
        className={`inline-flex shrink-0 items-center justify-center rounded-md transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50 ${
          size === "sm" ? "h-7 w-7" : "h-9 w-9"
        } ${
          tone === "danger"
            ? "text-[var(--color-danger)] hover:bg-[var(--color-danger-soft)]"
            : "text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text)]"
        } ${className}`}
      >
        <span aria-hidden="true" className="inline-flex">
          {icon}
        </span>
      </button>
    </Tooltip>
  );
}
