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
    "bg-[var(--color-surface)] text-[var(--color-text-soft)] ring-[var(--color-border)]",
  success:
    "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-[var(--color-success)]/25",
  warning:
    "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-[var(--color-warning)]/25",
  danger:
    "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-[var(--color-danger)]/25",
  info:
    "bg-[var(--color-info-soft)] text-[var(--color-info)] ring-[var(--color-info)]/25",
  think:
    "bg-[var(--color-think-soft)] text-[var(--color-think)] ring-[var(--color-think)]/25",
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
      className={`inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-xs font-medium ring-1 ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
