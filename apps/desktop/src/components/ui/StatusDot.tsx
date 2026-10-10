import type { HTMLAttributes } from "react";

export type StatusDotTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "think";

export interface StatusDotProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
  label?: string;
  size?: "sm" | "md";
}

const tones: Record<StatusDotTone, string> = {
  neutral: "bg-[var(--color-text-faint)]",
  success: "bg-[var(--color-success)]",
  warning: "bg-[var(--color-warning)]",
  danger: "bg-[var(--color-danger)]",
  info: "bg-[var(--color-info)]",
  think: "bg-[var(--color-think)]",
};

export function StatusDot({
  tone = "success",
  label,
  size = "sm",
  className = "",
  ...rest
}: StatusDotProps) {
  return (
    <span
      {...rest}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`inline-block shrink-0 rounded-full ${
        size === "sm" ? "h-1.5 w-1.5" : "h-2 w-2"
      } ${tones[tone]} ${className}`}
    />
  );
}
