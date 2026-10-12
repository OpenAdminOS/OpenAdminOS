import type { ReactNode } from "react";

export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div className={`mx-auto flex max-w-md flex-col items-center px-6 py-12 text-center ${className}`}>
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-bg-raised)] text-[var(--color-text-muted)] ring-1 ring-[var(--color-border)]">
        {icon}
      </div>
      <h2 className="mt-4 text-md font-semibold text-[var(--color-text)]">{title}</h2>
      <p className="mt-1 text-sm text-[var(--color-text-muted)]">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
