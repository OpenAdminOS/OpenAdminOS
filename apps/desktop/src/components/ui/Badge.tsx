import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone =
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "think";

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

const tones: Record<BadgeTone, string> = {
  neutral:
    "bg-[var(--color-hover)] text-[var(--color-text-soft)]",
  success:
    "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  warning:
    "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  danger:
    "bg-[var(--color-danger-soft)] text-[var(--color-danger)]",
  info:
    "bg-[var(--color-info-soft)] text-[var(--color-info)]",
  think:
    "bg-[var(--color-think-soft)] text-[var(--color-think)]",
};

export function Badge({
  tone = "neutral",
  className = "",
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      {...rest}
      className={`inline-flex h-[22px] items-center gap-1 rounded-[6px] px-2 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
