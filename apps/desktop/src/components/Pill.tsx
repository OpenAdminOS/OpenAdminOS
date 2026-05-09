import type { ReactNode } from "react";

type Tone = "default" | "accent" | "success" | "warning" | "danger" | "info" | "think";

const toneStyles: Record<Tone, string> = {
  default: "bg-[var(--color-surface)] text-[var(--color-text-soft)] ring-1 ring-[var(--color-border)]",
  accent: "bg-[var(--color-accent-soft)] text-[var(--color-accent)] ring-1 ring-[var(--color-accent)]/25",
  success: "bg-[var(--color-success-soft)] text-[var(--color-success)] ring-1 ring-[var(--color-success)]/25",
  warning: "bg-[var(--color-warning-soft)] text-[var(--color-warning)] ring-1 ring-[var(--color-warning)]/25",
  danger: "bg-[var(--color-danger-soft)] text-[var(--color-danger)] ring-1 ring-[var(--color-danger)]/25",
  info: "bg-[var(--color-info-soft)] text-[var(--color-info)] ring-1 ring-[var(--color-info)]/25",
  think: "bg-[var(--color-think-soft)] text-[var(--color-think)] ring-1 ring-[var(--color-think)]/25",
};

export function Pill({
  children,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium leading-tight ${toneStyles[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusDot({
  tone = "success",
  className = "",
}: {
  tone?: "success" | "warning" | "danger" | "info" | "muted";
  className?: string;
}) {
  const colorMap = {
    success: "bg-[var(--color-success)]",
    warning: "bg-[var(--color-warning)]",
    danger: "bg-[var(--color-danger)]",
    info: "bg-[var(--color-info)]",
    muted: "bg-[var(--color-text-faint)]",
  } as const;
  return <span className={`inline-block h-1.5 w-1.5 rounded-full ${colorMap[tone]} ${className}`} />;
}
